"""The Days 8–16 outlook: saves today's ensemble forecasts so they can be scored once a winter has passed.

The tab shows Days 8–16 as a blend of two ensembles (ECMWF 60%, GFS 40%), with the NBM drawn
beside it for comparison. Open-Meteo keeps no history of past ensemble forecasts, so the only way
to test that blend is to save it as we go. Each run adds one row per ensemble member (and one for
the NBM) per forecast day: issue date, lead day, water, snow water, snow and mean temperature.
The blend is the weighted mean of the members' means, so it is not stored separately.
"""
import datetime as dt
import json
import urllib.parse
import urllib.request

import numpy as np
import pandas as pd

from . import archive, config, forecasts

ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
# Open-Meteo's name for each ensemble in the request, and the ending of its fields in the reply
ENSEMBLES = {"gefs": ("gfs_seamless", "ncep_gefs_seamless"), "ecmwf_ens": ("ecmwf_ifs025", "ecmwf_ifs025_ensemble")}
VARS = ("precipitation", "snowfall", "temperature_2m")


def query(models):
    return {"latitude": config.SITE["lat"], "longitude": config.SITE["lon"], "elevation": config.SITE["elev_m"],
            "models": models, "hourly": ",".join(VARS), "forecast_days": 16, "timezone": config.SITE["tz"],
            "precipitation_unit": "inch", "temperature_unit": "fahrenheit"}


def get(url, q):
    with urllib.request.urlopen(url + "?" + urllib.parse.urlencode(q), timeout=120) as res:
        return json.load(res)["hourly"]


def members(h, ending):
    """{member number: {var: values}}; the control run (no "memberNN" in its name) is member 0."""
    out = {}
    for key in h:
        for var in VARS:
            if key.startswith(var + "_") and key.endswith(ending):
                middle = key[len(var) + 1:-len(ending)].strip("_")
                n = int(middle.replace("member", "")) if middle else 0
                out.setdefault(n, {})[var] = h[key]
    return out


def daily_rows(times, run, today, model, member):
    """One member's hourly forecast as one row per Mountain-time day."""
    f = pd.DataFrame({"local": pd.to_datetime(times), **{v: pd.to_numeric(pd.Series(run.get(v)), errors="coerce") for v in VARS}})
    f["swe"] = np.minimum(f["snowfall"] / 7, f["precipitation"])  # capped, as everywhere on the tab
    f["snow"] = f["swe"] * forecasts.kuchera(f["temperature_2m"])
    f["day"] = f["local"].dt.date
    g = f.groupby("day")
    d = pd.DataFrame({"precip": g["precipitation"].sum(min_count=1), "swe": g["swe"].sum(min_count=1),
                      "snow": g["snow"].sum(min_count=1), "temp": g["temperature_2m"].mean(),
                      "hours": g["precipitation"].count()})
    d = d[d["hours"] >= config.MIN_HOURS].drop(columns="hours").reset_index()
    d["lead"] = [(day - today).days for day in d["day"]]
    d["day"] = pd.to_datetime(d["day"])
    d["model"], d["member"] = model, member
    return d


def save(today):
    """Fetch today's ensembles and NBM for Mid Collins and add them to the outlook archive."""
    frames = []
    h = get(ENSEMBLE_URL, query(",".join(api for api, _ in ENSEMBLES.values())))
    for key, (_, ending) in ENSEMBLES.items():
        for n, run in sorted(members(h, ending).items()):
            frames.append(daily_rows(h["time"], run, today, key, n))
    nbm = get(FORECAST_URL, query(config.MODELS["nbm"]["api"]))
    frames.append(daily_rows(nbm["time"], nbm, today, "nbm", 0))
    new = pd.concat(frames, ignore_index=True)
    new.insert(0, "time", pd.Timestamp(today, tz="UTC"))  # the issue date; archive.write files rows by its month
    old = archive.read("outlook")
    if not old.empty:
        old = old[old["time"] != new["time"].iloc[0]]  # a second run on the same day replaces the first
    merged = pd.concat([old, new], ignore_index=True).sort_values(["time", "model", "member", "day"]).reset_index(drop=True)
    archive.write("outlook", merged, months={today.strftime("%Y-%m")})
    counts = new.groupby("model")["member"].nunique().to_dict()
    print(f"Outlook: saved {len(new)} rows for {today} ({counts})")
