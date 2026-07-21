"""Away view -- live, unpersisted 7-day history for a second location the user
wants to peek at, without polluting Home's InfluxDB series (see
home_config.py). Each provider's history is a live upstream call, so results
are cached with a long-ish TTL: away history moves slowly and these calls are
billable, so a page refresh or a second viewer must not re-hit the APIs.

Nothing here writes to InfluxDB; Away never appears in Grafana. Only the
providers with a historical-by-coordinate API are supported -- Google, OWM
pollution, and PurpleAir (via its nearest-sensor resolver). See the reconcile
note in home_config.py."""

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


def history(provider, loc, days, force=False):
    """Cached away history for one provider. `loc` is the stored away record
    ({zip, lat, lon}). Returns the provider's result dict ({points, sensor?}),
    or None for an unknown provider (caller -> 400)."""
    fetch = _FETCHERS.get(provider)
    if fetch is None:
        return None
    key = (provider, loc.get("zip"), round(loc["lat"], 3), round(loc["lon"], 3), days)
    return _cache.get(key, lambda: fetch(loc, days), force=force)
