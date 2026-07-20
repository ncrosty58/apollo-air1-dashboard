"""Route-level tests for app.py: the error-status mapping (InfluxDB failure ->
502, no data -> 404, bad input -> 400) and the MQTT-unavailable 503 guard on
the control endpoints. Upstream/DB calls are monkeypatched -- no network or
InfluxDB is touched."""
import pytest

import app as app_module
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
