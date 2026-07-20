"""Unit tests for the saved-locations store (locations.py): format/duplicate
validation and the add/remove round-trip against a temp data dir."""
import importlib

import pytest


@pytest.fixture
def locations(tmp_path, monkeypatch):
    # Point the store at a temp dir before (re)importing so LOCATIONS_FILE is
    # computed against it, not the real ./data.
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    import locations as locations_module
    importlib.reload(locations_module)
    return locations_module


def test_validate_new_ok(locations):
    assert locations.validate_new("  Cabin  ", " 54501 ") == ("Cabin", "54501")


def test_validate_new_rejects_bad_input(locations):
    with pytest.raises(ValueError, match="name is required"):
        locations.validate_new("", "54501")
    with pytest.raises(ValueError, match="5 digits"):
        locations.validate_new("Cabin", "123")
    with pytest.raises(ValueError, match="5 digits"):
        locations.validate_new("Cabin", "not-a-zip")


def test_validate_new_rejects_duplicate(locations):
    locations.add_location("Cabin", "54501")
    with pytest.raises(ValueError, match="already saved"):
        locations.validate_new("Cabin Again", "54501")


def test_add_and_remove_round_trip(locations):
    locations.add_location("Cabin", "54501", lat=45.8, lon=-89.7)
    assert locations.list_locations() == [
        {"label": "Cabin", "zip": "54501", "lat": 45.8, "lon": -89.7}
    ]
    remaining = locations.remove_location("54501")
    assert remaining == []
    assert locations.list_locations() == []


def test_remove_unknown_zip_raises(locations):
    with pytest.raises(ValueError, match="no saved location"):
        locations.remove_location("00000")
