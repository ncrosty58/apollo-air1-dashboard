import os
import time

import requests

API_URL = "https://www.airnowapi.org/aq/observation/zipCode/current/"
FORECAST_API_URL = "https://www.airnowapi.org/aq/forecast/zipCode/"
CACHE_TTL_S = 20 * 60  # AirNow refreshes hourly, but the exact publish moment within the
# hour isn't fixed and its own reporting lag varies -- a shorter cache
# means a fetch that lands just before AirNow publishes a new hour
# doesn't sit stale for most of the following hour too.
FORECAST_CACHE_TTL_S = 3 * 60 * 60  # forecasts are issued at most a couple times a day

# AirNow resolves a zip to its nearest reporting area within this radius.
# Urban zips typically have one within 25mi, but rural zips (e.g. northern
# Wisconsin) can be 50-100mi from the nearest station — 200 is generous
# enough to cover those without changing which station wins for zips that
# already resolve at a shorter distance (it's always the *nearest* one).
SEARCH_DISTANCE_MI = 200

US_STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia",
    "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa",
    "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri",
    "MT": "Montana", "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey",
    "NM": "New Mexico", "NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio",
    "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont",
    "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "DC": "District of Columbia",
}
# AirNow sometimes reports a compass-direction region instead of a city (e.g.
# "Southeast" for the southeast Michigan reporting area) -- "Southeast, MI"
# reads like a made-up town name, so those get the state's full name folded
# in ("Southeast Michigan") instead of the usual "City, ST" abbreviation.
_REGIONAL_REPORTING_AREA_WORDS = {
    "north", "south", "east", "west",
    "northeast", "northwest", "southeast", "southwest",
    "central", "metro",
}


def _format_reporting_area(area, state_code):
    if not area:
        return state_code or ""
    if area.strip().lower() in _REGIONAL_REPORTING_AREA_WORDS:
        return f"{area} {US_STATE_NAMES.get(state_code, state_code)}".strip()
    return f"{area}, {state_code}"


_cache = {}  # zip -> {"fetched_at": ..., "data": ...}
_forecast_cache = {}  # zip -> {"fetched_at": ..., "data": ...}


def band_for_aqi(aqi):
    """Same good/fair/poor/bad split used for the indoor AQI reading, so
    Inside/Outside cards are directly comparable at a glance."""
    if aqi is None:
        return None
    if aqi > 150:
        return "bad"
    if aqi > 100:
        return "poor"
    if aqi > 50:
        return "fair"
    return "good"


def band_for_category(number):
    """Fallback for forecast rows where AirNow reports AQI as -1 (not
    computed, e.g. during an active smoke/alert day) but still gives a
    Category.Number on its own 1-6 scale. Thresholds mirror band_for_aqi."""
    if number is None:
        return None
    if number >= 4:
        return "bad"
    if number == 3:
        return "poor"
    if number == 2:
        return "fair"
    return "good"


def _fetch(zip_code):
    resp = requests.get(
        API_URL,
        params={
            "format": "application/json",
            "zipCode": zip_code,
            "distance": SEARCH_DISTANCE_MI,
            "API_KEY": os.environ["AIRNOW_API_KEY"],
        },
        timeout=10,
    )
    resp.raise_for_status()
    readings = resp.json()
    if not readings:
        return None

    dominant = max(readings, key=lambda r: r["AQI"])
    return {
        "aqi": dominant["AQI"],
        "category": dominant["Category"]["Name"],
        "band": band_for_aqi(dominant["AQI"]),
        "dominant_pollutant": dominant["ParameterName"],
        "reporting_area": _format_reporting_area(dominant["ReportingArea"], dominant["StateCode"]),
        "lat": dominant.get("Latitude"),
        "lon": dominant.get("Longitude"),
        "observed_hour": dominant["HourObserved"],
        "pollutants": [
            {
                "parameter": r["ParameterName"],
                "aqi": r["AQI"],
                "category": r["Category"]["Name"],
            }
            for r in readings
        ],
    }


def get_current_observation(zip_code):
    now = time.time()
    cached = _cache.get(zip_code)
    if cached is not None and (now - cached["fetched_at"]) < CACHE_TTL_S:
        return cached["data"]

    data = _fetch(zip_code)
    _cache[zip_code] = {"fetched_at": now, "data": data}
    return data


def _fetch_forecast(zip_code):
    resp = requests.get(
        FORECAST_API_URL,
        params={
            "format": "application/json",
            "zipCode": zip_code,
            "distance": SEARCH_DISTANCE_MI,
            "API_KEY": os.environ["AIRNOW_API_KEY"],
        },
        timeout=10,
    )
    resp.raise_for_status()
    rows = resp.json()
    if not rows:
        return None

    by_date = {}
    discussion = None
    for r in rows:
        by_date.setdefault(r["DateForecast"], []).append(r)
        if not discussion and (r.get("Discussion") or "").strip():
            discussion = r["Discussion"].strip()

    days = []
    for date in sorted(by_date):
        readings = by_date[date]
        # AQI is -1 on rows AirNow hasn't computed a number for (common on
        # active alert days) — Category.Number is still meaningful then, so
        # rank by that first and use it as the band fallback.
        dominant = max(readings, key=lambda r: (r["Category"]["Number"], r["AQI"]))
        dominant_aqi = dominant["AQI"] if dominant["AQI"] and dominant["AQI"] > 0 else None
        days.append({
            "date": date,
            "aqi": dominant_aqi,
            "category": dominant["Category"]["Name"],
            "band": band_for_aqi(dominant_aqi) if dominant_aqi else band_for_category(dominant["Category"]["Number"]),
            "dominant_pollutant": dominant["ParameterName"],
            # An agency-issued "Action Day" designation -- distinct from the
            # AQI number itself, e.g. PM2.5 can be flagged even on a day its
            # own AQI wasn't computed (see the -1/Category fallback above).
            "action_day": any(r.get("ActionDay") for r in readings),
            "pollutants": [
                {
                    "parameter": r["ParameterName"],
                    "aqi": r["AQI"] if r["AQI"] and r["AQI"] > 0 else None,
                    "category": r["Category"]["Name"],
                }
                for r in readings
            ],
        })

    return {
        "reporting_area": _format_reporting_area(rows[0]["ReportingArea"], rows[0]["StateCode"]),
        "lat": rows[0].get("Latitude"),
        "lon": rows[0].get("Longitude"),
        "discussion": discussion,
        "days": days,
    }


def get_forecast(zip_code, force=False):
    now = time.time()
    cached = _forecast_cache.get(zip_code)
    if not force and cached is not None and (now - cached["fetched_at"]) < FORECAST_CACHE_TTL_S:
        return cached["data"]

    data = _fetch_forecast(zip_code)
    _forecast_cache[zip_code] = {"fetched_at": now, "data": data}
    return data
