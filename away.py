"""Away view -- live, unpersisted 7-day history for a second location the user
wants to peek at, without polluting Home's InfluxDB series (see
home_config.py). Each provider's history is a live upstream call, so results
are cached with a long-ish TTL: away history moves slowly and these calls are
billable, so a page refresh or a second viewer must not re-hit the APIs.

Nothing here writes to InfluxDB; Away never appears in Grafana. Only the
providers with a historical-by-coordinate API are supported -- Google, OWM
pollution, and PurpleAir (via its nearest-sensor resolver). See the reconcile
note in home_config.py."""

import aq_shared
import google_aq
import owm
import purpleair

# History changes slowly hour to hour; a 1h cache caps upstream cost while
# staying fresh enough for a "glance at another place" view.
CACHE_TTL_S = 60 * 60

_cache = aq_shared.TTLCache(CACHE_TTL_S)

# provider -> fetcher(loc, days) -> {"points": [...], "sensor"?: {...}}, where
# loc carries {zip, lat, lon}. Google/OWM/PurpleAir key off coords. Google/OWM
# return a bare point list; PurpleAir also reports which sensor it resolved.
# Normalized to carry "points". AirNow is deliberately not offered here -- it
# has no live per-location story the way the other three do (see
# home-away-location-plan), so Away only ever covers these three.
_FETCHERS = {
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
# purpleair.get_away_history actually writes onto a point.
_FIELD_DEFS = {
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
    """Away's analogue of the DB-backed providers' get_current_observation():
    the latest point of the same cached 7-day history the chart already fetches
    (so a single upstream call/cache entry serves both), reduced through
    aq_shared.away_observation into the identical current-conditions shape.
    Returns None for an unknown provider, or when the history came back empty
    (e.g. PurpleAir with no healthy sensor nearby)."""
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
        obs["sensor"] = result.get("sensor")
    return obs
