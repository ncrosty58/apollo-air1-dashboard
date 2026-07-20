import os

from influxdb_client import InfluxDBClient

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
