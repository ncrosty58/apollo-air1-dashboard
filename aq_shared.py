"""Small helpers shared by the provider modules (airnow/google_aq/purpleair/
owm), so the current-reading, history, and forecast-caching patterns live in
one place instead of being copy-pasted per provider."""

import time


class TTLCache:
    """A tiny time-to-live cache keyed by anything hashable. Used for both the
    short current-conditions cache and the longer forecast cache; `get` fetches
    (and stores) on a miss or when forced."""

    def __init__(self, ttl_s):
        self._ttl = ttl_s
        self._cache = {}

    def get(self, key, fetch, force=False):
        now = time.time()
        cached = self._cache.get(key)
        if not force and cached is not None and (now - cached["at"]) < self._ttl:
            return cached["data"]
        data = fetch()
        self._cache[key] = {"at": now, "data": data}
        return data


def headline(row, aqi_field, category_field=None, dominant_field=None, category_fallback=None):
    """Pull the stored headline (aqi, category, dominant) out of an InfluxDB
    row for a current reading. Returns None if there's no AQI to show. The AQI
    is coerced to an int; category falls back to `category_fallback(aqi)` (e.g.
    epa_aqi.category_name) only when the stored label is missing."""
    aqi = row.get(aqi_field)
    if aqi is None:
        return None
    aqi = int(round(aqi))
    category = row.get(category_field) if category_field else None
    if category is None and category_fallback is not None:
        category = category_fallback(aqi)
    dominant = row.get(dominant_field) if dominant_field else None
    return aqi, category, dominant


def history_points(rows, aqi_field, field_map):
    """Turn stored InfluxDB rows into the flat history-point shape the
    frontend overlays expect: {time, aqi, <mapped fields>}. `field_map` is
    {out_key: (source_field, transform)} where transform converts the stored
    value (e.g. identity for concentrations, µg/m³->ppb for OWM gases). Points
    with only a timestamp are dropped; floats are rounded to 2 dp."""
    points = []
    for row in rows:
        aqi = row.get(aqi_field)
        point = {"time": row["time"], "aqi": int(round(aqi)) if aqi is not None else None}
        for out_key, (source_field, transform) in field_map.items():
            point[out_key] = transform(row.get(source_field))
        cleaned = {k: (round(v, 2) if isinstance(v, float) else v) for k, v in point.items() if v is not None}
        if len(cleaned) > 1:  # more than just "time"
            points.append(cleaned)
    return points


def worst_hour_per_day(points, date_of, aqi_of):
    """Bucket hourly forecast points into calendar days and pick each day's
    worst hour by AQI -- the shared core of the Google/OWM day forecasts.
    Returns an ordered {date: (aqi, point)} dict; callers build their own
    per-day payload from the winning point."""
    by_date = {}
    for point in points:
        date = date_of(point)
        if date is None:
            continue
        by_date.setdefault(date, []).append(point)
    result = {}
    for date in sorted(by_date):
        best = None
        for point in by_date[date]:
            aqi = aqi_of(point)
            if aqi is not None and (best is None or aqi > best[0]):
                best = (aqi, point)
        if best is not None:
            result[date] = best
    return result


def identity(value):
    return value
