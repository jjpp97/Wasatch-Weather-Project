"""Walk-forward test: every past winter day, forecast the way each step would have on the day, then score.

  Step 0a  the plain average of the models (the Forecast tab today)
  Step 0b  the NBM on its own
  Step 1   each model corrected (correct.py), then averaged
  check    Step 1 with snow corrected directly against the board instead of liquid against the gauge

For a day D at lead day L, the forecast was made on day D − L, so its corrections use only days
before that. No random splits: days are taken in order. Only November–April is scored, and each
step is scored on exactly the same days. A model is in an average only on days it has data.
"""
import numpy as np
import pandas as pd

from . import config, correct

STEPS = ("0a", "0b", "1")
SNOW_WET_IN = 0.5   # the snow-direct check's wet day: measured or forecast snow of at least this


def winter_of(day):
    y = day.year
    return f"{y}-{(y + 1) % 100:02d}" if day.month >= 11 else f"{y - 1}-{y % 100:02d}"


def calendar(obs, fc, today):
    """Every quantity as one array per day on a continuous calendar ending today."""
    dates = pd.date_range(min(obs.index.min(), fc["day"].min()), pd.Timestamp(today), freq="D")
    O = {c: obs[c].reindex(dates).to_numpy(float) for c in ("liquid", "snow", "temp", "wind")}
    F = {}
    for (m, lead), g in fc.groupby(["model", "lead"]):
        g = g.set_index("day").reindex(dates)
        F[(m, lead)] = {c: g[c].to_numpy(float) for c in ("precip", "swe", "snow", "temp", "wind")}
    return dates, O, F


def nanmean(arrays):
    a = np.vstack(arrays)
    n = (~np.isnan(a)).sum(0)
    return np.where(n > 0, np.nansum(a, 0) / np.maximum(n, 1), np.nan)


def walk_forward(dates, O, F):
    """{(model, lead, kind): the correction each day would have used (NaN where none)}."""
    n = len(dates)
    out = {}
    for (m, lead), f in F.items():
        jobs = {kind: (O[obs_col], f[kind], fn) for kind, (obs_col, fn) in correct.KINDS.items()}
        jobs["snow"] = (O["snow"], f["snow"], lambda o, x, c: correct.ratio_wet(o, x, c, wet=SNOW_WET_IN))
        for kind, (o, x, fn) in jobs.items():
            arr = np.full(n, np.nan)
            for i in range(n):
                if np.isnan(x[i]) or i - lead <= 0:
                    continue
                v, _ = fn(o, x, i - lead)
                if v is not None:
                    arr[i] = v
            out[(m, lead, kind)] = arr
    return out


def steps_at(lead, F, corr):
    """Each step's daily snow, liquid, temperature and wind at one lead day."""
    members = [m for m in config.MODELS if (m, lead) in F]

    def fixed(m, field, kind):
        raw, c = F[(m, lead)][field], corr[(m, lead, kind)]
        return np.where(np.isnan(c), raw, raw + c if kind == "temp" else raw * c)

    out = {}
    for field, kind in (("snow", "precip"), ("precip", "precip"), ("temp", "temp"), ("wind", "wind")):
        out[field] = {
            "0a": nanmean([F[(m, lead)][field] for m in members]),
            "0b": F[(config.BASELINE_ALONE, lead)][field],
            "1": nanmean([fixed(m, field, kind) for m in members]),
        }
    out["snow"]["check"] = nanmean([fixed(m, "snow", "snow") for m in members])
    return out


def scores(pred, obs, mask):
    p, o = pred[mask], obs[mask]
    s = {"mae": round(float(np.abs(p - o).mean()), 3) if len(o) else None, "days": int(mask.sum())}
    return s


def snow_scores(pred, obs, mask):
    s = scores(pred, obs, mask)
    p, o = pred[mask], obs[mask]
    ev = config.SNOW_EVENT_IN
    s.update(total=round(float(p.sum()), 1), observed=round(float(o.sum()), 1),
             hits=int(((p >= ev) & (o >= ev)).sum()), misses=int(((p < ev) & (o >= ev)).sum()),
             false_alarms=int(((p >= ev) & (o < ev)).sum()))
    return s


def add_skill(block):
    base = block["0a"]["mae"]
    for k, s in block.items():
        s["skill"] = None if not base or s["mae"] is None else round(1 - s["mae"] / base, 3)


def run(dates, O, F, today):
    corr = walk_forward(dates, O, F)
    winter = np.isin(dates.month, config.WINTER_MONTHS) & (dates < pd.Timestamp(today))
    seasons = np.array([winter_of(d) for d in dates])
    metrics, by_lead = {}, {}
    for lead in config.LEADS:
        s = steps_at(lead, F, corr)
        by_lead[lead] = s
        res = {}
        for field, obs_col in (("snow", "snow"), ("precip", "liquid"), ("temp", "temp"), ("wind", "wind")):
            preds = s[field]
            mask = winter & ~np.isnan(O[obs_col])
            for p in preds.values():
                mask &= ~np.isnan(p)
            fn = snow_scores if field == "snow" else scores
            block = {k: fn(p, O[obs_col], mask) for k, p in preds.items()}
            add_skill(block)
            res[field] = block
            if field == "snow":
                res["seasons"] = {w: {k: round(float(p[mask & (seasons == w)].sum()), 1) for k, p in preds.items()}
                                  | {"observed": round(float(O["snow"][mask & (seasons == w)].sum()), 1),
                                     "days": int((mask & (seasons == w)).sum())}
                                  for w in sorted(set(seasons[mask]))}
        metrics[lead] = res

    # The track record: the most recent winter with scored days, every lead day
    scored = [w for lead in metrics for w in metrics[lead]["seasons"]]
    latest = max(scored) if scored else None
    track = {"winter": latest, "dates": [], "observed": [], "leads": {}}
    if latest:
        sel = (seasons == latest) & np.isin(dates.month, config.WINTER_MONTHS) & (dates < pd.Timestamp(today))
        nums = lambda a: [None if np.isnan(v) else round(float(v), 2) for v in a[sel]]
        track["dates"] = [d.strftime("%Y-%m-%d") for d in dates[sel]]
        track["observed"] = nums(O["snow"])
        for lead, s in by_lead.items():
            track["leads"][lead] = {k: nums(s["snow"][k]) for k in STEPS}
    return metrics, track
