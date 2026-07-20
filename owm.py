"""OpenWeatherMap pollution provider -- reads the owm_-prefixed fields that
Node-RED writes into the outside_air_quality measurement (piggybacked on the
chassis tab's existing 5-minute OWM weather poll, one air_pollution call per
~15 min). This dashboard never calls OpenWeatherMap itself, so switching to
this provider adds zero OWM API traffic.

OWM reports every component as a raw µg/m³ concentration plus its own 1-5
index; both convert to the EPA 0-500 AQI scale here so the number means the
same thing it does on every other provider."""

import os
from datetime import UTC, datetime

import requests

import aq_shared
import epa_aqi
import influx

# OWM component -> (concentration field, EPA parameter, per-pollutant AQI
# field). The AQI is the one Node-RED derived from the concentration and stored
# alongside it -- the app just reads it. NH3 has no EPA AQI breakpoint, so it's
# shown as a concentration only (and is dropped from the AQI-only dashboard).
COMPONENTS = [
    ("owm_pm2_5_ugm3", "PM2.5", "owm_pm2_5_aqi_epa"),
    ("owm_pm10_ugm3", "PM10", "owm_pm10_aqi_epa"),
    ("owm_o3_ugm3", "O3", "owm_o3_aqi_epa"),
    ("owm_no2_ugm3", "NO2", "owm_no2_aqi_epa"),
    ("owm_so2_ugm3", "SO2", "owm_so2_aqi_epa"),
    ("owm_co_ugm3", "CO", "owm_co_aqi_epa"),
]

# OWM's air_pollution forecast endpoint returns components under these raw
# keys (all µg/m³), rather than the owm_-prefixed Influx field names above.
# Same EPA parameters, so _aqi_for/_epa_value handle them unchanged.
FORECAST_COMPONENTS = [
    ("pm2_5", "PM2.5"),
    ("pm10", "PM10"),
    ("o3", "O3"),
    ("no2", "NO2"),
    ("so2", "SO2"),
    ("co", "CO"),
]

# Unlike the current-reading/history above (polled by Node-RED into Influx),
# the forecast is fetched live and on demand -- exactly the pattern Google's
# forecast uses. It's the one place this app calls OpenWeatherMap directly.
FORECAST_URL = "https://api.openweathermap.org/data/2.5/air_pollution/forecast"
FORECAST_CACHE_TTL_S = 3 * 60 * 60  # OWM refreshes the pollution model hourly

_forecast_cache = aq_shared.TTLCache(FORECAST_CACHE_TTL_S)  # keyed by (lat, lon)


def _epa_value(parameter, ugm3):
    """Convert an OWM µg/m³ reading into the unit EPA's breakpoint table
    for that parameter expects."""
    if ugm3 is None:
        return None
    if parameter in ("PM2.5", "PM10"):
        return ugm3
    ppb = epa_aqi.ugm3_to_ppb(parameter, ugm3)
    if parameter == "CO":
        return ppb / 1000 if ppb is not None else None  # EPA's CO table is ppm
    return ppb


def _aqi_for(parameter, ugm3):
    return epa_aqi.aqi_from_concentration(parameter, _epa_value(parameter, ugm3))


def get_current_observation():
    """Headline AQI, category, and dominant pollutant are read straight from
    the fields Node-RED computed (owm_aqi_epa / owm_category /
    owm_dominant_pollutant) -- the worst-of-all-components EPA AQI, the same
    number Grafana reads -- rather than recomputed here. Per-pollutant rows
    are shown as raw concentrations (like the Google/PurpleAir cards), so the
    only AQI number on the card is the one authoritative headline. Category
    and dominant fall back gracefully for points written before Node-RED
    started storing them."""
    row = influx.query_owm_latest()
    if row is None:
        return None
    hd = aq_shared.headline(row, "owm_aqi_epa", "owm_category", "owm_dominant_pollutant", epa_aqi.category_name)
    if hd is None:
        return None
    aqi, category, dominant = hd

    per_pollutant = []
    for field, parameter, aqi_field in COMPONENTS:
        value = row.get(field)
        if value is None:
            continue
        row_out = {
            "parameter": parameter,
            "concentration_value": round(value, 2),
            "concentration_units": "MICROGRAMS_PER_CUBIC_METER",
        }
        # AQI is present for every criteria pollutant; the dashboard renders it,
        # the Technical page keeps showing the concentration.
        aqi_value = row.get(aqi_field)
        if aqi_value is not None:
            row_out["aqi"] = int(round(aqi_value))
        per_pollutant.append(row_out)
    if row.get("owm_nh3_ugm3") is not None:
        per_pollutant.append({
            "parameter": "NH3",
            "concentration_value": round(row["owm_nh3_ugm3"], 2),
            "concentration_units": "MICROGRAMS_PER_CUBIC_METER",
        })

    return {
        "aqi": aqi,
        "band": epa_aqi.band_for_aqi(aqi),
        "category": category,
        "dominant_pollutant": dominant,
        "reporting_area": None,  # caller fills in the home label
        "observed_hour": None,
        "time": row.get("time"),
        "pollutants": per_pollutant,
    }


# Gas fields are converted µg/m³ -> ppb for the overlay chart's units, which
# is a display unit conversion, not AQI math. The AQI itself is read from the
# stored owm_aqi_epa (not recomputed) by the shared history_points helper.
_HISTORY_FIELD_MAP = {
    "pm2_5_ugm3": ("owm_pm2_5_ugm3", aq_shared.identity),
    "pm10_ugm3": ("owm_pm10_ugm3", aq_shared.identity),
    "o3_ppb": ("owm_o3_ugm3", lambda v: epa_aqi.ugm3_to_ppb("O3", v)),
    "no2_ppb": ("owm_no2_ugm3", lambda v: epa_aqi.ugm3_to_ppb("NO2", v)),
    "so2_ppb": ("owm_so2_ugm3", lambda v: epa_aqi.ugm3_to_ppb("SO2", v)),
    "co_ppb": ("owm_co_ugm3", lambda v: epa_aqi.ugm3_to_ppb("CO", v)),
}


def get_history(hours):
    """Points shaped like the Google provider's history (concentrations in
    generic field names + the stored EPA AQI per point), so the frontend's
    concentration-overlay charts work unchanged."""
    return aq_shared.history_points(influx.query_owm_history(hours), "owm_aqi_epa", _HISTORY_FIELD_MAP)


def _cache_key(lat, lon):
    return (round(lat, 3), round(lon, 3))


def _forecast_pollutants(components):
    """Per-pollutant concentrations for a forecast hour, shaped like every
    other provider's forecast pollutants (concentration only, no per-
    pollutant AQI -- the headline AQI is the worst-of below)."""
    pollutants = []
    for key, parameter in FORECAST_COMPONENTS:
        value = components.get(key)
        if value is not None:
            pollutants.append({
                "parameter": parameter,
                "concentration_value": round(value, 2),
                "concentration_units": "MICROGRAMS_PER_CUBIC_METER",
            })
    if components.get("nh3") is not None:
        pollutants.append({
            "parameter": "NH3",
            "concentration_value": round(components["nh3"], 2),
            "concentration_units": "MICROGRAMS_PER_CUBIC_METER",
        })
    return pollutants


def _forecast_aqi_dominant(components):
    """Worst EPA AQI across a forecast hour's components -> (aqi, dominant),
    or None. Same worst-of-all logic as the stored current reading."""
    candidates = [
        (_aqi_for(parameter, components.get(key)), parameter)
        for key, parameter in FORECAST_COMPONENTS
    ]
    candidates = [(a, p) for a, p in candidates if a is not None]
    return max(candidates) if candidates else None


def _forecast_date(point):
    dt = point.get("dt")
    return datetime.fromtimestamp(dt, UTC).strftime("%Y-%m-%d") if dt is not None else None


def _fetch_forecast(lat, lon):
    resp = requests.get(
        FORECAST_URL,
        params={"lat": lat, "lon": lon, "appid": os.environ["OWM_API_KEY"]},
        timeout=15,
    )
    resp.raise_for_status()
    hourly = resp.json().get("list") or []
    if not hourly:
        return None

    # Bucket the hourly forecast into UTC calendar days and take the worst
    # hour per day as that day's headline -- same shape and day-picking logic
    # AirNow/Google forecasts already use (shared worst_hour_per_day), and the
    # worst hour is picked by the same EPA recompute as the number shown.
    worst = aq_shared.worst_hour_per_day(
        hourly,
        date_of=_forecast_date,
        aqi_of=lambda p: (_forecast_aqi_dominant(p.get("components") or {}) or (None,))[0],
    )

    days = []
    for date, (aqi, point) in worst.items():
        components = point.get("components") or {}
        result = _forecast_aqi_dominant(components)
        dominant_pollutant = result[1] if result else None
        days.append({
            "date": date,
            "aqi": aqi,
            "category": epa_aqi.category_name(aqi),
            "band": epa_aqi.band_for_aqi(aqi),
            "dominant_pollutant": dominant_pollutant,
            "pollutants": _forecast_pollutants(components),
        })

    return {
        "reporting_area": None,  # caller fills in the home/location label
        "discussion": None,  # OWM has no forecaster narrative like AirNow's
        "days": days,
    }


def get_forecast(lat, lon, force=False):
    return _forecast_cache.get(_cache_key(lat, lon), lambda: _fetch_forecast(lat, lon), force=force)
