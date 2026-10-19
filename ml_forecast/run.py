"""The daily job: update the archive, test every step, work out today's corrections, write data/ml-forecast.json.

Run from the website's folder:   python -m ml_forecast.run
"""
import datetime as dt
import json
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from . import backtest, config, correct, forecasts, outlook, station

NEEDS = {"precip": config.MIN_WET_DAYS, "temp": config.MIN_DAYS, "wind": config.MIN_DAYS}


def live_corrections(dates, O, F):
    """Today's correction for every model, lead day and quantity, with why one is missing."""
    cutoff = len(dates) - 1  # today: every day before it is known
    out = {}
    for m, model in config.MODELS.items():
        out[m] = {}
        for lead in config.LEADS:
            entry = {}
            for kind, (obs_col, fn) in correct.KINDS.items():
                if lead not in model["leads"] or (m, lead) not in F:
                    entry[kind] = {"value": None, "n": 0, "status": "no_history"}
                    continue
                v, n = fn(O[obs_col], F[(m, lead)][kind], cutoff)
                entry[kind] = {"value": None if v is None else round(v, 3), "n": n, "needs": NEEDS[kind],
                               "status": "ok" if v is not None else "too_few"}
            out[m][lead] = entry
    return out


def data_used(dates, O, F, today):
    """Per model and lead day: the overlap with the station and the winter days in it."""
    past = dates < pd.Timestamp(today)
    winter = np.isin(dates.month, config.WINTER_MONTHS) & past
    out = {}
    for m in config.MODELS:
        out[m] = {}
        for lead in config.LEADS:
            if (m, lead) not in F:
                continue
            both = past & ~np.isnan(O["liquid"]) & ~np.isnan(F[(m, lead)]["precip"])
            if not both.any():
                continue
            out[m][lead] = {"first": dates[both][0].strftime("%Y-%m-%d"), "last": dates[both][-1].strftime("%Y-%m-%d"),
                            "winter_days": int((both & winter).sum()),
                            "wind_winter_days": int((winter & ~np.isnan(O["wind"]) & ~np.isnan(F[(m, lead)]["wind"])).sum())}
    return out


def station_summary(obs):
    have = lambda c: obs.index[obs[c].notna()]
    return {"first": have("liquid")[0].strftime("%Y-%m-%d"), "last": have("liquid")[-1].strftime("%Y-%m-%d"),
            "wind_first": have("wind")[0].strftime("%Y-%m-%d") if len(have("wind")) else None,
            "snow_days": int(obs["snow"].notna().sum())}


def report(metrics, corrections, used):
    """The first-run questions, answered on the console."""
    print("\nSnow MAE (inches/day), winter days, same days for every step:")
    print("  lead  days   0a avg   0b NBM   1 corr   check   skill1   winner")
    for lead, r in metrics.items():
        s = r["snow"]
        if not s["0a"]["days"]:
            continue
        best = min(("0a", "0b", "1"), key=lambda k: s[k]["mae"])
        print(f"  Day {lead}  {s['0a']['days']:4d}  {s['0a']['mae']:7.3f}  {s['0b']['mae']:7.3f}  {s['1']['mae']:7.3f}"
              f"  {s['check']['mae']:6.3f}  {s['1']['skill']:+7.1%}   {best}")
    print("\nTemperature / wind MAE, Step 0a vs Step 1:")
    for lead, r in metrics.items():
        t, w = r["temp"], r["wind"]
        print(f"  Day {lead}: temp {t['0a']['mae']} -> {t['1']['mae']} °F ({t['0a']['days']} d);"
              f" wind {w['0a']['mae']} -> {w['1']['mae']} mph ({w['0a']['days']} d)")
    print("\nToday's corrections (precipitation factor / temperature offset / wind factor):")
    for m, leads in corrections.items():
        for lead, e in leads.items():
            if e["precip"]["status"] == "no_history":
                continue
            v = lambda k: "–" if e[k]["value"] is None else f"{e[k]['value']:+.2f}" if k == "temp" else f"×{e[k]['value']:.2f}"
            print(f"  {config.MODELS[m]['name']:10s} Day {lead}: {v('precip'):>6s} {v('temp'):>6s} {v('wind'):>6s}")
    print("\nWinter days trained on (Day 1):", {m: u.get(1, {}).get("winter_days") for m, u in used.items()})


def main():
    today = dt.datetime.now(ZoneInfo(config.SITE["tz"])).date()
    print("Station: merging the CSVs and data/alta-collins.json")
    obs = station.daily(station.update_archive())
    fc = forecasts.daily(forecasts.update_archive(today))
    try:
        outlook.save(today)  # the Days 8–16 ensembles, kept so they can be scored later
    except Exception as err:  # a missed day only leaves a gap in that record; the rest still runs
        print("Outlook not saved:", err)
    dates, O, F = backtest.calendar(obs, fc, today)
    print("Walk-forward test")
    metrics, track = backtest.run(dates, O, F, today)
    corrections = live_corrections(dates, O, F)
    used = data_used(dates, O, F, today)
    out = {
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "site": config.SITE,
        "models": {m: {"name": v["name"], "api": v["api"], "leads": list(v["leads"])} for m, v in config.MODELS.items()},
        "leads": list(config.LEADS),
        "settings": {k: getattr(config, k) for k in ("TEMP_WINDOW_DAYS", "WIND_WINDOW_DAYS", "PRECIP_WET_DAYS",
                     "PRECIP_LOOKBACK_DAYS", "WET_DAY_IN", "MIN_WET_DAYS", "MIN_DAYS", "RATIO_CLIP", "SNOW_EVENT_IN")},
        "corrections": corrections,
        "metrics": metrics,
        "track": track,
        "data_used": {"station": station_summary(obs), "models": used},
    }
    config.OUTPUT.write_text(json.dumps(out, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {config.OUTPUT.relative_to(config.PROJECT)}")
    report(metrics, corrections, used)


if __name__ == "__main__":
    main()
