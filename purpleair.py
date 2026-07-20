"""PurpleAir provider -- hyperlocal PM readings from the nearest outdoor
community sensor. Unlike AirNow/Google there's no regional model here: it's
one physical sensor, so readings are minutes fresh but PM-only (no gases).

Raw cf_1 PM2.5 is corrected with EPA's Barkjohn equation (the same one
AirNow's own Fire & Smoke map applies to PurpleAir sensors) before
converting to an AQI, so this provider's number is comparable to AirNow's
rather than reading systematically high."""

import logging
import os
import time

import requests

import epa_aqi
import influx

API_BASE = "https://api.purpleair.com/v1"

CACHE_TTL_S = 10 * 60  # sensors report ~every 2 min; 10 min keeps API points spend low
SENSOR_PICK_TTL_S = 24 * 60 * 60  # which sensor is nearest doesn't change often

# Degrees of lat/lon around home to search for a sensor -- ~0.04° is
# roughly 4.5 km north/south. Widened once if the first box finds nothing.
SEARCH_BOX_DEG = 0.04
SEARCH_BOX_WIDE_DEG = 0.15

_current_cache = {}  # sensor_index -> {"fetched_at", "data"}
_sensor_pick = {"picked_at": 0, "index": None, "name": None}


def is_configured():
    return bool(os.environ.get("PURPLEAIR_API_KEY"))


def _headers():
    return {"X-API-Key": os.environ["PURPLEAIR_API_KEY"]}


def corrected_pm2_5(cf1, humidity_pct):
    """EPA's Barkjohn et al. correction for PurpleAir cf_1 readings, using
    the sensor's own (uncorrected) humidity, as EPA does."""
    if cf1 is None:
        return None
    rh = humidity_pct if humidity_pct is not None else 50
    return max(0.0, 0.524 * cf1 - 0.0862 * rh + 5.75)


def _pick_sensor(lat, lon):
    """Nearest outdoor sensor to home. PURPLEAIR_SENSOR_INDEX pins a
    specific sensor (e.g. your own, or a trusted neighbor's) and skips the
    search entirely."""
    pinned = os.environ.get("PURPLEAIR_SENSOR_INDEX")
    if pinned:
        return int(pinned), None

    now = time.time()
    if _sensor_pick["index"] is not None and (now - _sensor_pick["picked_at"]) < SENSOR_PICK_TTL_S:
        return _sensor_pick["index"], _sensor_pick["name"]

    for box in (SEARCH_BOX_DEG, SEARCH_BOX_WIDE_DEG):
        resp = requests.get(
            f"{API_BASE}/sensors",
            headers=_headers(),
            params={
                "fields": "sensor_index,name,latitude,longitude,location_type",
                "location_type": 0,  # outdoor only
                "nwlat": lat + box, "nwlng": lon - box,
                "selat": lat - box, "selng": lon + box,
            },
            timeout=10,
        )
        resp.raise_for_status()
        body = resp.json()
        fields = body.get("fields") or []
        rows = body.get("data") or []
        if not rows:
            continue
        idx = {f: i for i, f in enumerate(fields)}

        def dist_sq(row):
            dlat = row[idx["latitude"]] - lat
            dlon = row[idx["longitude"]] - lon
            return dlat * dlat + dlon * dlon

        best = min(rows, key=dist_sq)
        _sensor_pick.update({
            "picked_at": now,
            "index": best[idx["sensor_index"]],
            "name": best[idx["name"]],
        })
        return _sensor_pick["index"], _sensor_pick["name"]

    return None, None


def _fetch_current(sensor_index):
    resp = requests.get(
        f"{API_BASE}/sensors/{sensor_index}",
        headers=_headers(),
        params={"fields": "name,latitude,longitude,last_seen,humidity,temperature,pressure,pm2.5_cf_1,pm10.0_atm"},
        timeout=10,
    )
    resp.raise_for_status()
    s = (resp.json() or {}).get("sensor") or {}

    raw_humidity = s.get("humidity")
    pm2_5 = corrected_pm2_5(s.get("pm2.5_cf_1"), raw_humidity)
    pm10 = s.get("pm10.0_atm")
    pm2_5_aqi = epa_aqi.aqi_from_concentration("PM2.5", pm2_5)
    pm10_aqi = epa_aqi.aqi_from_concentration("PM10", pm10)

    candidates = [(a, p) for a, p in ((pm2_5_aqi, "PM2.5"), (pm10_aqi, "PM10")) if a is not None]
    if not candidates:
        return None
    aqi, dominant = max(candidates)
    category = epa_aqi.category_name(aqi)

    # PurpleAir's own published sensor-enclosure biases: temperature reads
    # ~8°F high and humidity ~4% low relative to ambient.
    temp_f = s.get("temperature")
    humidity = raw_humidity

    # Unlike Google, PurpleAir's own history endpoint isn't guaranteed to
    # work at all (gated by API key tier), so persisting every live reading
    # here is the *only* reliable source of PurpleAir history, not just a
    # consistency choice. Best-effort: a write hiccup shouldn't break
    # serving the reading that's already in hand.
    try:
        influx.write_outside_reading({
            "purpleair_aqi": aqi,
            "purpleair_category": category,
            "purpleair_dominant_pollutant": dominant,
            "purpleair_pm2_5_ugm3": round(pm2_5, 1) if pm2_5 is not None else None,
            "purpleair_pm10_ugm3": pm10,
        })
    except Exception:
        logging.exception("Failed to persist PurpleAir reading to Influx")

    return {
        "aqi": aqi,
        "band": epa_aqi.band_for_aqi(aqi),
        "category": category,
        "dominant_pollutant": dominant,
        "reporting_area": s.get("name"),
        "observed_hour": None,
        "time": s.get("last_seen"),
        "pollutants": [
            {"parameter": "PM2.5", "aqi": pm2_5_aqi, "concentration_value": round(pm2_5, 1) if pm2_5 is not None else None, "concentration_units": "MICROGRAMS_PER_CUBIC_METER"},
            {"parameter": "PM10", "aqi": pm10_aqi, "concentration_value": pm10, "concentration_units": "MICROGRAMS_PER_CUBIC_METER"},
        ],
        "weather": {
            "temperature_c": round((temp_f - 8 - 32) * 5 / 9, 1) if temp_f is not None else None,
            "humidity_pct": min(100, humidity + 4) if humidity is not None else None,
            "pressure_hpa": s.get("pressure"),
        },
    }


def get_current_observation(lat, lon):
    sensor_index, _ = _pick_sensor(lat, lon)
    if sensor_index is None:
        return None
    now = time.time()
    cached = _current_cache.get(sensor_index)
    if cached is not None and (now - cached["fetched_at"]) < CACHE_TTL_S:
        return cached["data"]
    data = _fetch_current(sensor_index)
    _current_cache[sensor_index] = {"fetched_at": now, "data": data}
    return data


def get_history(hours):
    """Reads back what get_current_observation() has been persisting to
    InfluxDB (see influx.write_outside_reading) rather than PurpleAir's own
    history endpoint -- that endpoint is gated by API key tier and often
    just isn't available, so this is the only reliable source of PurpleAir
    history, not just a consistency choice. Field names are stripped back
    to the shared flat shape (aqi/pm2_5_ugm3/pm10_ugm3) the frontend's
    overlay charts already expect, same convention as owm.py/google_aq.py's
    get_history."""
    points = []
    for row in influx.query_purpleair_history(hours):
        point = {
            "time": row["time"],
            "aqi": row.get("purpleair_aqi"),
            "pm2_5_ugm3": row.get("purpleair_pm2_5_ugm3"),
            "pm10_ugm3": row.get("purpleair_pm10_ugm3"),
        }
        cleaned = {k: v for k, v in point.items() if v is not None}
        if len(cleaned) > 1:  # more than just "time"
            points.append(cleaned)
    return points
