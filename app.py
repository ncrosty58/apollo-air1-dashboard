import logging
import os

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_from_directory

import airnow
import google_aq
import influx
import locations as locations_store
import mqtt_bridge
import owm
import purpleair

load_dotenv()

logging.basicConfig(level=logging.INFO)

app = Flask(__name__)

PORT = int(os.environ.get("PORT", 5858))
HOST = os.environ.get("HOST", "0.0.0.0")
DEBUG = os.environ.get("DEBUG", "False").lower() in ("true", "1", "t")

NUMBER_BOUNDS = {
    mqtt_bridge.SLEEP_DURATION: (0, 800),
    mqtt_bridge.SEN55_TEMPERATURE_OFFSET: (-70, 70),
    mqtt_bridge.SEN55_HUMIDITY_OFFSET: (-70, 70),
    mqtt_bridge.DPS310_PRESSURE_OFFSET: (-100, 100),
}
BUTTON_IDS = {
    mqtt_bridge.CALIBRATE_SCD40,
    mqtt_bridge.CLEAN_SEN55,
    mqtt_bridge.ESP_REBOOT,
    mqtt_bridge.FACTORY_RESET,
}

# Flask's debug reloader re-execs the process in a child with WERKZEUG_RUN_MAIN
# set; only start the MQTT client in the process that's actually serving.
if not DEBUG or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
    mqtt_bridge.start()


@app.context_processor
def inject_links():
    # Optional external link to the Grafana provider-comparison dashboard, shown
    # only on the Technical/Indoor pages (it sits behind Cloudflare Access, so
    # it's not for the family-facing Simple view). Unset -> link is omitted.
    return {"grafana_url": os.environ.get("GRAFANA_DASHBOARD_URL", "")}


@app.route("/healthz")
def healthz():
    # Liveness only -- deliberately does NOT touch InfluxDB or MQTT, so an
    # upstream outage doesn't make the container look dead and get killed. It
    # reports the MQTT link state as a hint without gating health on it.
    return jsonify({"status": "ok", "mqtt_connected": mqtt_bridge.available()})


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/forecast")
def forecast_page():
    return render_template("forecast.html")


@app.route("/technical")
def technical_page():
    return render_template("technical.html")


@app.route("/indoor")
def indoor_page():
    return render_template("indoor.html")


@app.route("/manifest.webmanifest")
def manifest():
    return send_from_directory(app.static_folder, "manifest.webmanifest", mimetype="application/manifest+json")


@app.route("/sw.js")
def service_worker():
    # Served from the root (not /static/sw.js) so its default scope covers the whole app.
    return send_from_directory(app.static_folder, "sw.js", mimetype="application/javascript")


@app.route("/api/latest")
def api_latest():
    try:
        row = influx.query_latest()
    except Exception:
        logging.exception("Failed to query latest reading from InfluxDB")
        return jsonify({"error": "influxdb query failed"}), 502
    if row is None:
        return jsonify({"error": "no data yet"}), 404
    return jsonify(row)


@app.route("/api/history")
def api_history():
    try:
        hours = int(request.args.get("hours", 24))
    except ValueError:
        hours = 24
    hours = max(1, min(hours, 168))
    try:
        points = influx.query_history(hours)
    except Exception:
        logging.exception("Failed to query history from InfluxDB")
        return jsonify({"error": "influxdb query failed"}), 502
    return jsonify(points)


def _resolve_home_latlon():
    """Google's/OWM's forecast APIs need coordinates, not a zip -- AirNow's
    own response for the home zip already resolved that, so reuse its
    (cached) call instead of adding a separate geocoding dependency. Only the
    live forecast path needs this now; current conditions read the home label
    from the DB (see _home_reporting_area)."""
    try:
        obs = airnow.get_current_observation(os.environ["AIRNOW_ZIP"])
    except Exception:
        return None, None, None
    if obs is None or obs.get("lat") is None:
        return None, None, None
    return obs["lat"], obs["lon"], obs.get("reporting_area") or "Home"


def _home_reporting_area():
    """The home reporting-area label for provider cards that don't carry
    their own (Google/OpenWeatherMap). Read from AirNow's stored reading in
    InfluxDB rather than a live AirNow call, so a current-conditions view
    never depends on hitting an upstream API. Falls back to "Home" if AirNow
    hasn't been polled into the DB yet."""
    try:
        row = influx.query_airnow_latest()
    except Exception:
        logging.exception("Failed to read AirNow home label from InfluxDB")
        return "Home"
    if row and row.get("reporting_area"):
        return row["reporting_area"]
    return "Home"


def _resolve_latlon_for_zip(zip_code):
    if zip_code == os.environ["AIRNOW_ZIP"]:
        return _resolve_home_latlon()
    for loc in locations_store.list_locations():
        if loc["zip"] != zip_code:
            continue
        if loc.get("lat") is not None:
            return loc["lat"], loc["lon"], loc["label"]
        # Saved before this lat/lon capture existed -- backfill from AirNow's
        # (cached) forecast lookup rather than making the user re-add it.
        try:
            forecast = airnow.get_forecast(zip_code)
        except Exception:
            return None, None, None
        if forecast and forecast.get("lat") is not None:
            return forecast["lat"], forecast["lon"], loc["label"]
        return None, None, None
    return None, None, None


def _read_from_db(fetch, label, missing_msg):
    """Run a provider's DB read and map it to (data, error, status): a query
    exception -> 502, no data -> 404 with the provider's own hint, otherwise
    (data, None, 200). Collapses the identical boilerplate every provider's
    current-conditions read used to repeat."""
    try:
        data = fetch()
    except Exception:
        logging.exception("Failed to read %s from InfluxDB", label)
        return None, "influxdb query failed", 502
    if data is None:
        return None, missing_msg, 404
    return data, None, 200


# provider -> (fetch, log label, 404 hint). All read current conditions back
# from InfluxDB (Node-RED polls every provider in); AirNow is the default.
_CURRENT_READERS = {
    "google": (google_aq.get_current_observation, "Google air quality",
               "no Google air quality data yet — is GOOGLE_AQ_API_KEY set on the nodered container?"),
    "purpleair": (purpleair.get_current_observation, "PurpleAir",
                  "no PurpleAir data yet — is PURPLEAIR_API_KEY set on the nodered container?"),
    "openweathermap": (owm.get_current_observation, "OpenWeatherMap pollution",
                       "no OpenWeatherMap pollution data yet — is OWM_API_KEY set on the nodered container?"),
    "airnow": (lambda: airnow.observation_from_row(influx.query_airnow_latest()), "AirNow",
               "no AirNow data yet — is AIRNOW_API_KEY set on the nodered container?"),
}
# Providers whose reading carries no reporting-area of its own -> stamp the
# shared home label (from AirNow's stored reading).
_NEEDS_HOME_LABEL = {"google", "openweathermap"}


def _fetch_outside_current(provider, *, want_discussion=True, home_label=None):
    """Returns (data, error_message, http_status). data is None on error.

    want_discussion=False skips the live AirNow forecast-discussion fetch, for
    callers (the /api/outside/all chip summary) that don't render it.
    home_label lets a caller resolve the shared home label once and pass it in
    rather than each provider re-querying it."""
    fetch, label, missing_msg = _CURRENT_READERS.get(provider, _CURRENT_READERS["airnow"])
    data, error, status = _read_from_db(fetch, label, missing_msg)
    if data is None:
        return data, error, status

    if provider in _NEEDS_HOME_LABEL:
        data["reporting_area"] = home_label if home_label is not None else _home_reporting_area()

    if want_discussion and provider == "airnow":
        # AirNow's forecaster discussion only exists on the forecast endpoint,
        # not current conditions, and the forecast isn't persisted -- reuse
        # get_forecast's own cache (already hit by the Forecast page, the one
        # sanctioned live AirNow call) rather than a separate lookup. Best-
        # effort: a forecast hiccup shouldn't take down the current reading.
        try:
            forecast = airnow.get_forecast(os.environ["AIRNOW_ZIP"])
            data["discussion"] = forecast.get("discussion") if forecast else None
        except Exception:
            logging.exception("Failed to fetch forecast discussion from AirNow")
            data["discussion"] = None
    return data, None, 200


@app.route("/api/outside")
def api_outside():
    provider = request.args.get("provider", "airnow")
    data, error, status = _fetch_outside_current(provider)
    if data is None:
        return jsonify({"error": error}), status
    return jsonify(data)


@app.route("/api/outside/all")
def api_outside_all():
    """Compact current summary from every provider at once, for the
    at-a-glance provider chips. Each is best-effort and served from the
    same caches the full endpoint uses, so this costs no extra upstream
    calls beyond what browsing the providers individually would."""
    summary = {}
    # Resolve the shared home label once rather than per-provider, and skip the
    # AirNow discussion fetch entirely -- the chips only show aqi/band/category.
    home_label = _home_reporting_area()
    for provider in ("airnow", "google", "purpleair", "openweathermap"):
        data, error, _ = _fetch_outside_current(provider, want_discussion=False, home_label=home_label)
        if data is None:
            summary[provider] = {"available": False, "reason": error}
        else:
            summary[provider] = {
                "available": True,
                "aqi": data.get("aqi"),
                "band": data.get("band"),
                "category": data.get("category"),
                "dominant_pollutant": data.get("dominant_pollutant"),
            }
    return jsonify(summary)


def _with_outside_weather(points, hours):
    """Outside temperature/humidity/pressure comes from neither AirNow nor
    Google (neither API provides weather) -- it's a separate feed the user
    writes into the same InfluxDB measurement. Merged in as extra points
    (not matched to existing timestamps) since the frontend's per-field
    lookup only cares that a point has the field, not which point. Best-
    effort: a user who hasn't wired that feed up yet, or a query hiccup,
    should still get pollutant history back.
    """
    try:
        return points + influx.query_outside_weather(hours)
    except Exception:
        logging.exception("Failed to fetch outside weather from InfluxDB")
        return points


# provider -> (history reader, config env var or None, config label, log label).
# All read pollutant history back from InfluxDB; the per-pollutant temp/
# humidity/pressure always comes from the shared outside-weather feed merged in
# by _with_outside_weather (PurpleAir/OWM/Google don't persist their own).
# AirNow is the default and reads the bare (unprefixed) fields directly.
_HISTORY_READERS = {
    "google": (google_aq.get_history, "GOOGLE_AQ_API_KEY", "Google Air Quality",
               "Failed to read Google history from InfluxDB"),
    "purpleair": (purpleair.get_history, None, None,
                  "Failed to read PurpleAir history from InfluxDB"),
    "openweathermap": (owm.get_history, None, None,
                       "Failed to read OpenWeatherMap history from InfluxDB"),
}


@app.route("/api/outside/history")
def api_outside_history():
    try:
        hours = int(request.args.get("hours", 24))
    except ValueError:
        hours = 24
    hours = max(1, min(hours, 168))
    provider = request.args.get("provider", "airnow")

    reader = _HISTORY_READERS.get(provider)
    if reader is not None:
        fetch, env_key, cfg_label, log_label = reader
        if env_key and not os.environ.get(env_key):
            return jsonify({"error": f"{cfg_label} isn't configured"}), 400
    else:
        fetch, log_label = influx.query_outside_history, "Failed to query outdoor history from InfluxDB"

    try:
        points = fetch(hours)
    except Exception:
        logging.exception(log_label)
        return jsonify({"error": "influxdb query failed"}), 502
    return jsonify(_with_outside_weather(points, hours))


# provider -> (live forecast fetch(lat, lon, force), config env var, config
# label, upstream-failure message). These are the two on-demand live forecast
# providers -- both need coordinates (not a zip) and both stamp the resolved
# home/location label onto the response. AirNow (the default) is handled
# separately below: it forecasts by zip and carries its own reporting area.
_LIVE_FORECAST_PROVIDERS = {
    "google": (google_aq.get_forecast, "GOOGLE_AQ_API_KEY", "Google Air Quality",
               "google air quality request failed"),
    "openweathermap": (owm.get_forecast, "OWM_API_KEY", "OpenWeatherMap",
                       "openweathermap request failed"),
}


@app.route("/api/forecast")
def api_forecast():
    zip_code = request.args.get("zip") or os.environ["AIRNOW_ZIP"]
    if not locations_store.ZIP_RE.match(zip_code):
        return jsonify({"error": "zip must be 5 digits"}), 400
    provider = request.args.get("provider", "airnow")
    force = request.args.get("refresh") in ("1", "true")

    live = _LIVE_FORECAST_PROVIDERS.get(provider)
    if live is not None:
        fetch, env_key, cfg_label, fail_msg = live
        if not os.environ.get(env_key):
            return jsonify({"error": f"{cfg_label} isn't configured"}), 400
        lat, lon, label = _resolve_latlon_for_zip(zip_code)
        if lat is None:
            return jsonify({"error": "couldn't resolve coordinates for that zip"}), 502
        try:
            data = fetch(lat, lon, force=force)
        except Exception:
            logging.exception("Failed to fetch forecast from %s", cfg_label)
            return jsonify({"error": fail_msg}), 502
        if data is None:
            return jsonify({"error": "no forecast for this location"}), 404
        data["reporting_area"] = label
        data["provider"] = provider
        return jsonify(data)

    try:
        data = airnow.get_forecast(zip_code, force=force)
    except Exception:
        logging.exception("Failed to fetch forecast from AirNow")
        return jsonify({"error": "airnow request failed"}), 502
    if data is None:
        return jsonify({"error": "no forecast for this location"}), 404
    data["provider"] = "airnow"
    return jsonify(data)


@app.route("/api/locations")
def api_locations():
    return jsonify(locations_store.list_locations())


@app.route("/api/locations", methods=["POST"])
def api_locations_add():
    body = request.get_json(silent=True) or {}
    try:
        label, zip_code = locations_store.validate_new(body.get("label"), body.get("zip"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    # Confirm AirNow actually has forecast coverage for this zip before
    # saving it — otherwise it'd sit in the list failing every time it's
    # selected (this is exactly how the 54554 zip broke).
    try:
        forecast = airnow.get_forecast(zip_code)
    except Exception:
        logging.exception("Failed to verify forecast for new location zip=%s", zip_code)
        return jsonify({"error": "couldn't reach AirNow to verify that zip"}), 502
    if forecast is None:
        return jsonify({"error": "AirNow doesn't have forecast data for that zip"}), 400

    # AirNow's own response already resolved this zip to a lat/lon -- grab
    # it now so the Google provider can use this location later without a
    # separate geocoding call/dependency.
    result = locations_store.add_location(label, zip_code, forecast.get("lat"), forecast.get("lon"))
    return jsonify(result)


@app.route("/api/locations/<zip_code>", methods=["DELETE"])
def api_locations_delete(zip_code):
    try:
        result = locations_store.remove_location(zip_code)
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
    return jsonify(result)


@app.route("/api/controls")
def api_controls():
    return jsonify(mqtt_bridge.get_state())


def _mqtt_unavailable_response():
    """Shared 503 for the mutating control routes when the MQTT client never
    came up (broker down at boot). Keeps them from dereferencing a None client
    and 500ing with an AttributeError."""
    if mqtt_bridge.available():
        return None
    return jsonify({"error": "device control is unavailable — MQTT broker not connected"}), 503


@app.route("/api/control/switch/<object_id>", methods=["POST"])
def api_control_switch(object_id):
    unavailable = _mqtt_unavailable_response()
    if unavailable:
        return unavailable
    if object_id != mqtt_bridge.PREVENT_SLEEP:
        return jsonify({"error": "unknown switch"}), 404
    body = request.get_json(silent=True) or {}
    if not isinstance(body.get("state"), bool):
        return jsonify({"error": "state must be a boolean"}), 400
    mqtt_bridge.publish_switch(object_id, body["state"])
    return jsonify({"published": True})


@app.route("/api/control/number/<object_id>", methods=["POST"])
def api_control_number(object_id):
    unavailable = _mqtt_unavailable_response()
    if unavailable:
        return unavailable
    bounds = NUMBER_BOUNDS.get(object_id)
    if bounds is None:
        return jsonify({"error": "unknown number"}), 404
    body = request.get_json(silent=True) or {}
    value = body.get("value")
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return jsonify({"error": "value must be a number"}), 400
    lo, hi = bounds
    if not (lo <= value <= hi):
        return jsonify({"error": f"value must be between {lo} and {hi}"}), 400
    mqtt_bridge.publish_number(object_id, value)
    return jsonify({"published": True})


@app.route("/api/control/button/<object_id>", methods=["POST"])
def api_control_button(object_id):
    unavailable = _mqtt_unavailable_response()
    if unavailable:
        return unavailable
    if object_id not in BUTTON_IDS:
        return jsonify({"error": "unknown button"}), 404
    mqtt_bridge.publish_button(object_id)
    return jsonify({"published": True})


if __name__ == "__main__":
    app.run(host=HOST, port=PORT, debug=DEBUG)
