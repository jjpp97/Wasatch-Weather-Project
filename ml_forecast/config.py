"""Every setting for the Machine Learning forecast, in one place."""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent          # ml_forecast/
PROJECT = ROOT.parent                                   # the website
RAW_DIR = ROOT / "data" / "raw"                         # station CSVs, exactly as downloaded
ARCHIVE_DIR = ROOT / "data" / "archive"                 # monthly Parquet files the daily job appends to
STATION_JSON = PROJECT / "data" / "alta-collins.json"   # kept up to date by scripts/fetch_stations.py
OUTPUT = PROJECT / "data" / "ml-forecast.json"          # what the Machine Learning tab reads

# Alta's Mid Collins snow study plot (Synoptic station CLN)
SITE = {"name": "Alta · Mid Collins", "station": "CLN", "lat": 40.5763, "lon": -111.6383,
        "elev_ft": 9662, "elev_m": 2945, "tz": "America/Denver"}

# The Forecast tab's three models, under their Open-Meteo names. `leads` are the lead days the
# Previous Runs API keeps for that model (0 = today, 1 = tomorrow, ...).
MODELS = {
    "gfs": {"name": "GFS + HRRR", "api": "gfs_seamless", "leads": range(0, 8)},
    "nbm": {"name": "NBM", "api": "ncep_nbm_conus", "leads": range(0, 8)},
    "nam": {"name": "NAM", "api": "ncep_nam_conus", "leads": range(0, 2)},
}
LEADS = range(0, 8)              # lead days corrected; later days stay the plain average
# Open-Meteo's archive has the NBM's snow water only from October 2025 (before that it is missing,
# or in Oct–Nov 2024 all labelled rain), so its snow counts only from then
SWE_FROM = {"nbm": "2025-10-01"}
BASELINE_ALONE = "nbm"           # Step 0b: this model on its own

PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast"
HISTORY_START = "2024-01-01"     # first day of station data in the CSV
FETCH_CHUNK_DAYS = 45            # days per Previous Runs request
FETCH_PAUSE_S = 2.0              # pause between requests (Open-Meteo's free tier is shared)
REFETCH_DAYS = 10                # the daily job fetches again this many days back

WINTER_MONTHS = (11, 12, 1, 2, 3, 4)   # November to April

# Step 1: per-model corrections, from past days only
TEMP_WINDOW_DAYS = 45            # temperature: average error over this many days
WIND_WINDOW_DAYS = 45            # wind: ratio of totals over this many days
PRECIP_WET_DAYS = 20             # precipitation: ratio of totals over this many most recent wet days
PRECIP_LOOKBACK_DAYS = 120       # ... found no further back than this
WET_DAY_IN = 0.05                # a wet day: measured or forecast liquid of at least this (inches)
MIN_WET_DAYS = 10                # fewer wet days than this: precipitation is left uncorrected
MIN_DAYS = 20                    # fewer days than this: temperature or wind is left uncorrected
RATIO_CLIP = (0.5, 2.0)          # multiplying factors are held within this range

# Data quality
MIN_HOURS = 20                   # hours of readings (or forecast) a day needs to count
MAX_HOURLY_PRECIP_IN = 0.5       # a gauge hour above this is a spike
MAX_DAILY_SNOW_IN = 60           # a board day above this is a sensor fault

SNOW_EVENT_IN = 1.0              # hits, misses and false alarms count days with at least this much snow