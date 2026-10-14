"""Fetch recent station readings from Synoptic and add them to the files in data/.

Synoptic's free tier only serves the last seven days, so this is run on a schedule (see
.github/workflows/stations.yml) and each run merges the new readings into the files. Two kinds
of file are kept:

  Snow files (SNOW_FILES), one per snow study plot. These keep every reading, so over time they
  become a record that goes back further than Synoptic will. The page's measured-snow boxes read them.

  Station files (STATION_FILES), one per resort whose stations are not on the public National
  Weather Service feed. These keep the last STATION_DAYS days for the Weather Stations tab.

The token comes from the SYNOPTIC_TOKEN environment variable (a GitHub secret when run by the
workflow). To run it by hand, pass the path of a text file holding the token instead:

    python scripts/fetch_stations.py C:\\path\\to\\synoptic-token.txt

The token is never written to the data files or printed.
"""
import datetime
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request

DATA = pathlib.Path(__file__).resolve().parent.parent / "data"

# Station id -> file that keeps its whole record
SNOW_FILES = {
    "CLN": "alta-collins.json",        # Alta - Collins, 9,662 ft
    "SOLSM": "solitude-summit.json",   # Solitude - Summit, 9,641 ft
    "DVO": "deer-valley-ontario.json", # Deer Valley - Ontario, 9,100 ft
}
# Stations that report every few minutes. Their snow file keeps one row per hour instead: the
# last reading of each complete hour, labelled with the time the hour ended, and that hour's
# water added up from the station's few-minute amounts (Synoptic variable named here) as precip_1h.
FEW_MINUTE_PRECIP = {
    "DVO": "precip_accum_five_minute",
}
# Column name in a snow file -> Synoptic variable name
SNOW_COLUMNS = {
    "snow_depth": "snow_depth",                # inches on the ground
    "snow_interval": "snow_interval",          # inches on the new-snow board since it was last cleared
    "precip_1h": "precip_accum_one_hour",      # inches of water in the last hour
    "air_temp": "air_temp",                    # deg F
    "wind_speed": "wind_speed",                # mph
    "wind_dir": "wind_direction",              # degrees the wind comes from
}

# File -> the stations whose recent readings it holds
STATION_FILES = {
    "solitude-stations.json": ["SOLBS", "SOLMB", "SOLAP", "SOLSM", "SOL", "SOLHP"],
}
STATION_DAYS = 10
# Column name in a station file -> Synoptic variable name
STATION_COLUMNS = {
    "air_temp": "air_temp",                    # deg F
    "humidity": "relative_humidity",           # %
    "dew_point": "dew_point_temperature",      # deg F
    "wind_speed": "wind_speed",                # mph
    "wind_gust": "wind_gust",                  # mph
    "wind_dir": "wind_direction",              # degrees the wind comes from
    "wind_chill": "wind_chill",                # deg F
    "snow_depth": "snow_depth",                # inches on the ground
    "snow_interval": "snow_interval",          # inches on the new-snow board
}


def read_token():
    if len(sys.argv) > 1:
        return pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").strip()
    token = os.environ.get("SYNOPTIC_TOKEN", "").strip()
    if not token:
        sys.exit("No token: set SYNOPTIC_TOKEN or pass the path of a file that holds it.")
    return token


def fetch(token, stations, variables):
    """One request for every station; returns {station id: Synoptic's record for it}."""
    query = urllib.parse.urlencode({
        "stid": ",".join(stations),
        "recent": 7 * 24 * 60,  # minutes; the most the free tier allows
        "vars": ",".join(variables),
        "units": "english",
        "token": token,
    })
    try:
        with urllib.request.urlopen("https://api.synopticdata.com/v2/stations/timeseries?" + query, timeout=90) as res:
            body = json.load(res)
    except urllib.error.HTTPError as err:
        sys.exit(f"Synoptic returned HTTP {err.code}.")  # not the URL: it contains the token
    except urllib.error.URLError as err:
        sys.exit(f"Could not reach Synoptic: {err.reason}.")
    summary = body.get("SUMMARY", {})
    if summary.get("RESPONSE_CODE") != 1 or not body.get("STATION"):
        sys.exit(f"Synoptic refused the request: {summary.get('RESPONSE_MESSAGE', 'no message')}")
    return {s["STID"]: s for s in body["STATION"]}


def readings(station, columns):
    """{time: {column: value}} for one station. Derived values arrive as "_set_1d"."""
    obs = station["OBSERVATIONS"]
    series = {name: obs.get(f"{var}_set_1") or obs.get(f"{var}_set_1d") for name, var in columns.items()}
    return {when: {name: (s[i] if s else None) for name, s in series.items()}
            for i, when in enumerate(obs["date_time"])}


def by_hour(station, rows, precip_var):
    """Thin few-minute readings to one row per complete hour (see FEW_MINUTE_PRECIP)."""
    obs = station["OBSERVATIONS"]
    amounts = obs.get(f"{precip_var}_set_1") or [None] * len(obs["date_time"])
    def hour_end(when):
        t = datetime.datetime.strptime(when, "%Y-%m-%dT%H:%M:%SZ")
        floor = t.replace(minute=0, second=0)
        return (floor if t == floor else floor + datetime.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    hours = {}
    for i, when in enumerate(obs["date_time"]):
        h = hours.setdefault(hour_end(when), {"last": None, "water": 0.0, "any": False})
        h["last"] = rows[when]  # readings arrive oldest first, so this ends as the hour's last one
        if amounts[i] is not None:
            h["water"] += amounts[i]
            h["any"] = True
    latest = max(obs["date_time"])
    return {end: {**h["last"], "precip_1h": round(h["water"], 3) if h["any"] else None}
            for end, h in hours.items() if end <= latest}  # the hour under way is left for the next run


def merged(old_rows, old_columns, new, names):
    """Old rows with the new readings laid over them, so a re-run replaces instead of duplicating."""
    rows = {row[0]: dict(zip(old_columns[1:], row[1:])) for row in old_rows}
    added = sum(when not in rows for when in new)
    rows.update(new)
    return rows, added


def as_rows(rows, names):
    return [[when] + [rows[when].get(n) for n in names] for when in sorted(rows)]


def describe(station):
    return {"id": station["STID"], "name": station["NAME"], "elevation_ft": float(station["ELEVATION"])}


def write(path, content):
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(content, separators=(",", ":")) + "\n", encoding="utf-8")


def main():
    wanted = list(dict.fromkeys(list(SNOW_FILES) + [s for ids in STATION_FILES.values() for s in ids]))
    variables = list(dict.fromkeys(list(SNOW_COLUMNS.values()) + list(STATION_COLUMNS.values()) +
                                   list(FEW_MINUTE_PRECIP.values())))
    found = fetch(read_token(), wanted, variables)
    now = datetime.datetime.now(datetime.timezone.utc)
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    for stid, filename in SNOW_FILES.items():
        if stid not in found:
            print(f"{filename}: {stid} sent nothing, file left as it is")
            continue
        path, names = DATA / filename, list(SNOW_COLUMNS)
        old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"rows": [], "columns": ["time"]}
        new = readings(found[stid], SNOW_COLUMNS)
        if stid in FEW_MINUTE_PRECIP:
            new = by_hour(found[stid], new, FEW_MINUTE_PRECIP[stid])
        rows, added = merged(old["rows"], old["columns"], new, names)
        write(path, {
            "station": describe(found[stid]),
            "updated": stamp,
            "units": "inches, deg F, mph; times are UTC",
            "columns": ["time"] + names,
            "rows": as_rows(rows, names),
        })
        print(f"{filename}: {len(rows)} readings on file ({added} new), {min(rows)} to {max(rows)}")

    oldest = (now - datetime.timedelta(days=STATION_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    for filename, ids in STATION_FILES.items():
        path, names = DATA / filename, list(STATION_COLUMNS)
        old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"stations": {}, "columns": ["time"]}
        stations = {}
        for stid in ids:
            before = old["stations"].get(stid, {})
            new = readings(found[stid], STATION_COLUMNS) if stid in found else {}
            rows, added = merged(before.get("rows", []), old["columns"], new, names)
            rows = {when: r for when, r in rows.items() if when >= oldest}
            about = describe(found[stid]) if stid in found else {k: before.get(k) for k in ("id", "name", "elevation_ft")}
            stations[stid] = {**about, "rows": as_rows(rows, names)}
            print(f"{filename}: {stid} {len(rows)} readings ({added} new)")
        write(path, {
            "updated": stamp,
            "units": "inches, deg F, mph, %; times are UTC",
            "columns": ["time"] + names,
            "stations": stations,
        })


if __name__ == "__main__":
    main()
