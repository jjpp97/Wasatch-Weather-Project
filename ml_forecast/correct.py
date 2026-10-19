"""Step 1: each model's usual mistake at Mid Collins, per lead day, from past days only.

Every function takes day-by-day arrays on one continuous calendar (`obs` measured, `fc` one
model's forecast at one lead day) and a `cutoff`: the position of the day the forecast is made.
Only days before it are used, so a correction never sees the day it is applied to.

  precipitation  multiply by (measured ÷ forecast) over the last PRECIP_WET_DAYS wet days
  temperature    add the average of (measured − forecast) over the last TEMP_WINDOW_DAYS days
  wind           multiply by (measured ÷ forecast) over the last WIND_WINDOW_DAYS days

Factors are held within RATIO_CLIP. With too little data the result is None: uncorrected.

Steps 2–4 (regression, LightGBM, a snow-to-liquid model) would each be one more module like this
one that returns the same kind of numbers, scored by backtest.py the same way.
"""
import numpy as np

from . import config


def _both(o, f):
    ok = ~np.isnan(o) & ~np.isnan(f)
    return o[ok], f[ok]


def ratio_wet(obs, fc, cutoff, wet=config.WET_DAY_IN):
    """(factor, wet days used) from the most recent wet days before `cutoff`."""
    lo = max(0, cutoff - config.PRECIP_LOOKBACK_DAYS)
    o, f = _both(obs[lo:cutoff], fc[lo:cutoff])
    keep = (o >= wet) | (f >= wet)
    o, f = o[keep][-config.PRECIP_WET_DAYS:], f[keep][-config.PRECIP_WET_DAYS:]
    if len(o) < config.MIN_WET_DAYS or f.sum() <= 0:
        return None, len(o)
    return float(np.clip(o.sum() / f.sum(), *config.RATIO_CLIP)), len(o)


def offset(obs, fc, cutoff):
    """(degrees to add, days used) over the last TEMP_WINDOW_DAYS days before `cutoff`."""
    o, f = _both(obs[max(0, cutoff - config.TEMP_WINDOW_DAYS):cutoff], fc[max(0, cutoff - config.TEMP_WINDOW_DAYS):cutoff])
    if len(o) < config.MIN_DAYS:
        return None, len(o)
    return float((o - f).mean()), len(o)


def ratio_all(obs, fc, cutoff):
    """(factor, days used) over the last WIND_WINDOW_DAYS days before `cutoff`."""
    o, f = _both(obs[max(0, cutoff - config.WIND_WINDOW_DAYS):cutoff], fc[max(0, cutoff - config.WIND_WINDOW_DAYS):cutoff])
    if len(o) < config.MIN_DAYS or f.sum() <= 0:
        return None, len(o)
    return float(np.clip(o.sum() / f.sum(), *config.RATIO_CLIP)), len(o)


# What each corrected quantity is measured against, and how it is corrected
KINDS = {
    "precip": ("liquid", ratio_wet),
    "temp": ("temp", offset),
    "wind": ("wind", ratio_all),
}


def apply(kind, value, corr):
    """A forecast value with its correction (unchanged when there is none)."""
    if corr is None or value is None or np.isnan(value):
        return value
    return value + corr if kind == "temp" else value * corr
