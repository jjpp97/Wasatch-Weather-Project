"""Merge Collins (CLN) readings downloaded from the Synoptic Data Viewer into data/alta-collins.json.

The hourly job (fetch_stations.py) can only read the last 7 days, so older winters come from
CSV downloads of the Synoptic Data Viewer (viewer.synopticdata.com, station CLN). Run this once
per download:

    python scripts/import_collins_csv.py "C:\\path\\to\\CLN.2026-10-18.csv"

The CSV's metric units (°C, mm, m/s) are converted to the file's own (°F, inches, knots), and its
local times (with their UTC offset) to UTC. Readings already in the file are kept as they are.
"""
import csv
import datetime as dt
import json
import pathlib
import sys

FILE = pathlib.Path(__file__).resolve().parent.parent / "data" / "alta-collins.json"
# Column in the file -> (column in the CSV, conversion from the CSV's unit)
COLUMNS = {
    "snow_depth": ("snow_depth_set_1", lambda mm: mm / 25.4),
    "snow_interval": ("snow_interval_set_1", lambda mm: mm / 25.4),
    "precip_1h": ("precip_accum_one_hour_set_1", lambda mm: mm / 25.4),
    "air_temp": ("air_temp_set_1", lambda c: c * 9 / 5 + 32),
    # The hourly job asks Synoptic for "english" units, which give wind in knots, so knots it is
    "wind_speed": ("wind_speed_set_1", lambda ms: ms * 1.943844),
    "wind_dir": ("wind_direction_set_1", lambda d: d),
}
ROUND = {"snow_depth": 2, "snow_interval": 2, "precip_1h": 3, "air_temp": 1, "wind_speed": 1, "wind_dir": 0}


def read_csv(path):
    """{UTC time: {column: value}} from one Synoptic Data Viewer CSV."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        lines = [line for line in f if not line.startswith("#")]
    rows = list(csv.reader(lines))
    header, units, data = rows[0], rows[1], rows[2:]
    if units[header.index("air_temp_set_1")].strip() != "Celsius":
        sys.exit(f"{path}: expected metric units (Celsius, Millimeters, m/s) as the Data Viewer gives them")
    at = {name: header.index(src) for name, (src, _) in COLUMNS.items() if src in header}
    out = {}
    for r in data:
        if not r or r[0] != "CLN":
            continue
        when = dt.datetime.strptime(r[1], "%Y-%m-%dT%H:%M:%S%z").astimezone(dt.timezone.utc)
        values = {}
        for name, i in at.items():
            raw = r[i].strip() if i < len(r) else ""
            values[name] = None if raw == "" else round(COLUMNS[name][1](float(raw)), ROUND[name])
        out[when.strftime("%Y-%m-%dT%H:%M:%SZ")] = values
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit("Pass the path of one or more CSV files downloaded from the Synoptic Data Viewer.")
    old = json.loads(FILE.read_text(encoding="utf-8"))
    names = old["columns"][1:]
    rows = {r[0]: dict(zip(names, r[1:])) for r in old["rows"]}
    before = len(rows)
    for path in sys.argv[1:]:
        new = read_csv(path)
        added = 0
        for when, values in new.items():
            if when not in rows:  # the hourly job's own readings win
                rows[when] = values
                added += 1
        print(f"{pathlib.Path(path).name}: {len(new)} readings, {added} added")
    old["rows"] = [[when] + [rows[when].get(n) for n in names] for when in sorted(rows)]
    FILE.write_text(json.dumps(old, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{FILE.name}: {before} -> {len(rows)} readings, {min(rows)} to {max(rows)}")


if __name__ == "__main__":
    main()
