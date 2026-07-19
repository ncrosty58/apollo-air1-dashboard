import logging
import os

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request, send_from_directory

import airnow
import influx
import locations as locations_store
import mqtt_bridge

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


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/forecast")
def forecast_page():
    return render_template("forecast.html")


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


OUTSIDE_POLLUTANT_LABELS = {
    "o3_aqi": "O3",
    "pm2_5_aqi": "PM2.5",
    "pm10_aqi": "PM10",
    "no2_aqi": "NO2",
}


@app.route("/api/outside")
def api_outside():
    # Node-RED already polls AirNow for the home zip and logs it to
    # InfluxDB (for the history charts) — read that instead of making our
    # own separate, redundant AirNow request for the same current reading.
    try:
        row = influx.query_outside_latest()
    except Exception:
        logging.exception("Failed to query outdoor reading from InfluxDB")
        return jsonify({"error": "influxdb query failed"}), 502
    if row is None:
        return jsonify({"error": "no data for this location"}), 404

    aqi = row.get("aqi")
    pollutants = [
        {"parameter": label, "aqi": row[field]}
        for field, label in OUTSIDE_POLLUTANT_LABELS.items()
        if isinstance(row.get(field), (int, float))
    ]
    return jsonify({
        "aqi": aqi,
        "band": airnow.band_for_aqi(aqi),
        "category": row.get("category"),
        "dominant_pollutant": row.get("dominant_pollutant"),
        "reporting_area": row.get("reporting_area"),
        "time": row.get("time"),
        "pollutants": pollutants,
    })


@app.route("/api/outside/history")
def api_outside_history():
    try:
        hours = int(request.args.get("hours", 24))
    except ValueError:
        hours = 24
    hours = max(1, min(hours, 168))
    try:
        points = influx.query_outside_history(hours)
    except Exception:
        logging.exception("Failed to query outdoor history from InfluxDB")
        return jsonify({"error": "influxdb query failed"}), 502
    return jsonify(points)


@app.route("/api/forecast")
def api_forecast():
    zip_code = request.args.get("zip") or os.environ["AIRNOW_ZIP"]
    if not locations_store.ZIP_RE.match(zip_code):
        return jsonify({"error": "zip must be 5 digits"}), 400
    try:
        data = airnow.get_forecast(zip_code)
    except Exception:
        logging.exception("Failed to fetch forecast from AirNow")
        return jsonify({"error": "airnow request failed"}), 502
    if data is None:
        return jsonify({"error": "no forecast for this location"}), 404
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

    result = locations_store.add_location(label, zip_code)
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
