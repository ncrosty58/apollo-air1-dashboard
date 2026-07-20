"""Unit tests for airnow.observation_from_row -- the pure mapping from a
stored InfluxDB row to the current-observation shape the dashboard renders.
The live-HTTP paths (_fetch/_fetch_forecast) aren't exercised here."""
import airnow


def test_observation_from_row_none():
    assert airnow.observation_from_row(None) is None


def test_observation_from_row_without_aqi_is_none():
    assert airnow.observation_from_row({"category": "Good"}) is None


def test_observation_from_row_shape():
    row = {
        "aqi": 42.4,
        "category": "Good",
        "dominant_pollutant": "PM2.5",
        "reporting_area": "Rhinelander, WI",
        "pm2_5_aqi": 42.4,
        "o3_aqi": 30,
        "time": "2026-07-20T12:00:00+00:00",
    }
    obs = airnow.observation_from_row(row)
    assert obs["aqi"] == 42  # rounded to int
    assert obs["band"] == "good"
    assert obs["category"] == "Good"
    assert obs["dominant_pollutant"] == "PM2.5"
    assert obs["reporting_area"] == "Rhinelander, WI"
    # Only fields present in the row become pollutant rows, in table order.
    assert obs["pollutants"] == [
        {"parameter": "PM2.5", "aqi": 42, "category": None},
        {"parameter": "O3", "aqi": 30, "category": None},
    ]


def test_format_reporting_area_regional_gets_full_state_name():
    # A compass-direction "city" reads as a fake town with "Southeast, MI", so
    # the state name is folded in instead.
    assert airnow._format_reporting_area("Southeast", "MI") == "Southeast Michigan"
    # A normal city keeps the "City, ST" abbreviation.
    assert airnow._format_reporting_area("Rhinelander", "WI") == "Rhinelander, WI"
