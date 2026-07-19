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
    tables = get_client().query_api().query(flux)
    points = []
    for table in tables:
        for record in table.records:
            row = dict(record.values)
            row["time"] = record.get_time().isoformat()
            for key in ("result", "table", "_start", "_stop", "_measurement", "_time"):
                row.pop(key, None)
            points.append(row)
    return points
