import json
import os
import re
import threading

DATA_DIR = os.environ.get("DATA_DIR", "data")
LOCATIONS_FILE = os.path.join(DATA_DIR, "locations.json")

ZIP_RE = re.compile(r"^\d{5}$")

# Serializes the read-modify-write in the mutating functions below. gunicorn
# runs one worker but many threads (see docker-compose.yml), so two concurrent
# add/remove requests would otherwise each _load(), mutate their own copy, and
# _save() -- the atomic os.replace keeps the file from corrupting, but the
# second writer still clobbers the first's change (a lost update). Holding this
# across load+save makes each mutation see the other's result.
_write_lock = threading.Lock()


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


def validate_new(label, zip_code):
    """Format/duplicate checks only — doesn't touch AirNow or the file.
    Callers should confirm AirNow actually has data for the zip before
    calling add_location, since a bad zip saved here would just fail
    silently every time it's later selected."""
    label = (label or "").strip()
    zip_code = (zip_code or "").strip()
    if not label:
        raise ValueError("a name is required")
    if not ZIP_RE.match(zip_code):
        raise ValueError("zip must be 5 digits")
    if any(loc["zip"] == zip_code for loc in _load()):
        raise ValueError("that zip is already saved")
    return label, zip_code


def add_location(label, zip_code, lat=None, lon=None):
    with _write_lock:
        locations = _load()
        # Re-check under the lock: validate_new's duplicate check runs before
        # the (slow) AirNow verification in the route, so a second request for
        # the same zip can slip past it and reach here concurrently. Dedup here
        # rather than raising -- the route already reported success semantics.
        if not any(loc["zip"] == zip_code for loc in locations):
            locations.append({"label": label, "zip": zip_code, "lat": lat, "lon": lon})
            _save(locations)
        return locations


def remove_location(zip_code):
    with _write_lock:
        locations = _load()
        remaining = [loc for loc in locations if loc["zip"] != zip_code]
        if len(remaining) == len(locations):
            raise ValueError("no saved location with that zip")
        _save(remaining)
        return remaining
