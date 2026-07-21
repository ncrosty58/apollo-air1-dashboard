"""Route-level tests for app.py: the error-status mapping (InfluxDB failure ->
502, no data -> 404, bad input -> 400) and the MQTT-unavailable 503 guard on
the control endpoints. Upstream/DB calls are monkeypatched -- no network or
InfluxDB is touched."""
import pytest

import app as app_module
import away
import google_aq
import home_config
import influx


@pytest.fixture
def client():
    app_module.app.config["TESTING"] = True
    return app_module.app.test_client()


def test_latest_no_data_is_404(client, monkeypatch):
    monkeypatch.setattr(influx, "query_latest", lambda: None)
    assert client.get("/api/latest").status_code == 404


def test_latest_influx_error_is_502(client, monkeypatch):
    def boom():
        raise RuntimeError("influx down")
    monkeypatch.setattr(influx, "query_latest", boom)
    assert client.get("/api/latest").status_code == 502


def test_latest_ok(client, monkeypatch):
    monkeypatch.setattr(influx, "query_latest", lambda: {"aqi": 5, "time": "t"})
    res = client.get("/api/latest")
    assert res.status_code == 200
    assert res.get_json()["aqi"] == 5


def test_history_influx_error_is_502(client, monkeypatch):
    def boom(_hours):
        raise RuntimeError("influx down")
    monkeypatch.setattr(influx, "query_history", boom)
    assert client.get("/api/history?hours=24").status_code == 502


def test_forecast_bad_zip_is_400(client):
    assert client.get("/api/forecast?zip=abc").status_code == 400


def test_forecast_unconfigured_provider_is_400(client, monkeypatch):
    monkeypatch.delenv("GOOGLE_AQ_API_KEY", raising=False)
    res = client.get("/api/forecast?zip=54501&provider=google")
    assert res.status_code == 400
    assert "configured" in res.get_json()["error"]


def test_control_503_when_mqtt_unavailable(client, monkeypatch):
    monkeypatch.setattr(app_module.mqtt_bridge, "available", lambda: False)
    assert client.post("/api/control/button/esp_reboot").status_code == 503


def test_control_unknown_switch_is_404(client, monkeypatch):
    monkeypatch.setattr(app_module.mqtt_bridge, "available", lambda: True)
    res = client.post("/api/control/switch/nope", json={"state": True})
    assert res.status_code == 404


def test_control_number_out_of_bounds_is_400(client, monkeypatch):
    monkeypatch.setattr(app_module.mqtt_bridge, "available", lambda: True)
    res = client.post("/api/control/number/sleep_duration", json={"value": 99999})
    assert res.status_code == 400


def test_control_number_rejects_non_number(client, monkeypatch):
    monkeypatch.setattr(app_module.mqtt_bridge, "available", lambda: True)
    res = client.post("/api/control/number/sleep_duration", json={"value": "abc"})
    assert res.status_code == 400


# ---------- mode=away (see away.py / home_config.py) ----------

def test_outside_away_no_location_is_404(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_AQ_API_KEY", "k")
    monkeypatch.setattr(home_config, "get_away", lambda: None)
    res = client.get("/api/outside?provider=google&mode=away")
    assert res.status_code == 404
    assert "no away location set" in res.get_json()["error"]


def test_outside_away_unsupported_provider_rejected(client):
    # Only providers away.py actually supports are offered in Away mode.
    res = client.get("/api/outside?provider=nope&mode=away")
    assert res.status_code == 400
    assert "Away mode" in res.get_json()["error"]


def test_outside_away_airnow_uses_live_current_not_history(client, monkeypatch):
    # AirNow's *historical* endpoint (the chart) collapses each hour to one
    # dominant AQI with no per-pollutant breakdown -- current conditions calls
    # the live current-observation endpoint directly instead (same one Home's
    # AirNow reading uses), so it shows a full pollutant breakdown like every
    # other provider rather than a bare headline number.
    monkeypatch.setenv("AIRNOW_API_KEY", "k")
    monkeypatch.setattr(home_config, "get_away",
                        lambda: {"zip": "60601", "lat": 41.8, "lon": -87.6, "reporting_area": "Chicago"})
    monkeypatch.setattr(away.airnow, "get_current_observation", lambda zip_code: {
        "aqi": 172, "category": "Unhealthy", "band": "bad", "dominant_pollutant": "O3",
        "reporting_area": "Chicago, IL", "observed_hour": 14,
        "pollutants": [{"parameter": "O3", "aqi": 172, "category": "Unhealthy"}],
    })
    res = client.get("/api/outside?provider=airnow&mode=away")
    assert res.status_code == 200
    body = res.get_json()
    assert body["aqi"] == 172
    assert body["pollutants"] == [{"parameter": "O3", "aqi": 172, "category": "Unhealthy"}]


def test_outside_away_airnow_no_data_is_404(client, monkeypatch):
    monkeypatch.setenv("AIRNOW_API_KEY", "k")
    monkeypatch.setattr(home_config, "get_away",
                        lambda: {"zip": "60601", "lat": 41.8, "lon": -87.6, "reporting_area": "Chicago"})
    monkeypatch.setattr(away.airnow, "get_current_observation", lambda zip_code: None)
    res = client.get("/api/outside?provider=airnow&mode=away")
    assert res.status_code == 404


def test_outside_away_missing_key_is_400(client, monkeypatch):
    monkeypatch.setattr(home_config, "get_away",
                        lambda: {"zip": "60601", "lat": 41.8, "lon": -87.6, "reporting_area": "Chicago"})
    monkeypatch.delenv("GOOGLE_AQ_API_KEY", raising=False)
    res = client.get("/api/outside?provider=google&mode=away")
    assert res.status_code == 400
    assert "configured" in res.get_json()["error"]


def test_outside_away_happy_path(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_AQ_API_KEY", "k")
    monkeypatch.setattr(home_config, "get_away",
                        lambda: {"zip": "60601", "lat": 41.8, "lon": -87.6, "reporting_area": "Chicago"})
    monkeypatch.setattr(away, "current", lambda provider, loc: {
        "aqi": 42, "band": "good", "category": "Good", "dominant_pollutant": "PM2.5",
        "reporting_area": loc["reporting_area"], "observed_hour": None, "time": "t", "pollutants": [],
    })
    res = client.get("/api/outside?provider=google&mode=away")
    assert res.status_code == 200
    assert res.get_json()["reporting_area"] == "Chicago"


def test_outside_all_away_covers_every_provider(client, monkeypatch):
    monkeypatch.setenv("AIRNOW_API_KEY", "k")
    monkeypatch.setenv("GOOGLE_AQ_API_KEY", "k")
    monkeypatch.setenv("OWM_API_KEY", "k")
    monkeypatch.setenv("PURPLEAIR_API_KEY", "k")
    monkeypatch.setattr(home_config, "get_away", lambda: None)
    res = client.get("/api/outside/all?mode=away")
    assert res.status_code == 200
    body = res.get_json()
    assert set(body.keys()) == {"airnow", "google", "purpleair", "openweathermap"}
    assert all(v == {"available": False, "reason": "no away location set"} for v in body.values())


def test_outside_history_away_trims_to_hours(client, monkeypatch):
    from datetime import UTC, datetime, timedelta
    monkeypatch.setenv("GOOGLE_AQ_API_KEY", "k")
    monkeypatch.setattr(home_config, "get_away",
                        lambda: {"zip": "60601", "lat": 41.8, "lon": -87.6, "reporting_area": "Chicago"})
    now = datetime.now(UTC)
    old = (now - timedelta(days=5)).isoformat()
    recent = (now - timedelta(hours=1)).isoformat()
    monkeypatch.setattr(away, "history", lambda provider, loc, days, force=False: {
        "points": [{"time": old, "aqi": 1}, {"time": recent, "aqi": 2}],
    })
    res = client.get("/api/outside/history?provider=google&mode=away&hours=24")
    assert res.status_code == 200
    points = res.get_json()
    assert points == [{"time": recent, "aqi": 2}]


def test_outside_away_repeated_requests_share_one_upstream_call(client, monkeypatch):
    # A page refresh (or the current-conditions card and the history chart
    # both loading) must not re-hit the provider -- away.history's 1h TTL
    # cache is shared across every mode=away route, keyed regardless of
    # which endpoint asks first.
    # The real .env is loaded into os.environ at app import time -- explicitly
    # unset the other providers' keys so a mistake here can't quietly fall
    # through to a real network call the way it did until this was caught.
    monkeypatch.setenv("GOOGLE_AQ_API_KEY", "k")
    monkeypatch.delenv("AIRNOW_API_KEY", raising=False)
    monkeypatch.delenv("OWM_API_KEY", raising=False)
    monkeypatch.delenv("PURPLEAIR_API_KEY", raising=False)
    monkeypatch.setattr(home_config, "get_away",
                        lambda: {"zip": "60601", "lat": 41.8, "lon": -87.6, "reporting_area": "Chicago"})
    calls = []
    monkeypatch.setattr(away.google_aq, "get_away_history", lambda lat, lon, days: (
        calls.append(1) or [{"time": "2026-07-20T10:00:00Z", "aqi": 42, "pm2_5_ugm3": 12.0}]
    ))
    away._cache = away.aq_shared.TTLCache(away.CACHE_TTL_S)

    assert client.get("/api/outside?provider=google&mode=away").status_code == 200
    assert client.get("/api/outside?provider=google&mode=away").status_code == 200
    assert client.get("/api/outside/history?provider=google&mode=away&hours=24").status_code == 200
    assert client.get("/api/outside/all?mode=away").status_code == 200

    assert len(calls) == 1  # every request above served from the one cache entry


def test_forecast_zip_resolves_away_location(client, monkeypatch):
    monkeypatch.setenv("GOOGLE_AQ_API_KEY", "k")
    monkeypatch.setattr(home_config, "get_away",
                        lambda: {"zip": "60601", "lat": 41.8, "lon": -87.6, "reporting_area": "Chicago"})
    seen = {}

    # get_forecast itself is captured by reference into app.py's
    # _LIVE_FORECAST_PROVIDERS at import time, so patching it here wouldn't
    # reach that call site -- patch the worker it calls through its cache
    # instead (same as the away-history tests patch each provider's private
    # HTTP call rather than its public wrapper).
    def fake_fetch_forecast(lat, lon):
        seen["lat"], seen["lon"] = lat, lon
        return {"days": []}

    monkeypatch.setattr(google_aq, "_fetch_forecast", fake_fetch_forecast)
    res = client.get("/api/forecast?zip=60601&provider=google")
    assert res.status_code == 200
    assert seen == {"lat": 41.8, "lon": -87.6}
    assert res.get_json()["reporting_area"] == "Chicago"
