import json
import os
import re

DATA_DIR = "data"
LOCATIONS_FILE = os.path.join(DATA_DIR, "locations.json")

ZIP_RE = re.compile(r"^\d{5}$")


def _load():
    if not os.path.exists(LOCATIONS_FILE):
        return []
    with open(LOCATIONS_FILE) as f:
        return json.load(f)


def _save(locations):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = LOCATIONS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(locations, f, indent=2)
    os.replace(tmp, LOCATIONS_FILE)


def list_locations():
    return _load()


def add_location(label, zip_code):
    label = (label or "").strip()
    zip_code = (zip_code or "").strip()
    if not label:
        raise ValueError("a name is required")
    if not ZIP_RE.match(zip_code):
        raise ValueError("zip must be 5 digits")
    locations = _load()
    if any(loc["zip"] == zip_code for loc in locations):
        raise ValueError("that zip is already saved")
    locations.append({"label": label, "zip": zip_code})
    _save(locations)
    return locations


def remove_location(zip_code):
    locations = _load()
    remaining = [loc for loc in locations if loc["zip"] != zip_code]
    if len(remaining) == len(locations):
        raise ValueError("no saved location with that zip")
    _save(remaining)
    return remaining
