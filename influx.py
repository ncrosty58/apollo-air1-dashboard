import os

from influxdb_client import InfluxDBClient, Point
from influxdb_client.client.write_api import SYNCHRONOUS

MEASUREMENT = "air_quality"

FIELDS = [
    "co2_ppm", "pressure_hpa", "temperature_c", "humidity_pct",
    "pm1_0_ugm3", "pm2_5_ugm3", "pm4_0_ugm3", "pm10_0_ugm3",
    "voc_index", "nox_index", "aqi",
    "nitrogen_dioxide_ppm", "carbon_monoxide_ppm", "hydrogen_ppm",
    "ethanol_ppm", "methane_ppm", "ammonia_ppm",
    "wifi_rssi_db", "esp_temperature_c", "uptime_s",
]
STRING_FIELDS = ["voc_quality", "firmware_version"]

_client = None


def get_client():
    global _client
    if _client is None:
        _client = InfluxDBClient(
            url=os.environ["INFLUX_URL"],
            token=os.environ["INFLUX_TOKEN"],
            org=os.environ["INFLUX_ORG"],
        )
    return _client


def _field_filter():
    all_fields = FIELDS + STRING_FIELDS
    return " or ".join(f'r._field == "{f}"' for f in all_fields)


def _rows_from(tables):
    points = []
    for table in tables:
        for record in table.records:
            row = dict(record.values)
            row["time"] = record.get_time().isoformat()
            for key in ("result", "table", "_start", "_stop", "_measurement", "_time"):
                row.pop(key, None)
            points.append(row)
    return points


def query_latest():
    bucket = os.environ["INFLUX_BUCKET"]
    flux = f'''
    from(bucket: "{bucket}")
      |> range(start: -7d)
      |> filter(fn: (r) => r._measurement == "{MEASUREMENT}")
      |> filter(fn: (r) => {_field_filter()})
      |> last()
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
    '''
    tables = get_client().query_api().query(flux)
    for table in tables:
        for record in table.records:
            row = dict(record.values)
            row["time"] = record.get_time().isoformat()
            for key in ("result", "table", "_start", "_stop", "_measurement", "_time"):
                row.pop(key, None)
            return row
    return None


def query_history(hours):
    bucket = os.environ["INFLUX_BUCKET"]
    flux = f'''
    from(bucket: "{bucket}")
      |> range(start: -{hours}h)
      |> filter(fn: (r) => r._measurement == "{MEASUREMENT}")
      |> filter(fn: (r) => {_field_filter()})
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"])
    '''
    return _rows_from(get_client().query_api().query(flux))


OUTSIDE_MEASUREMENT = "outside_air_quality"
OUTSIDE_FIELDS = ["aqi", "o3_aqi", "pm2_5_aqi", "pm10_aqi", "no2_aqi"]
OUTSIDE_STRING_FIELDS = ["category", "dominant_pollutant", "reporting_area"]


def query_outside_history(hours):
    bucket = os.environ["INFLUX_BUCKET"]
    all_fields = OUTSIDE_FIELDS + OUTSIDE_STRING_FIELDS
    field_filter = " or ".join(f'r._field == "{f}"' for f in all_fields)
    flux = f'''
    from(bucket: "{bucket}")
      |> range(start: -{hours}h)
      |> filter(fn: (r) => r._measurement == "{OUTSIDE_MEASUREMENT}")
      |> filter(fn: (r) => {field_filter})
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"])
    '''
    return _rows_from(get_client().query_api().query(flux))


# Outside temperature/humidity/pressure -- not from AirNow or Google (neither
# gives weather), but from a separate feed written into this same
# measurement. Queried on its own, rather than folded into OUTSIDE_FIELDS,
# so pulling it in doesn't also drag in whichever AQI provider's pollutant
# fields happen to share the measurement.
OUTSIDE_WEATHER_FIELDS = ["temperature_c", "humidity_pct", "pressure_hpa"]

# OpenWeatherMap air_pollution components, written by Node-RED with an owm_
# prefix precisely so they stay separable from AirNow's fields in the same
# measurement (see the Apollo AIR-1 Node-RED tab).
OWM_FIELDS = [
    "owm_aqi_index", "owm_pm2_5_ugm3", "owm_pm10_ugm3", "owm_o3_ugm3",
    "owm_no2_ugm3", "owm_so2_ugm3", "owm_co_ugm3", "owm_nh3_ugm3",
]


def _owm_field_filter():
    return " or ".join(f'r._field == "{f}"' for f in OWM_FIELDS)


def query_owm_latest():
    bucket = os.environ["INFLUX_BUCKET"]
    flux = f'''
    from(bucket: "{bucket}")
      |> range(start: -6h)
      |> filter(fn: (r) => r._measurement == "{OUTSIDE_MEASUREMENT}")
      |> filter(fn: (r) => {_owm_field_filter()})
      |> last()
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
    '''
    rows = _rows_from(get_client().query_api().query(flux))
    return rows[-1] if rows else None


def query_owm_history(hours):
    bucket = os.environ["INFLUX_BUCKET"]
    flux = f'''
    from(bucket: "{bucket}")
      |> range(start: -{hours}h)
      |> filter(fn: (r) => r._measurement == "{OUTSIDE_MEASUREMENT}")
      |> filter(fn: (r) => {_owm_field_filter()})
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"])
    '''
    return _rows_from(get_client().query_api().query(flux))


def query_outside_weather(hours):
    bucket = os.environ["INFLUX_BUCKET"]
    field_filter = " or ".join(f'r._field == "{f}"' for f in OUTSIDE_WEATHER_FIELDS)
    flux = f'''
    from(bucket: "{bucket}")
      |> range(start: -{hours}h)
      |> filter(fn: (r) => r._measurement == "{OUTSIDE_MEASUREMENT}")
      |> filter(fn: (r) => {field_filter})
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"])
    '''
    return _rows_from(get_client().query_api().query(flux))


# Google and PurpleAir are read live from their own APIs (google_aq.py /
# purpleair.py), unlike AirNow/OWM which Node-RED polls on a timer straight
# into Influx -- so their *history* has to come from somewhere. Rather than
# calling each vendor's own history endpoint (extra API spend, and a
# different retention/grain per vendor), every live reading the dashboard
# actually fetches gets written here too, so History for all four providers
# ends up sourced the same way: this bucket. Prefixed field names follow the
# same collision-avoidance precedent as OWM_FIELDS above.
GOOGLE_FIELDS = [
    "google_aqi", "google_pm2_5_ugm3", "google_pm10_ugm3",
    "google_o3_ppb", "google_no2_ppb", "google_so2_ppb", "google_co_ppb",
]
GOOGLE_STRING_FIELDS = ["google_category", "google_dominant_pollutant"]

PURPLEAIR_FIELDS = ["purpleair_aqi", "purpleair_pm2_5_ugm3", "purpleair_pm10_ugm3"]
PURPLEAIR_STRING_FIELDS = ["purpleair_category", "purpleair_dominant_pollutant"]

_write_api = None


def get_write_api():
    global _write_api
    if _write_api is None:
        _write_api = get_client().write_api(write_options=SYNCHRONOUS)
    return _write_api


def write_outside_reading(fields):
    """fields: flat dict of already-prefixed field names -> value (numeric
    or string), e.g. {"google_aqi": 42, "google_category": "Moderate", ...}.
    None values are dropped rather than written as an explicit null."""
    point = Point(OUTSIDE_MEASUREMENT).tag("zip", os.environ.get("AIRNOW_ZIP", ""))
    for key, value in fields.items():
        if value is not None:
            point = point.field(key, value)
    get_write_api().write(bucket=os.environ["INFLUX_BUCKET"], record=point)


def query_google_history(hours):
    return _query_prefixed_history(GOOGLE_FIELDS + GOOGLE_STRING_FIELDS, hours)


def query_purpleair_history(hours):
    return _query_prefixed_history(PURPLEAIR_FIELDS + PURPLEAIR_STRING_FIELDS, hours)


def _query_prefixed_history(all_fields, hours):
    bucket = os.environ["INFLUX_BUCKET"]
    field_filter = " or ".join(f'r._field == "{f}"' for f in all_fields)
    flux = f'''
    from(bucket: "{bucket}")
      |> range(start: -{hours}h)
      |> filter(fn: (r) => r._measurement == "{OUTSIDE_MEASUREMENT}")
      |> filter(fn: (r) => {field_filter})
      |> pivot(rowKey: ["_time"], columnKey: ["_field"], valueColumn: "_value")
      |> sort(columns: ["_time"])
    '''
    return _rows_from(get_client().query_api().query(flux))
