import os
import time

import requests

API_URL = "https://www.airnowapi.org/aq/observation/zipCode/current/"
CACHE_TTL_S = 55 * 60  # AirNow refreshes hourly; a little headroom avoids edge-of-hour misses

_cache = {"fetched_at": 0, "data": None}


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


def _fetch():
    resp = requests.get(
        API_URL,
        params={
            "format": "application/json",
            "zipCode": os.environ["AIRNOW_ZIP"],
            "distance": 25,
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
        "reporting_area": f'{dominant["ReportingArea"]}, {dominant["StateCode"]}',
        "observed": dominant["DateObserved"],
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


def get_current_observation():
    now = time.time()
    if _cache["data"] is not None and (now - _cache["fetched_at"]) < CACHE_TTL_S:
        return _cache["data"]

    data = _fetch()
    _cache["data"] = data
    _cache["fetched_at"] = now
    return data
