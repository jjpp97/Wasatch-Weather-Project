# Machine Learning forecast for Alta (Mid Collins)

This folder makes the numbers behind the site's **Machine Learning** tab. It is a snow forecast
for Alta's Mid Collins study plot (station CLN, 9,662 ft) that learns from its own mistakes,
built one step at a time.

| Step | What it is | Status |
|---|---|---|
| 0a | The plain average of GFS + HRRR, NBM and NAM (what the Forecast tab shows) | baseline |
| 0b | The NBM on its own | baseline |
| 1 | Each model corrected for its usual mistake at Collins, then averaged | **built** |
| 2–4 | Regression, LightGBM, a snow-to-liquid model | not yet |

## What Step 1 does, in plain words

For every model and every lead day (Day 0 = today, Day 1 = tomorrow, … Day 7), it looks at the
recent past and asks "how far off was this model at Collins?":

- **Precipitation:** total water the Collins gauge caught on the last 20 wet days, divided by
  what the model forecast for those days. If the model forecast 1.0" and Collins got 1.3", the
  factor is 1.3, and that model's forecast is multiplied by 1.3. The corrected water then becomes
  snow the same way the Forecast tab does it (the Kuchera snow ratio).
- **Temperature:** the model's average error over the last 45 days is added (too cold by 2 °F → add 2 °F).
- **Wind:** measured ÷ forecast over the last 45 days.

Factors are kept between 0.5 and 2. A model/lead day with too little data (fewer than 10 wet
days, or 20 days for temperature and wind) is left uncorrected and flagged.

## Days 8–16

The Previous Runs archive stops at Day 7, so Days 8–16 can't be bias-corrected yet. On the
tab, Days 8–11 show the models' average, uncorrected (the NBM ends about Day 10, leaving the
GFS), and Days 12–16 show the **GFS ensemble outlook**: the average of its 31 runs. Open-Meteo
keeps no history of past ensemble forecasts, so `outlook.py` saves every run's daily forecast
each morning to `data/archive/outlook/`: the GFS ensemble, the ECMWF ensemble and the NBM.
After a winter, they can be scored against Collins and corrected the way Days 0–7 are.

**Why correct the liquid and not the snow?** Collins has a heated liquid gauge, and it holds up:
in winter 2024-25 it caught 36.8" of water against roughly 450" on the snow board, a believable
12 to 1. The board, by contrast, is cleared twice a day and has sensor spikes. So precipitation
is corrected against the gauge, and the result is scored against the board. As a check, the job
also scores correcting snow directly against the board (the `check` column in the output).

## How it is tested

A **walk-forward test**: every winter day (November–April) since the data starts is "forecast"
using only what was known on the day the forecast was made, then compared with what fell. No
random splits. Every step is scored on exactly the same days. The scores are:

- **MAE**: average miss per day, in inches of snow (also °F for temperature, mph for wind)
- **Skill** = 1 − MAE ÷ MAE of the plain average. Positive means better than the plain average.
- **Season totals**, and **hits / misses / false alarms** for days with 1" or more

## Data

| What | Where from | Notes |
|---|---|---|
| Station, 2024-01 to 2026-10 | `data/raw/*.csv`, a Synoptic Data Viewer download | kept exactly as downloaded |
| Station, newer hours | `../data/alta-collins.json` | appended hourly by `scripts/fetch_stations.py` |
| Model forecasts | Open-Meteo **Previous Runs API** | `gfs_seamless`, `ncep_nbm_conus`, `ncep_nam_conus` |

How much forecast history exists (precipitation, at Collins):

- **GFS + HRRR**: from 2024-01-19, Days 0–7
- **NBM**: from 2024-10-08, Days 0–7
- **NAM**: from 2025-09-01, Days 0–1 only, about 6 days missing every 2 weeks

Snow water is each model's own: the GFS's precipitation minus its rain and showers, and the NBM's
and NAM's `snowfall_water_equivalent` (their precipitation minus their rain), the same as on the
site. Their snowfall figures aren't used, because each model makes them at its own snow ratio (the
NBM's is about 12 to 1). Open-Meteo's archive has the NBM's snow water only from October 2025, so
its snow, and with it every step's snow score, starts then (`SWE_FROM` in `config.py`).

Only days where a model has a forecast **and** Collins has a measurement are used. Nothing is
filled in. Past runs keep no upper-air temperatures, so in the test snow comes from the 2 m
temperature's Kuchera ratio (the same for every step). The live tab uses the Forecast tab's full
calculation.

Times are stored in UTC. Days are midnight to midnight Mountain time, the same days as the
Snow Summary bars (Alta's official report runs 7 AM to 7 AM, so totals differ a little).

Everything is archived in `data/archive/` as one Parquet file per month: `station/` holds the
cleaned hourly readings, `forecasts/` each model's hourly forecast at every lead day. The daily
run only rewrites the months that changed.

## Files

| File | Job |
|---|---|
| `config.py` | every setting (window sizes, thresholds, models) |
| `station.py` | reads and cleans the Collins readings; daily water, snow, temperature, wind |
| `forecasts.py` | downloads Previous Runs; daily totals per model and lead day |
| `archive.py` | the monthly Parquet files |
| `correct.py` | Step 1: the corrections |
| `backtest.py` | the walk-forward test and its scores |
| `outlook.py` | saves each day's ensemble and NBM forecasts for Days 8–16 |
| `run.py` | runs it all and writes `../data/ml-forecast.json` |

Steps 2–4 would each be a new module like `correct.py`, scored by `backtest.py` the same way.

## Running it

It runs every morning on GitHub Actions (`.github/workflows/ml-forecast.yml`, 13:40 UTC) and
commits the archive and `data/ml-forecast.json`. You can also start it from the repo's
**Actions** tab ("Machine Learning forecast" → "Run workflow").

To run it by hand, from the website's folder (the one holding `index.html`):

```
pip install -r ml_forecast/requirements.txt
python -m ml_forecast.run
```

The first run downloads all the history (about 70 requests, a few minutes). Later runs fetch
only the last 10 days. It needs no API key.

### Running it on a home server instead

The same two commands work on any machine with Python 3.10 or newer. To run it daily:

- **Linux / Mac (cron):** `crontab -e`, then add
  `40 7 * * * cd /path/to/Wasatch-Weather-Project && git pull -q && python3 -m ml_forecast.run && git add ml_forecast/data/archive data/ml-forecast.json && git commit -qm "Update Machine Learning forecast" && git push -q`
  (7:40 AM in the server's time zone).
- **Windows (Task Scheduler):** create a daily task at 7:40 AM that runs `python -m ml_forecast.run`
  with "Start in" set to the website's folder, followed by the same git commands.

If you move it home, turn off the GitHub workflow (Actions tab → the workflow → "Disable") so
the two don't both push.

## Adding station data

Download another CSV from the Synoptic Data Viewer (station CLN, metric units), drop it in
`data/raw/` unchanged, and run the job. The CSVs win over `alta-collins.json` for the hours they cover.

## Credits

Forecast data: [Open-Meteo](https://open-meteo.com/), CC BY 4.0. Station data: Alta – Collins (CLN) via Synoptic Data.
