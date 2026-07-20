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
    """Google's API needs coordinates, not a zip -- AirNow's own response for
    the home zip already resolved that, so reuse its (cached) call instead
    of adding a separate geocoding dependency."""
    try:
        obs = airnow.get_current_observation(os.environ["AIRNOW_ZIP"])
    except Exception:
        return None, None, None
    if obs is None or obs.get("lat") is None:
        return None, None, None
    return obs["lat"], obs["lon"], obs.get("reporting_area") or "Home"


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


def _fetch_outside_current(provider):
    """Returns (data, error_message, http_status). data is None on error."""
    if provider == "google":
        try:
            data = google_aq.get_current_observation()
        except Exception:
            logging.exception("Failed to read Google air quality from InfluxDB")
            return None, "influxdb query failed", 502
        if data is None:
            return None, "no Google air quality data yet — is GOOGLE_AQ_API_KEY set on the nodered container?", 404
        _, _, label = _resolve_home_latlon()
        data["reporting_area"] = label or "Home"
        return data, None, 200

    if provider == "purpleair":
        try:
            data = purpleair.get_current_observation()
        except Exception:
            logging.exception("Failed to read PurpleAir from InfluxDB")
            return None, "influxdb query failed", 502
        if data is None:
            return None, "no PurpleAir data yet — is PURPLEAIR_API_KEY set on the nodered container?", 404
        return data, None, 200

    if provider == "openweathermap":
        try:
            data = owm.get_current_observation()
        except Exception:
            logging.exception("Failed to read OpenWeatherMap pollution from InfluxDB")
            return None, "influxdb query failed", 502
        if data is None:
            return None, "no OpenWeatherMap pollution data yet — is OWM_API_KEY set on the nodered container?", 404
        _, _, label = _resolve_home_latlon()
        data["reporting_area"] = label or "Home"
        return data, None, 200

    try:
        data = airnow.get_current_observation(os.environ["AIRNOW_ZIP"])
    except Exception:
        logging.exception("Failed to fetch outdoor reading from AirNow")
        return None, "airnow request failed", 502
    if data is None:
        return None, "no data for this location", 404

    # AirNow's forecaster discussion only exists on the forecast endpoint,
    # not current conditions -- reuse get_forecast's own cache (already hit
    # by the Forecast page) rather than a separate lookup. Best-effort: a
    # forecast hiccup shouldn't take down the current-conditions reading.
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
    for provider in ("airnow", "google", "purpleair", "openweathermap"):
        data, error, _ = _fetch_outside_current(provider)
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


@app.route("/api/outside/history")
def api_outside_history():
    try:
        hours = int(request.args.get("hours", 24))
    except ValueError:
        hours = 24
    hours = max(1, min(hours, 168))
    provider = request.args.get("provider", "airnow")

    if provider == "google":
        if not os.environ.get("GOOGLE_AQ_API_KEY"):
            return jsonify({"error": "Google Air Quality isn't configured"}), 400
        try:
            points = google_aq.get_history(hours)
        except Exception:
            logging.exception("Failed to read Google history from InfluxDB")
            return jsonify({"error": "influxdb query failed"}), 502
        return jsonify(_with_outside_weather(points, hours))

    if provider == "purpleair":
        try:
            points = purpleair.get_history(hours)
        except Exception:
            logging.exception("Failed to read PurpleAir history from InfluxDB")
            return jsonify({"error": "influxdb query failed"}), 502
        # PurpleAir's own temp/humidity/pressure ride along with its current
        # reading but aren't persisted to Influx (out of scope for the
        # pollutant history this stores) -- the outside-weather merge fills
        # temp/humidity/pressure in from the shared feed instead.
        return jsonify(_with_outside_weather(points, hours))

    if provider == "openweathermap":
        try:
            points = owm.get_history(hours)
        except Exception:
            logging.exception("Failed to read OpenWeatherMap history from InfluxDB")
            return jsonify({"error": "influxdb query failed"}), 502
        return jsonify(_with_outside_weather(points, hours))

    try:
        points = influx.query_outside_history(hours)
    except Exception:
        logging.exception("Failed to query outdoor history from InfluxDB")
        return jsonify({"error": "influxdb query failed"}), 502
    return jsonify(_with_outside_weather(points, hours))


@app.route("/api/forecast")
def api_forecast():
    zip_code = request.args.get("zip") or os.environ["AIRNOW_ZIP"]
    if not locations_store.ZIP_RE.match(zip_code):
        return jsonify({"error": "zip must be 5 digits"}), 400
    provider = request.args.get("provider", "airnow")
    force = request.args.get("refresh") in ("1", "true")

    if provider == "google":
        if not os.environ.get("GOOGLE_AQ_API_KEY"):
            return jsonify({"error": "Google Air Quality isn't configured"}), 400
        lat, lon, label = _resolve_latlon_for_zip(zip_code)
        if lat is None:
            return jsonify({"error": "couldn't resolve coordinates for that zip"}), 502
        try:
            data = google_aq.get_forecast(lat, lon, force=force)
        except Exception:
            logging.exception("Failed to fetch forecast from Google")
            return jsonify({"error": "google air quality request failed"}), 502
        if data is None:
            return jsonify({"error": "no forecast for this location"}), 404
        data["reporting_area"] = label
        data["provider"] = "google"
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


@app.route("/api/control/switch/<object_id>", methods=["POST"])
def api_control_switch(object_id):
    if object_id != mqtt_bridge.PREVENT_SLEEP:
        return jsonify({"error": "unknown switch"}), 404
    body = request.get_json(silent=True) or {}
    if not isinstance(body.get("state"), bool):
        return jsonify({"error": "state must be a boolean"}), 400
    mqtt_bridge.publish_switch(object_id, body["state"])
    return jsonify({"published": True})


@app.route("/api/control/number/<object_id>", methods=["POST"])
def api_control_number(object_id):
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
    if object_id not in BUTTON_IDS:
        return jsonify({"error": "unknown button"}), 404
    mqtt_bridge.publish_button(object_id)
    return jsonify({"published": True})


if __name__ == "__main__":
    app.run(host=HOST, port=PORT, debug=DEBUG)
