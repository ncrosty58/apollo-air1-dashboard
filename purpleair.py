"""PurpleAir provider -- hyperlocal PM readings from the nearest outdoor
community sensor. Unlike AirNow/Google there's no regional model here: it's
one physical sensor, so readings are minutes fresh but PM-only (no gases).

Node-RED polls one hardcoded sensor every 10 minutes and writes corrected
PM2.5/PM10 + a recomputed AQI to InfluxDB (see the "Format PurpleAir Fields
& Tags" function in the Apollo AIR-1 flow) -- this module just reads that
back, same pattern as owm.py. The dashboard itself never calls PurpleAir.
Raw cf_1 PM2.5 is corrected there with EPA's Barkjohn equation (the same
one AirNow's own Fire & Smoke map applies to PurpleAir sensors) before
converting to an AQI, so this provider's number is comparable to AirNow's
rather than reading systematically high."""

import epa_aqi
import influx

# The nearest outdoor sensor to home, picked once and hardcoded directly in
# the Node-RED flow (sensor 178257) -- kept in sync with that flow's own
# comment. If that sensor ever goes offline, both need a manual update.
SENSOR_NAME = "St. Marys"


def get_current_observation():
    row = influx.query_purpleair_latest()
    if row is None:
        return None
    aqi = row.get("purpleair_aqi")
    if aqi is None:
        return None

    pollutants = []
    if row.get("purpleair_pm2_5_ugm3") is not None:
        pollutants.append({
            "parameter": "PM2.5",
            "concentration_value": row["purpleair_pm2_5_ugm3"],
            "concentration_units": "MICROGRAMS_PER_CUBIC_METER",
        })
    if row.get("purpleair_pm10_ugm3") is not None:
        pollutants.append({
            "parameter": "PM10",
            "concentration_value": row["purpleair_pm10_ugm3"],
            "concentration_units": "MICROGRAMS_PER_CUBIC_METER",
        })

    return {
        "aqi": int(aqi),
        "band": epa_aqi.band_for_aqi(aqi),
        "category": row.get("purpleair_category"),
        "dominant_pollutant": row.get("purpleair_dominant_pollutant"),
        "reporting_area": SENSOR_NAME,
        "observed_hour": None,
        "time": row.get("time"),
        "pollutants": pollutants,
    }


def get_history(hours):
    """Reads back what Node-RED has been persisting to InfluxDB (see
    get_current_observation above) rather than PurpleAir's own history
    endpoint -- that endpoint is gated by API key tier and often just isn't
    available, so this is the only reliable source of PurpleAir history,
    not just a consistency choice. Field names are stripped back to the
    shared flat shape (aqi/pm2_5_ugm3/pm10_ugm3) the frontend's overlay
    charts already expect, same convention as owm.py/google_aq.py's
    get_history."""
    points = []
    for row in influx.query_purpleair_history(hours):
        point = {
            "time": row["time"],
            "aqi": row.get("purpleair_aqi"),
            "pm2_5_ugm3": row.get("purpleair_pm2_5_ugm3"),
            "pm10_ugm3": row.get("purpleair_pm10_ugm3"),
        }
        cleaned = {k: v for k, v in point.items() if v is not None}
        if len(cleaned) > 1:  # more than just "time"
            points.append(cleaned)
    return points
