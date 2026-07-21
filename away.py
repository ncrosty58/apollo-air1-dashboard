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

# provider -> fetcher(lat, lon, days) -> {"points": [...], "sensor"?: {...}}.
# Google/OWM return a bare point list; PurpleAir also reports which sensor it
# resolved, so it returns the richer dict. Normalized to always carry "points".
_FETCHERS = {
    "google": lambda lat, lon, days: {"points": google_aq.get_away_history(lat, lon, days)},
    "openweathermap": lambda lat, lon, days: {"points": owm.get_away_history(lat, lon, days)},
    "purpleair": lambda lat, lon, days: purpleair.get_away_history(lat, lon, days),
}

PROVIDERS = tuple(_FETCHERS)


def history(provider, lat, lon, days, force=False):
    """Cached away history for one provider. Returns the provider's result dict
    ({points, sensor?}), or None for an unknown provider (caller -> 400)."""
    fetch = _FETCHERS.get(provider)
    if fetch is None:
        return None
    key = (provider, round(lat, 3), round(lon, 3), days)
    return _cache.get(key, lambda: fetch(lat, lon, days), force=force)
