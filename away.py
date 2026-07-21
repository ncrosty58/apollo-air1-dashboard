"""Away view -- live, unpersisted history for a second location the user wants
to peek at, without polluting Home's InfluxDB series (see home_config.py).
Each provider's history is a live upstream call, so results are cached with a
long-ish TTL: away history moves slowly and these calls are billable/rate-
limited, so a page refresh or a second viewer must not re-hit the APIs.

Nothing here writes to InfluxDB; Away never appears in Grafana. AirNow is
included on a more limited basis than the other three: its historical
endpoint is zip- and date-parameterized (one HTTP call per day of window,
not a single ranged call), and its archive is sparse -- a coarser, roughly-
daily series next to Google/OWM/PurpleAir's hourly ones. The 1h cache below
caps that cost the same way it caps the others."""

import airnow
import aq_shared
import google_aq
import owm
import purpleair

# History changes slowly hour to hour; a 1h cache caps upstream cost while
# staying fresh enough for a "glance at another place" view.
CACHE_TTL_S = 60 * 60

_cache = aq_shared.TTLCache(CACHE_TTL_S)

# provider -> fetcher(loc, days) -> {"points": [...], "sensor"?: {...}}, where
# loc carries {zip, lat, lon}. AirNow keys off the zip directly (no geocoding);
# Google/OWM/PurpleAir off coords. Google/OWM/AirNow return a bare point list;
# PurpleAir also reports which sensor it resolved. Normalized to carry "points".
_FETCHERS = {
    "airnow": lambda loc, days: {"points": airnow.get_away_history(loc["zip"], days)},
    "google": lambda loc, days: {"points": google_aq.get_away_history(loc["lat"], loc["lon"], days)},
    "openweathermap": lambda loc, days: {"points": owm.get_away_history(loc["lat"], loc["lon"], days)},
    "purpleair": lambda loc, days: purpleair.get_away_history(loc["lat"], loc["lon"], days),
}

PROVIDERS = tuple(_FETCHERS)

# provider -> [(point_key, parameter, units)] -- which fields of a flat away
# history point carry a pollutant concentration, for current() to turn the
# latest point into the same pollutants-list shape the DB-backed providers'
# current-observation reads already carry (see aq_shared.point_to_pollutants).
# Mirrors google_aq._HISTORY_FIELD_MAP / owm._AWAY_HISTORY_FIELDS / the fields
# purpleair.get_away_history actually writes onto a point. AirNow's away
# points carry only {time, aqi} -- no per-pollutant concentration -- so it
# gets an empty list: current() still shows the headline AQI/category, just
# with no pollutant breakdown, same sparsity tradeoff as its history chart.
_FIELD_DEFS = {
    "airnow": [],
    "google": [
        ("pm2_5_ugm3", "PM2.5", "MICROGRAMS_PER_CUBIC_METER"),
        ("pm10_ugm3", "PM10", "MICROGRAMS_PER_CUBIC_METER"),
        ("o3_ppb", "O3", "PARTS_PER_BILLION"),
        ("no2_ppb", "NO2", "PARTS_PER_BILLION"),
        ("so2_ppb", "SO2", "PARTS_PER_BILLION"),
        ("co_ppb", "CO", "PARTS_PER_BILLION"),
    ],
    "openweathermap": [
        ("pm2_5_ugm3", "PM2.5", "MICROGRAMS_PER_CUBIC_METER"),
        ("pm10_ugm3", "PM10", "MICROGRAMS_PER_CUBIC_METER"),
        ("o3_ppb", "O3", "PARTS_PER_BILLION"),
        ("no2_ppb", "NO2", "PARTS_PER_BILLION"),
        ("so2_ppb", "SO2", "PARTS_PER_BILLION"),
        ("co_ppb", "CO", "PARTS_PER_BILLION"),
    ],
    "purpleair": [
        ("pm2_5_ugm3", "PM2.5", "MICROGRAMS_PER_CUBIC_METER"),
        ("pm10_ugm3", "PM10", "MICROGRAMS_PER_CUBIC_METER"),
    ],
}

# provider -> the app-container env var its live Away call needs. Shared by
# the location-config route (/api/away/*) and the mode-aware outside routes
# (/api/outside*?mode=away) so both gate on the same source of truth.
PROVIDER_KEYS = {
    "airnow": "AIRNOW_API_KEY",
    "google": "GOOGLE_AQ_API_KEY",
    "openweathermap": "OWM_API_KEY",
    "purpleair": "PURPLEAIR_API_KEY",
}


def history(provider, loc, days, force=False):
    """Cached away history for one provider. `loc` is the stored away record
    ({zip, lat, lon}). Returns the provider's result dict ({points, sensor?}),
    or None for an unknown provider (caller -> 400)."""
    fetch = _FETCHERS.get(provider)
    if fetch is None:
        return None
    key = (provider, loc.get("zip"), round(loc["lat"], 3), round(loc["lon"], 3), days)
    return _cache.get(key, lambda: fetch(loc, days), force=force)


def current(provider, loc):
    """Away's analogue of the DB-backed providers' get_current_observation().
    For Google/OWM/PurpleAir this is the latest point of the same cached
    7-day history the chart already fetches (so a single upstream call/cache
    entry serves both), reduced through aq_shared.away_observation into the
    identical current-conditions shape.

    AirNow is the exception: its *historical* endpoint (get_away_history,
    used for the chart) deliberately collapses each hour to one dominant AQI
    number, dropping the per-pollutant breakdown -- reducing from it here
    would show a headline AQI with no pollutant rows underneath, unlike every
    other provider. Its *current*-conditions endpoint has that breakdown (the
    same one Home's AirNow reading already shows), so this calls that
    directly instead -- a second live call, but zip-keyed with its own 20min
    cache in airnow.py, not the 7-day historical fetch.

    Returns None for an unknown provider, or when there's no data (e.g.
    PurpleAir with no healthy sensor nearby)."""
    if provider == "airnow":
        obs = airnow.get_current_observation(loc["zip"])
        if obs is None:
            return None
        return {**obs, "time": obs.get("time")}  # every other provider's shape always carries a time key

    field_defs = _FIELD_DEFS.get(provider)
    if field_defs is None:
        return None
    result = history(provider, loc, days=7)
    if result is None:
        return None
    points = result.get("points") or []
    if not points:
        return None
    obs = aq_shared.away_observation(points[-1], field_defs, reporting_area=loc.get("reporting_area"))
    if obs is not None and provider == "purpleair":
        sensor = result.get("sensor")
        obs["sensor"] = sensor
        # Home's PurpleAir reading names the specific sensor (SENSOR_NAME,
        # see purpleair.py) rather than the generic AirNow-resolved region --
        # Away should read the same way instead of showing the same coarse
        # region every other provider does.
        if sensor:
            obs["reporting_area"] = sensor.get("name") or f"Sensor #{sensor['index']}"
    return obs
