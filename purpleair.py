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

import aq_shared
import epa_aqi
import influx

# The nearest outdoor sensor to home, picked once and hardcoded directly in
# the Node-RED flow (sensor 178257) -- kept in sync with that flow's own
# comment. If that sensor ever goes offline, both need a manual update.
SENSOR_NAME = "St. Marys"


def get_current_observation():
    """Headline AQI, category, and dominant pollutant are read straight from
    the fields Node-RED computed (purpleair_aqi_epa / purpleair_category /
    purpleair_dominant_pollutant) from the EPA-corrected PM concentrations --
    the app no longer recomputes them, so the dashboard, Grafana, and
    Node-RED all agree on the number."""
    row = influx.query_purpleair_latest()
    if row is None:
        return None
    hd = aq_shared.headline(row, "purpleair_aqi_epa", "purpleair_category", "purpleair_dominant_pollutant", epa_aqi.category_name)
    if hd is None:
        return None
    aqi, category, dominant = hd

    # (concentration field, EPA parameter, per-pollutant AQI field). The AQI is
    # the one Node-RED derived from the corrected concentration; the app reads
    # it for the dashboard while the Technical page keeps the concentration.
    pollutant_fields = [
        ("purpleair_pm2_5_ugm3", "PM2.5", "purpleair_pm2_5_aqi_epa"),
        ("purpleair_pm10_ugm3", "PM10", "purpleair_pm10_aqi_epa"),
    ]
    pollutants = []
    for field, parameter, aqi_field in pollutant_fields:
        value = row.get(field)
        if value is None:
            continue
        row_out = {
            "parameter": parameter,
            "concentration_value": value,
            "concentration_units": "MICROGRAMS_PER_CUBIC_METER",
        }
        aqi_value = row.get(aqi_field)
        if aqi_value is not None:
            row_out["aqi"] = int(round(aqi_value))
        pollutants.append(row_out)

    return {
        "aqi": aqi,
        "band": epa_aqi.band_for_aqi(aqi),
        "category": category,
        "dominant_pollutant": dominant,
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
    field_map = {
        "pm2_5_ugm3": ("purpleair_pm2_5_ugm3", aq_shared.identity),
        "pm10_ugm3": ("purpleair_pm10_ugm3", aq_shared.identity),
    }
    return aq_shared.history_points(influx.query_purpleair_history(hours), "purpleair_aqi_epa", field_map)
