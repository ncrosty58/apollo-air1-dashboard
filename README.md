# Apollo AIR-1 Dashboard

Small Flask app that reads Apollo AIR-1 air quality readings out of InfluxDB
(bucket `air_quality`, written there by the `Apollo AIR-1` tab in
[coslab-nodered-flows](../coslab-nodered-flows)) and renders current values +
history charts. No Home Assistant, no Grafana — self-contained.

```
Apollo AIR-1  -->  mosquitto  -->  Node-RED  -->  InfluxDB (air_quality)  -->  this app
```

## Stack

Flask + a hand-rolled SVG line chart (no JS framework, no CDN dependency) for
current-value tiles and CO2 / particulate / VOC-NOx / temperature / humidity
history, plus a plain table for the MICS-4514 gas sensor readings and device
diagnostics (WiFi RSSI, uptime, firmware version).

## Running

```
cp .env.example .env    # fill in INFLUX_TOKEN — see below
docker compose up -d --build
```

Then open `http://<host>:5960`.

For local dev without Docker:
```
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # fill in INFLUX_TOKEN
python app.py
```

## InfluxDB token

`INFLUX_TOKEN` should be a **read-only** token scoped to the `air_quality`
bucket, not the admin token used by the `iot` stack — this app only ever
reads. One was generated when this repo was created; if it needs to be
rotated, create a new one in the InfluxDB UI (`http://192.168.4.113:8086`,
org `cosmoslab`) under *Load Data → API Tokens*, scoped to
read-only on `air_quality`.

## API

- `GET /api/latest` — most recent reading as flat JSON.
- `GET /api/history?hours=24` — time series for all fields over the given
  window (1–168h), used by the charts.

## Related repos

- [`apollo-air1-mqtt-esphome`](../apollo-air1-mqtt-esphome) — the ESPHome
  firmware and MQTT payload schema.
- [`coslab-nodered-flows`](../coslab-nodered-flows) — the flow that writes
  into `air_quality`.
