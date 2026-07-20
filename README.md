# Apollo AIR-1 Dashboard — Cosmos Lab

Flask app for the Apollo AIR-1 air quality sensor: current readings + history
from InfluxDB, live device controls over MQTT, and an outdoor AQI comparison
via AirNow. No Home Assistant, no Grafana — self-contained. Two views: a
plain-language **Simple** view for anyone in the house, and a **Technical**
view with full instrument readouts, calibration controls, and history charts
— reaching parity with (and extending) the device's own onboard ESPHome web
UI.

```
Apollo AIR-1  <-->  mosquitto  -->  Node-RED  -->  InfluxDB (air_quality)  -->  this app
                        ^ commands (switch/number/button)  |
                        +-----------------------------------+
AirNow API  -->  this app (outdoor AQI, cached hourly)
```

## Stack

Flask + a hand-rolled SVG line chart (no JS framework, no CDN dependency) for
current-value tiles and CO2 / particulate / VOC-NOx / temperature / humidity
history, a plain table for the MICS-4514 gas sensor readings and device
diagnostics, and a background `paho-mqtt` client (`mqtt_bridge.py`) that
mirrors the device's switches/numbers/buttons and publishes commands to them.

## Running

```
cp .env.example .env    # fill in INFLUX_TOKEN, MQTT_*, AIRNOW_* — see below
mkdir -p data && chmod 777 data   # bind-mounted; container runs as a non-root user
docker compose up -d --build
```

Then open `http://<host>:5960`.

For local dev without Docker:
```
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python app.py
```

## Credentials

- `INFLUX_TOKEN` — **read-only** token scoped to the `air_quality` bucket,
  not the admin token used by the `iot` stack. This app only ever reads from
  Influx — every provider's current reading and history (AirNow, Google,
  PurpleAir, OpenWeatherMap) is written by Node-RED (see the Apollo AIR-1
  flow), not by this app. Rotate in the InfluxDB UI
  (`http://192.168.4.113:8086`, org `cosmoslab`) under *Load Data → API
  Tokens* if it ever leaks.
- `MQTT_USERNAME` / `MQTT_PASSWORD` — mosquitto credentials for this app's
  own client (publishes commands, subscribes to state topics under
  `MQTT_TOPIC_PREFIX`). `MQTT_TOPIC_PREFIX` must match the `mqtt_topic`
  substitution in [`apollo-air1-mqtt-esphome`](../apollo-air1-mqtt-esphome)'s
  `apollo-air1-mqtt.yaml`.
- `AIRNOW_API_KEY` / `AIRNOW_ZIP` — from [docs.airnowapi.org](https://docs.airnowapi.org/),
  used for the Technical view's outdoor AQI card. Responses are cached ~55min
  in memory (AirNow itself updates hourly).

## API

- `GET /api/latest` — most recent reading as flat JSON.
- `GET /api/history?hours=24` — time series for all fields over the given
  window (1–168h), used by the charts.
- `GET /api/outside` — current outdoor AQI/category/dominant pollutant from
  AirNow for `AIRNOW_ZIP`.
- `GET /api/forecast?zip=<zip>` — AirNow's forecast for a zip (defaults to
  `AIRNOW_ZIP`). AirNow only issues forecasts for today and, where available,
  tomorrow — the response has however many days it actually published, never
  padded out to a full week.
- `GET /api/locations`, `POST /api/locations` (`{label, zip}`),
  `DELETE /api/locations/<zip>` — saved locations for the forecast switcher,
  persisted to `data/locations.json` (bind-mounted, see above, so they
  survive `docker compose up --build`).
- `GET /api/controls` — cached state of the device's switches/numbers plus
  online/offline (from its MQTT birth/LWT `status` topic).
- `POST /api/control/switch/<id>`, `/api/control/number/<id>`,
  `/api/control/button/<id>` — publish a command. The AIR-1 deep-sleeps
  between reads, so commands are **best-effort**: they're sent immediately
  but only take effect once the device is next awake and connected.

## Related repos

- [`apollo-air1-mqtt-esphome`](../apollo-air1-mqtt-esphome) — the ESPHome
  firmware and MQTT payload schema.
- [`coslab-nodered-flows`](../coslab-nodered-flows) — the flow that writes
  into `air_quality`.
