"""The data archive: one Parquet file per kind of data per month (UTC), e.g. archive/forecasts/2026-01.parquet.

A month's file is only rewritten when its contents change, so the daily job touches one or two
small files and the git history stays small.
"""
import pandas as pd

from . import config


def read(kind):
    """Everything archived for `kind` ("station" or "forecasts"), or an empty frame."""
    files = sorted((config.ARCHIVE_DIR / kind).glob("*.parquet"))
    if not files:
        return pd.DataFrame()
    return pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)


def write(kind, df, months=None):
    """Write `df` (with a UTC `time` column) month by month; `months` limits which months ("YYYY-MM")."""
    folder = config.ARCHIVE_DIR / kind
    folder.mkdir(parents=True, exist_ok=True)
    month = df["time"].dt.strftime("%Y-%m")
    for m, part in df.groupby(month):
        if months is not None and m not in months:
            continue
        part = part.reset_index(drop=True)
        path = folder / f"{m}.parquet"
        if path.exists():
            old = pd.read_parquet(path)
            if old.shape == part.shape and old.equals(part):
                continue
        part.to_parquet(path, index=False)
