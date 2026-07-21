"""Unit tests for the Away path: the PurpleAir nearest-sensor resolver + its
Barkjohn correction, and the Google/OWM/PurpleAir away-history reshapers plus
the away.py cache. All upstream HTTP is monkeypatched -- no network, no DB."""
import airnow
import away
import google_aq
import owm
import purpleair


class FakeResp:
    def __init__(self, payload):
        self._p = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._p


# ---------- PurpleAir correction + resolver ----------

def test_corrected_pm25_barkjohn_low_range():
    expected = 0.52 * 100 - 0.086 * 50 + 5.75
    assert round(purpleair.corrected_pm25(100, 50), 4) == round(expected, 4)


def test_corrected_pm25_humidity_defaults_and_clamps():
    assert purpleair.corrected_pm25(100, None) == purpleair.corrected_pm25(100, 50)
    assert purpleair.corrected_pm25(None, 50) is None
    assert purpleair.corrected_pm25(0, 90) >= 0  # never negative


def test_nearest_outdoor_sensor_filters_and_ranks_by_distance(monkeypatch):
    monkeypatch.setenv("PURPLEAIR_API_KEY", "k")
    payload = {
        "fields": ["sensor_index", "name", "latitude", "longitude", "confidence", "channel_flags", "last_seen"],
        "data": [
            [1, "Far Healthy", 42.70, -83.35, 99, 0, 111],
            [2, "Near Downgraded", 42.599, -83.358, 99, 2, 111],   # channel flag -> skip
            [3, "Near LowConf", 42.599, -83.358, 50, 0, 111],       # low confidence -> skip
            [4, "Near Healthy", 42.599, -83.357, 95, 0, 111],       # winner
        ],
    }
    monkeypatch.setattr(purpleair.requests, "get", lambda *a, **k: FakeResp(payload))
    best = purpleair.nearest_outdoor_sensor(42.5988, -83.3577)
    assert best["index"] == 4
    assert best["name"] == "Near Healthy"


def test_nearest_outdoor_sensor_none_without_key(monkeypatch):
    monkeypatch.delenv("PURPLEAIR_API_KEY", raising=False)
    assert purpleair.nearest_outdoor_sensor(1, 2) is None


def test_purpleair_away_history_reshapes_and_sorts(monkeypatch):
    monkeypatch.setenv("PURPLEAIR_API_KEY", "k")
    monkeypatch.setattr(purpleair, "nearest_outdoor_sensor",
                        lambda lat, lon: {"index": 7, "name": "S", "distance_km": 1.0,
                                          "confidence": 99, "last_seen": 1})
    hist = {
        "fields": ["time_stamp", "pm2.5_cf_1", "pm10.0_atm", "humidity"],
        "data": [[2000, 20.0, 15.0, 50], [1000, 10.0, 8.0, 50]],  # out of order
    }
    monkeypatch.setattr(purpleair.requests, "get", lambda *a, **k: FakeResp(hist))
    result = purpleair.get_away_history(42.0, -83.0, 7)
    assert result["sensor"]["index"] == 7
    pts = result["points"]
    assert len(pts) == 2
    assert pts[0]["time"] < pts[1]["time"]  # sorted ascending
    assert "pm2_5_ugm3" in pts[0] and "aqi" in pts[0]


def test_purpleair_away_history_no_sensor(monkeypatch):
    monkeypatch.setattr(purpleair, "nearest_outdoor_sensor", lambda lat, lon: None)
    assert purpleair.get_away_history(1, 2, 7) == {"points": [], "sensor": None}


# ---------- Google / OWM away history ----------

def test_google_away_history_reshapes(monkeypatch):
    monkeypatch.setenv("GOOGLE_AQ_API_KEY", "k")
    body = {"hoursInfo": [
        {"dateTime": "2026-07-19T10:00:00Z", "pollutants": [
            {"code": "pm25", "concentration": {"value": 12.3, "units": "MICROGRAMS_PER_CUBIC_METER"}},
            {"code": "o3", "concentration": {"value": 30.0, "units": "PARTS_PER_BILLION"}},
        ]},
    ]}
    monkeypatch.setattr(google_aq.requests, "post", lambda *a, **k: FakeResp(body))
    pts = google_aq.get_away_history(42.0, -83.0, 7)
    assert len(pts) == 1
    assert pts[0]["pm2_5_ugm3"] == 12.3
    assert pts[0]["o3_ppb"] == 30.0
    assert "aqi" in pts[0]


def test_owm_away_history_reshapes_and_sorts(monkeypatch):
    monkeypatch.setenv("OWM_API_KEY", "k")
    body = {"list": [
        {"dt": 1000, "components": {"pm2_5": 10.0, "pm10": 20.0, "o3": 48.0}},
        {"dt": 2000, "components": {"pm2_5": 5.0}},
    ]}
    monkeypatch.setattr(owm.requests, "get", lambda *a, **k: FakeResp(body))
    pts = owm.get_away_history(42.0, -83.0, 7)
    assert len(pts) == 2
    assert pts[0]["time"] < pts[1]["time"]
    assert pts[0]["pm2_5_ugm3"] == 10.0
    assert "o3_ppb" in pts[0]  # µg/m³ -> ppb conversion applied


# ---------- away.py orchestration + cache ----------

def test_airnow_away_history_dedups_dominant_and_sorts(monkeypatch):
    monkeypatch.setenv("AIRNOW_API_KEY", "k")

    # One "call per day" returns that day's readings; two pollutants share a
    # timestamp -> keep the dominant (max) AQI; -1 (not computed) is dropped.
    def fake_get(url, params=None, **k):
        date = params["date"][:10]
        return FakeResp([
            {"DateObserved": date + " ", "HourObserved": 9, "ParameterName": "O3", "AQI": 40},
            {"DateObserved": date + " ", "HourObserved": 9, "ParameterName": "PM2.5", "AQI": 55},
            {"DateObserved": date + " ", "HourObserved": 10, "ParameterName": "PM2.5", "AQI": -1},
        ])

    monkeypatch.setattr(airnow.requests, "get", fake_get)
    pts = airnow.get_away_history("54554", 3)
    assert len(pts) == 3  # 3 days, one usable hour each (the -1 hour dropped)
    assert pts[0]["time"] < pts[-1]["time"]  # sorted ascending
    assert all(p["aqi"] == 55 for p in pts)  # dominant PM2.5 wins over O3


def test_away_history_unknown_provider():
    assert away.history("nope", {"zip": "x", "lat": 1, "lon": 2}, 7) is None


def test_away_history_caches(monkeypatch):
    calls = []
    monkeypatch.setattr(away.google_aq, "get_away_history",
                        lambda lat, lon, days: calls.append(1) or [{"time": "t", "aqi": 1}])
    away._cache = away.aq_shared.TTLCache(away.CACHE_TTL_S)  # fresh cache
    loc = {"zip": "z", "lat": 42.0, "lon": -83.0}
    r1 = away.history("google", loc, 7)
    r2 = away.history("google", loc, 7)
    assert r1 == r2 == {"points": [{"time": "t", "aqi": 1}]}
    assert len(calls) == 1  # second call served from cache, no upstream hit


# ---------- away.current() -- the mode=away analogue of get_current_observation ----------

def test_current_reduces_latest_history_point(monkeypatch):
    away._cache = away.aq_shared.TTLCache(away.CACHE_TTL_S)
    monkeypatch.setattr(away.google_aq, "get_away_history", lambda lat, lon, days: [
        {"time": "2026-07-19T10:00:00Z", "aqi": 40, "pm2_5_ugm3": 12.0},
        {"time": "2026-07-20T10:00:00Z", "aqi": 55, "pm2_5_ugm3": 200.0, "o3_ppb": 30.0},
    ])
    loc = {"zip": "60601", "lat": 41.8, "lon": -87.6, "reporting_area": "Chicago"}
    obs = away.current("google", loc)
    assert obs["aqi"] == 55  # the latest point, not the first
    assert obs["reporting_area"] == "Chicago"
    assert obs["time"] == "2026-07-20T10:00:00Z"
    assert obs["dominant_pollutant"] == "PM2.5"  # 200 ug/m3 recomputes worse than 30 ppb O3
    assert {"parameter": "PM2.5", "concentration_value": 200.0, "concentration_units": "MICROGRAMS_PER_CUBIC_METER"} in obs["pollutants"]
    assert "sensor" not in obs  # only PurpleAir attaches one


def test_current_purpleair_attaches_sensor(monkeypatch):
    away._cache = away.aq_shared.TTLCache(away.CACHE_TTL_S)
    monkeypatch.setattr(away.purpleair, "get_away_history", lambda lat, lon, days: {
        "points": [{"time": "2026-07-20T10:00:00Z", "aqi": 20, "pm2_5_ugm3": 5.0}],
        "sensor": {"index": 7, "name": "S", "distance_km": 1.2},
    })
    loc = {"zip": "60601", "lat": 41.8, "lon": -87.6, "reporting_area": "Chicago"}
    obs = away.current("purpleair", loc)
    assert obs["sensor"]["index"] == 7


def test_current_no_points_is_none(monkeypatch):
    away._cache = away.aq_shared.TTLCache(away.CACHE_TTL_S)
    monkeypatch.setattr(away.purpleair, "get_away_history", lambda lat, lon, days: {"points": [], "sensor": None})
    loc = {"zip": "60601", "lat": 41.8, "lon": -87.6, "reporting_area": "Chicago"}
    assert away.current("purpleair", loc) is None


def test_current_unknown_provider_is_none():
    assert away.current("nope", {"zip": "x", "lat": 1, "lon": 2}) is None


def test_current_airnow_uses_live_observation_not_history(monkeypatch):
    # Unlike the other three, AirNow's current() doesn't reduce a history
    # point -- its historical endpoint has no per-pollutant breakdown to
    # reduce. It calls the live current-observation endpoint directly, so a
    # get_away_history stub is deliberately left unset here: if current()
    # ever regresses to calling it, this test would error rather than pass.
    monkeypatch.setattr(away.airnow, "get_current_observation", lambda zip_code: {
        "aqi": 172, "category": "Unhealthy", "band": "bad", "dominant_pollutant": "O3",
        "reporting_area": "Chicago, IL", "observed_hour": 14,
        "pollutants": [{"parameter": "O3", "aqi": 172, "category": "Unhealthy"}],
    })
    loc = {"zip": "60601", "lat": 41.8, "lon": -87.6, "reporting_area": "Chicago"}
    obs = away.current("airnow", loc)
    assert obs["aqi"] == 172
    assert obs["pollutants"] == [{"parameter": "O3", "aqi": 172, "category": "Unhealthy"}]
    assert obs["time"] is None  # AirNow's live shape carries no "time" key -- normalized here


def test_current_airnow_no_data_is_none(monkeypatch):
    monkeypatch.setattr(away.airnow, "get_current_observation", lambda zip_code: None)
    loc = {"zip": "60601", "lat": 41.8, "lon": -87.6, "reporting_area": "Chicago"}
    assert away.current("airnow", loc) is None
