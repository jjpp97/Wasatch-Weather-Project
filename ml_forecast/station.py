"""What was measured at Mid Collins: hourly readings, cleaned, and one row per Mountain-time day.

Readings come from the Synoptic Data Viewer CSVs in data/raw/ (kept exactly as downloaded) and,
for the hours after them, from data/alta-collins.json, which scripts/fetch_stations.py appends
to every hour. Times are stored in UTC; days run midnight to midnight Mountain time, the same
days as the bars on the site's Snow Summary.
"""
import json

import numpy as np
import pandas as pd

from . import archive, config

COLUMNS = ["temp_f", "precip_in", "board_in", "wind_mph"]


def read_csv(path):
    """One Data Viewer CSV (metric units, local times with their offset) as hourly UTC rows."""
    df = pd.read_csv(path, comment="#", dtype=str)
    df = df[df["Station_ID"] == config.SITE["station"]]  # also drops the row of units under the header
    num = lambda col: pd.to_numeric(df[col], errors="coerce") if col in df else pd.Series(np.nan, index=df.index)
    return pd.DataFrame({
        "time": pd.to_datetime(df["Date_Time"], utc=True, format="%Y-%m-%dT%H:%M:%S%z"),
        "temp_f": num("air_temp_set_1") * 9 / 5 + 32,
        "precip_in": num("precip_accum_one_hour_set_1") / 25.4,
        "board_in": num("snow_interval_set_1") / 25.4,
        "wind_mph": num("wind_speed_set_1") * 2.236936,
    })


def read_site_json():
    """data/alta-collins.json (°F, inches, wind in knots) as hourly UTC rows."""
    f = json.loads(config.STATION_JSON.read_text(encoding="utf-8"))
    df = pd.DataFrame(f["rows"], columns=f["columns"])
    return pd.DataFrame({
        "time": pd.to_datetime(df["time"], utc=True),
        "temp_f": pd.to_numeric(df["air_temp"]),
        "precip_in": pd.to_numeric(df["precip_1h"]),
        "board_in": pd.to_numeric(df["snow_interval"]),
        "wind_mph": pd.to_numeric(df["wind_speed"]) * 1.150779,  # Synoptic's "english" wind is in knots
    })


def clean(df):
    """Drop duplicates and readings that cannot be real."""
    df = df.dropna(subset=["time"]).drop_duplicates("time", keep="last").sort_values("time")
    df.loc[(df["temp_f"] < -40) | (df["temp_f"] > 100), "temp_f"] = np.nan
    df.loc[(df["precip_in"] < 0) | (df["precip_in"] > config.MAX_HOURLY_PRECIP_IN), "precip_in"] = np.nan
    df.loc[(df["board_in"] < 0) | (df["board_in"] > 60), "board_in"] = np.nan
    df.loc[(df["wind_mph"] < 0) | (df["wind_mph"] > 150), "wind_mph"] = np.nan
    return df.reset_index(drop=True)


def update_archive():
    """Merge every source into the monthly station archive and return all hourly readings."""
    parts = [read_csv(p) for p in sorted(config.RAW_DIR.glob("*.csv"))]
    csv_end = max(p["time"].max() for p in parts) if parts else None
    site = read_site_json()
    if csv_end is not None:
        site = site[site["time"] > csv_end]  # the CSVs are the reference for the hours they cover
    new = clean(pd.concat(parts + [site], ignore_index=True))
    old = archive.read("station")
    merged = clean(pd.concat([old, new], ignore_index=True)) if len(old) else new
    archive.write("station", merged, months=None)
    return merged


def spikes(board, jump=6, back_within=3):
    """True for readings that rise `jump`" or more in one step and fall back to near the level
    before (within 3") inside `back_within` readings: a sensor glitch, not snow."""
    bad = np.zeros(len(board), bool)
    last = None
    for i, b in enumerate(board):
        if bad[i]:
            continue
        if last is not None and b - last >= jump:
            ahead = board[i + 1:i + 1 + back_within]
            back = np.nonzero(ahead <= last + 3)[0]
            if len(back):
                bad[i:i + 1 + back[0]] = True
                continue
        last = b
    return bad


def board_snow(hours):
    """{local date: inches of new snow} from the snow board, counted the way the site counts it.

    The board is cleared now and then. A rise is new snow. A drop of more than 2" counts as a
    clearing only if the board is left at 1" or less; otherwise the snow has settled and counting
    carries on from the lower level. Readings above 40 °F are ignored.

    The sensor sometimes jumps to 20–35" for one to three hours and back (e.g. 2025-02-15,
    2026-03-05); those readings are skipped (see spikes).
    """
    rows = hours.dropna(subset=["board_in"])
    days = rows["day"].to_numpy()
    board = rows["board_in"].to_numpy()
    temp = rows["temp_f"].to_numpy()
    bad = spikes(board)
    snow, peak = {}, None
    for i in range(len(board)):
        snow.setdefault(days[i], 0.0)
        if bad[i] or (not np.isnan(temp[i]) and temp[i] > 40):
            continue
        b = board[i]
        if peak is None or b < peak - 2:
            if peak is not None and b > 1:  # settled, not cleared
                peak = b
                continue
            if peak is not None and b > 0:
                snow[days[i]] += b
            peak = b
        elif b > peak:
            snow[days[i]] += b - peak
            peak = b
    return snow


def daily(hours):
    """One row per Mountain-time day: liquid, board snow, mean temperature and wind, with gaps as NaN."""
    h = hours.copy()
    h["day"] = h["time"].dt.tz_convert(config.SITE["tz"]).dt.date
    g = h.groupby("day")
    out = pd.DataFrame({
        "liquid": g["precip_in"].sum(min_count=1),
        "temp": g["temp_f"].mean(),
        "wind": g["wind_mph"].mean(),
    })
    counts = g.count()
    out.loc[counts["precip_in"] < config.MIN_HOURS, "liquid"] = np.nan
    out.loc[counts["temp_f"] < config.MIN_HOURS, "temp"] = np.nan
    out.loc[counts["wind_mph"] < config.MIN_HOURS, "wind"] = np.nan
    snow = pd.Series(board_snow(h))
    out["snow"] = snow.reindex(out.index)
    out.loc[(counts["board_in"] < config.MIN_HOURS) | (out["snow"] > config.MAX_DAILY_SNOW_IN), "snow"] = np.nan
    out.index = pd.to_datetime(out.index)
    return out
