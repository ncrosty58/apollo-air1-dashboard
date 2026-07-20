"""OpenWeatherMap pollution provider -- reads the owm_-prefixed fields that
Node-RED writes into the outside_air_quality measurement (piggybacked on the
chassis tab's existing 5-minute OWM weather poll, one air_pollution call per
~15 min). This dashboard never calls OpenWeatherMap itself, so switching to
this provider adds zero OWM API traffic.

OWM reports every component as a raw µg/m³ concentration plus its own 1-5
index; both convert to the EPA 0-500 AQI scale here so the number means the
same thing it does on every other provider."""

import epa_aqi
import influx

# OWM component -> (EPA parameter, display label). NH3 has no EPA AQI
# breakpoints, so it's shown as a concentration only.
COMPONENTS = [
    ("owm_pm2_5_ugm3", "PM2.5"),
    ("owm_pm10_ugm3", "PM10"),
    ("owm_o3_ugm3", "O3"),
    ("owm_no2_ugm3", "NO2"),
    ("owm_so2_ugm3", "SO2"),
    ("owm_co_ugm3", "CO"),
]


def _epa_value(parameter, ugm3):
    """Convert an OWM µg/m³ reading into the unit EPA's breakpoint table
    for that parameter expects."""
    if ugm3 is None:
        return None
    if parameter in ("PM2.5", "PM10"):
        return ugm3
    ppb = epa_aqi.ugm3_to_ppb(parameter, ugm3)
    if parameter == "CO":
        return ppb / 1000 if ppb is not None else None  # EPA's CO table is ppm
    return ppb


def _aqi_for(parameter, ugm3):
    return epa_aqi.aqi_from_concentration(parameter, _epa_value(parameter, ugm3))


def get_current_observation():
    row = influx.query_owm_latest()
    if row is None:
        return None

    per_pollutant = []
    for field, parameter in COMPONENTS:
        value = row.get(field)
        if value is None:
            continue
        per_pollutant.append({
            "parameter": parameter,
            "aqi": _aqi_for(parameter, value),
            "concentration_value": round(value, 2),
            "concentration_units": "MICROGRAMS_PER_CUBIC_METER",
        })
    if row.get("owm_nh3_ugm3") is not None:
        per_pollutant.append({
            "parameter": "NH3",
            "aqi": None,
            "concentration_value": round(row["owm_nh3_ugm3"], 2),
            "concentration_units": "MICROGRAMS_PER_CUBIC_METER",
        })

    with_aqi = [(p["aqi"], p["parameter"]) for p in per_pollutant if p["aqi"] is not None]
    if not with_aqi:
        return None
    aqi, dominant = max(with_aqi)

    return {
        "aqi": aqi,
        "band": epa_aqi.band_for_aqi(aqi),
        "category": epa_aqi.category_name(aqi),
        "dominant_pollutant": dominant,
        "reporting_area": None,  # caller fills in the home label
        "observed_hour": None,
        "time": row.get("time"),
        "pollutants": per_pollutant,
    }


def get_history(hours):
    """Points shaped like the Google provider's history (concentrations in
    generic field names + a computed EPA AQI per point), so the frontend's
    concentration-overlay charts work unchanged."""
    points = []
    for row in influx.query_owm_history(hours):
        pm2_5 = row.get("owm_pm2_5_ugm3")
        point = {
            "time": row["time"],
            "aqi": _aqi_for("PM2.5", pm2_5),
            "pm2_5_ugm3": pm2_5,
            "pm10_ugm3": row.get("owm_pm10_ugm3"),
            "o3_ppb": epa_aqi.ugm3_to_ppb("O3", row.get("owm_o3_ugm3")),
            "no2_ppb": epa_aqi.ugm3_to_ppb("NO2", row.get("owm_no2_ugm3")),
            "so2_ppb": epa_aqi.ugm3_to_ppb("SO2", row.get("owm_so2_ugm3")),
            "co_ppb": epa_aqi.ugm3_to_ppb("CO", row.get("owm_co_ugm3")),
        }
        # Headline AQI per point is the worst of all converted components,
        # matching how get_current_observation picks its number.
        candidates = [
            _aqi_for(param, row.get(field))
            for field, param in COMPONENTS
        ]
        candidates = [a for a in candidates if a is not None]
        if candidates:
            point["aqi"] = max(candidates)
        cleaned = {k: (round(v, 2) if isinstance(v, float) else v) for k, v in point.items() if v is not None}
        if len(cleaned) > 1:  # more than just "time"
            points.append(cleaned)
    return points
