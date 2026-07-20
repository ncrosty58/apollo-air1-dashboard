import os
import time
from datetime import datetime, timedelta, timezone

import requests

import airnow

CURRENT_URL = "https://airquality.googleapis.com/v1/currentConditions:lookup"
FORECAST_URL = "https://airquality.googleapis.com/v1/forecast:lookup"
HISTORY_URL = "https://airquality.googleapis.com/v1/history:lookup"

CACHE_TTL_S = 55 * 60  # matches airnow.py's cadence
FORECAST_CACHE_TTL_S = 3 * 60 * 60
HISTORY_CACHE_TTL_S = 30 * 60
# Google's forecast supports up to 96h out, but rejects a period request
# starting at the exact current instant ("next hour onwards" only) and one
# landing right on the 96h edge ("time period not supported"). Starting at
# the next hour boundary and spanning 71h (72 hourly points, ~3 days) stays
# safely inside both limits -- still well beyond AirNow's ~1-2 day forecast.
FORECAST_SPAN_HOURS = 71

POLLUTANT_CODE_LABELS = {
    "pm25": "PM2.5",
    "pm10": "PM10",
    "o3": "O3",
    "no2": "NO2",
    "so2": "SO2",
    "co": "CO",
}

_cache = {}  # (lat, lon) -> {"fetched_at": ..., "data": ...}
_forecast_cache = {}  # (lat, lon) -> {"fetched_at": ..., "data": ...}
_history_cache = {}  # (lat, lon, hours) -> {"fetched_at": ..., "data": ...}


def _cache_key(lat, lon):
    return (round(lat, 3), round(lon, 3))


def _index(indexes, code):
    return next((i for i in indexes if i.get("code") == code), None)


def _pollutant_label(code):
    code = (code or "").lower()
    return POLLUTANT_CODE_LABELS.get(code, code.upper())


def _best_index(indexes):
    # usa_epa is Google's US EPA-equivalent index -- same 0-500 scale AirNow
    # uses, so switching providers doesn't change what a given number means.
    # uaqi (Google's own 0-100 scale) is the fallback if a location only has that.
    return _index(indexes, "usa_epa") or _index(indexes, "uaqi")


def _pollutants_from(raw_pollutants):
    # Google's own displayName is already exactly "O3"/"PM2.5"/"NO2" etc --
    # use it verbatim rather than a name we maintain ourselves. Only gives
    # concentration (its own units, which vary by pollutant), never an AQI
    # number -- that's not something Google computes per-pollutant, so we
    # don't fabricate one.
    return [
        {
            "parameter": p.get("displayName") or _pollutant_label(p.get("code")),
            "concentration_value": (p.get("concentration") or {}).get("value"),
            "concentration_units": (p.get("concentration") or {}).get("units"),
        }
        for p in raw_pollutants
    ]


def _dominant_label(raw_pollutants, code):
    match = next((p for p in raw_pollutants if p.get("code") == code), None)
    return (match or {}).get("displayName") or _pollutant_label(code)


def _fetch_current(lat, lon):
    resp = requests.post(
        CURRENT_URL,
        params={"key": os.environ["GOOGLE_AQ_API_KEY"]},
        json={
            "location": {"latitude": lat, "longitude": lon},
            "extraComputations": ["LOCAL_AQI", "POLLUTANT_CONCENTRATION", "HEALTH_RECOMMENDATIONS"],
            "languageCode": "en",
        },
        timeout=10,
    )
    resp.raise_for_status()
    body = resp.json()
    idx = _best_index(body.get("indexes") or [])
    if idx is None:
        return None

    raw_pollutants = body.get("pollutants") or []
    aqi = idx.get("aqi")
    return {
        "aqi": aqi,
        "band": airnow.band_for_aqi(aqi),
        "category": idx.get("category"),
        "dominant_pollutant": _dominant_label(raw_pollutants, idx.get("dominantPollutant")),
        "reporting_area": None,  # coordinate-based, no named station -- caller fills in a location label
        "observed_hour": None,
        "time": body.get("dateTime"),
        "pollutants": _pollutants_from(raw_pollutants),
        # Google's equivalent of AirNow's forecaster discussion -- no
        # narrative text, but tailored per-population-group guidance.
        "health_recommendations": body.get("healthRecommendations"),
    }


def get_current_observation(lat, lon):
    key = _cache_key(lat, lon)
    now = time.time()
    cached = _cache.get(key)
    if cached is not None and (now - cached["fetched_at"]) < CACHE_TTL_S:
        return cached["data"]

    data = _fetch_current(lat, lon)
    _cache[key] = {"fetched_at": now, "data": data}
    return data


def _fetch_forecast(lat, lon):
    start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    end = start + timedelta(hours=FORECAST_SPAN_HOURS)
    payload = {
        "location": {"latitude": lat, "longitude": lon},
        "period": {
            "startTime": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "endTime": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "pageSize": 100,
        "extraComputations": ["LOCAL_AQI", "POLLUTANT_CONCENTRATION", "HEALTH_RECOMMENDATIONS"],
        "languageCode": "en",
    }

    hourly = []
    for _ in range(5):  # safety cap against an unbounded pagination loop
        resp = requests.post(FORECAST_URL, params={"key": os.environ["GOOGLE_AQ_API_KEY"]}, json=payload, timeout=15)
        resp.raise_for_status()
        body = resp.json()
        hourly.extend(body.get("hourlyForecasts") or [])
        page_token = body.get("nextPageToken")
        if not page_token:
            break
        payload["pageToken"] = page_token

    if not hourly:
        return None

    # Bucket hourly points into calendar days (UTC) and take the worst hour
    # per day as that day's headline number -- mirrors how AirNow's own
    # per-day forecast already condenses a full day into one reading.
    by_date = {}
    for point in hourly:
        by_date.setdefault(point["dateTime"][:10], []).append(point)

    def hour_aqi(point):
        idx = _best_index(point.get("indexes") or [])
        return idx.get("aqi", 0) if idx else 0

    days = []
    for date in sorted(by_date):
        dominant_point = max(by_date[date], key=hour_aqi)
        idx = _best_index(dominant_point.get("indexes") or [])
        if idx is None:
            continue
        raw_pollutants = dominant_point.get("pollutants") or []
        aqi = idx.get("aqi")
        days.append({
            "date": date,
            "aqi": aqi,
            "category": idx.get("category"),
            "band": airnow.band_for_aqi(aqi),
            "dominant_pollutant": _dominant_label(raw_pollutants, idx.get("dominantPollutant")),
            # Per-population-group guidance for this day's worst hour --
            # more specific than AirNow's one-size-fits-all forecaster
            # discussion, which Google doesn't have an equivalent of.
            "health_recommendations": dominant_point.get("healthRecommendations"),
            "pollutants": _pollutants_from(raw_pollutants),
        })

    return {
        "reporting_area": None,
        "discussion": None,  # Google doesn't provide a forecaster narrative like AirNow's
        "days": days,
    }


def get_forecast(lat, lon):
    key = _cache_key(lat, lon)
    now = time.time()
    cached = _forecast_cache.get(key)
    if cached is not None and (now - cached["fetched_at"]) < FORECAST_CACHE_TTL_S:
        return cached["data"]

    data = _fetch_forecast(lat, lon)
    _forecast_cache[key] = {"fetched_at": now, "data": data}
    return data


# Flat, unit-suffixed keys for the history charts -- named after the unit
# Google actually reports for that pollutant (ppb for every gas including CO,
# µg/m³ for particulates; see the CONCENTRATION_THRESHOLDS comment in
# dashboard.js) so the two per-pollutant history charts can group series by
# unit without re-deriving it per point.
POLLUTANT_CODE_FIELD = {
    "pm25": "pm2_5_ugm3",
    "pm10": "pm10_ugm3",
    "o3": "o3_ppb",
    "no2": "no2_ppb",
    "so2": "so2_ppb",
    "co": "co_ppb",
}


def _flat_concentrations(raw_pollutants):
    out = {}
    for p in raw_pollutants:
        field = POLLUTANT_CODE_FIELD.get((p.get("code") or "").lower())
        value = (p.get("concentration") or {}).get("value")
        if field and value is not None:
            out[field] = value
    return out


def _fetch_history(lat, lon, hours):
    hours = max(1, min(hours, 720))  # Google's own cap is 30 days
    payload = {
        "location": {"latitude": lat, "longitude": lon},
        "hours": hours,
        "pageSize": 100,
        "extraComputations": ["LOCAL_AQI", "POLLUTANT_CONCENTRATION"],
        "languageCode": "en",
    }

    points = []
    for _ in range(10):  # safety cap against an unbounded pagination loop
        resp = requests.post(HISTORY_URL, params={"key": os.environ["GOOGLE_AQ_API_KEY"]}, json=payload, timeout=15)
        resp.raise_for_status()
        body = resp.json()
        for h in body.get("hoursInfo") or []:
            idx = _best_index(h.get("indexes") or [])
            point = {"time": h["dateTime"], "aqi": idx.get("aqi") if idx else None}
            point.update(_flat_concentrations(h.get("pollutants") or []))
            points.append(point)
        page_token = body.get("nextPageToken")
        if not page_token:
            break
        payload["pageToken"] = page_token

    points.sort(key=lambda p: p["time"])
    return points


def get_history(lat, lon, hours):
    key = (_cache_key(lat, lon), hours)
    now = time.time()
    cached = _history_cache.get(key)
    if cached is not None and (now - cached["fetched_at"]) < HISTORY_CACHE_TTL_S:
        return cached["data"]

    data = _fetch_history(lat, lon, hours)
    _history_cache[key] = {"fetched_at": now, "data": data}
    return data
