"""What each model forecast for Mid Collins, by lead day, from Open-Meteo's Previous Runs API.

For lead day N the API gives, for every hour, the value the model forecast N days before (lead 0
is its latest run). Hours are fetched and stored in UTC, then summed into Mountain-time days.
Snow water and snow are worked out the way the site's Forecast tab does it (see app.js
hourRows and modelSeries): the GFS's precipitation minus its rain and showers; the NBM's and NAM's
own snow water (Open-Meteo's snowfall_water_equivalent, which is their precipitation minus their
rain). Snow is that water times the Kuchera ratio. Past runs keep no upper-air temperatures, so
the ratio here comes from the 2 m temperature alone.
"""
import datetime as dt
import json
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
import pandas as pd

from . import archive, config

VARS = {"precipitation": "precip", "rain": "rain", "showers": "showers", "snowfall_water_equivalent": "swe_model",
        "temperature_2m": "temp", "wind_speed_10m": "wind"}


def suffix(lead):
    return "" if lead == 0 else f"_previous_day{lead}"


def get_json(url):
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as res:
                return json.load(res)
        except urllib.error.HTTPError as err:
            if err.code == 400:
                print("  refused:", err.read()[:200])
                return None
            time.sleep(60 if err.code == 429 else 5 * (attempt + 1))  # 429: over the rate limit
        except (urllib.error.URLError, TimeoutError):
            time.sleep(5 * (attempt + 1))
    return None


def fetch(key, start, end):
    """Hourly forecasts of one model for start..end (dates), every lead it keeps, as a long table."""
    m = config.MODELS[key]
    frames = []
    day = start
    while day <= end:
        last = min(end, day + dt.timedelta(days=config.FETCH_CHUNK_DAYS - 1))
        q = {"latitude": config.SITE["lat"], "longitude": config.SITE["lon"], "elevation": config.SITE["elev_m"],
             "models": m["api"], "start_date": day.isoformat(), "end_date": last.isoformat(), "timezone": "UTC",
             "precipitation_unit": "inch", "temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
             "hourly": ",".join(v + suffix(lead) for lead in m["leads"] for v in VARS)}
        j = get_json(config.PREVIOUS_RUNS_URL + "?" + urllib.parse.urlencode(q))
        time.sleep(config.FETCH_PAUSE_S)
        if j and "hourly" in j:
            h = j["hourly"]
            times = pd.to_datetime(h["time"], utc=True)
            for lead in m["leads"]:
                f = pd.DataFrame({"time": times, "model": key, "lead": lead})
                for api_name, col in VARS.items():
                    f[col] = pd.to_numeric(pd.Series(h.get(api_name + suffix(lead), [None] * len(times))), errors="coerce")
                frames.append(f.dropna(subset=["precip", "temp"], how="all"))
        print(f"  {m['name']}: {day} to {last}", "ok" if j else "failed")
        day = last + dt.timedelta(days=1)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def update_archive(today):
    """Fetch what is new (all of it the first time) into the archive; return every archived hour."""
    old = archive.read("forecasts")
    first = dt.date.fromisoformat(config.HISTORY_START)
    start = first if old.empty else max(first, old["time"].max().date() - dt.timedelta(days=config.REFETCH_DAYS))
    print(f"Previous Runs: fetching {start} to {today}")
    new = pd.concat([fetch(key, start, today) for key in config.MODELS], ignore_index=True)
    if new.empty:
        return old
    if not old.empty:
        old = old[old["time"] < pd.Timestamp(start, tz="UTC")]  # the fresh download replaces the overlap
    merged = pd.concat([old, new], ignore_index=True).sort_values(["time", "model", "lead"]).reset_index(drop=True)
    touched = set(new["time"].dt.strftime("%Y-%m"))
    archive.write("forecasts", merged, months=touched)
    return merged


def kuchera(temp_f):
    """Kuchera snow-to-liquid ratio from a temperature in °F (as app.js kucheraSLR); 10 when unknown."""
    tk = (np.asarray(temp_f, float) - 32) * 5 / 9 + 273.15
    slr = np.where(tk > 271.16, 12 + 2 * (271.16 - tk), 12 + (271.16 - tk))
    return np.where(np.isnan(tk), 10.0, np.clip(slr, 3, 30))


def daily(hours):
    """One row per model, lead day and Mountain-time day: liquid, snow water, snow, mean temperature and wind."""
    h = hours.copy()
    h["day"] = pd.to_datetime(h["time"].dt.tz_convert(config.SITE["tz"]).dt.date)
    gfs_way = (h["precip"] - h["rain"].fillna(0) - h["showers"].fillna(0)).clip(lower=0)
    h["swe"] = np.where(h["model"] == "gfs", gfs_way, h["swe_model"])
    # Where the archive's snow water for a model can't be trusted yet, it is left out (not filled in)
    for model, first in config.SWE_FROM.items():
        h.loc[(h["model"] == model) & (h["day"] < pd.Timestamp(first)), "swe"] = np.nan
    h["snow"] = h["swe"] * kuchera(h["temp"])
    g = h.groupby(["model", "lead", "day"])
    out = pd.DataFrame({
        "precip": g["precip"].sum(min_count=1),
        "swe": g["swe"].sum(min_count=1),
        "snow": g["snow"].sum(min_count=1),
        "temp": g["temp"].mean(),
        "wind": g["wind"].mean(),
        "hours": g["precip"].count(),
        "swe_hours": g["swe"].count(),
    })
    out.loc[out["swe_hours"] < config.MIN_HOURS, ["swe", "snow"]] = np.nan  # too little snow water that day
    out = out[out["hours"] >= config.MIN_HOURS].drop(columns=["hours", "swe_hours"])
    return out.reset_index()
