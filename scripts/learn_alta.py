"""Learn which blend of weather models forecasts Alta's snow best, and keep learning every day.

Run once a day by .github/workflows/learning.yml (no token needed). Each run:

  1. Snapshot. For each 6 AM (12Z) "issue time" not yet done, rebuild what every model said for
     the next 16 days at Mid-Collins, from Open-Meteo's archive of single model runs, using only
     runs that would have been downloadable by then. Four versions of each model's snow water:
       split   / elev     the model's own rain/snow split, or the elevation fix (rain or snow
                          decided from the wet-bulb temperature at Collins's height, plus more
                          precipitation for the height, as on the Beta tab)
       newest  / blended  the newest run only, or recent runs weighted by age (Beta's half-lives)
  2. Verify. For each forecast day that has now finished and has measured snow at Collins
     (data/alta-collins.json, counted the way the page counts it), turn each version's hourly snow
     water into snow with the hourly Kuchera ratio from the day's actual temperatures (the same for
     every version, so only the models and versions differ) and store a sample.
  3. Learn. For each forecast range (BUCKETS) and each version, fit the weight of each model and
     an overall scale factor that best match the measured snow, favouring recent samples and
     staying close to an even average until there are enough storms. Every approach is scored on
     forecasts it would have made before seeing the outcome (each day it is refitted on earlier
     days only), so the scores show how it would really have done.
  4. Write data/alta-learning.json for the Beta tab: the approach recommended for each forecast
     day, the scores of every approach, and a daily history of the recommendations.

The working state (snapshots waiting for their days to finish, and the samples) is kept in
data/alta-learning-state.json.

    python scripts/learn_alta.py
"""
import datetime as dt
import json
import math
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

DATA = pathlib.Path(__file__).resolve().parent.parent / "data"
OUT, STATE, TRUTH = DATA / "alta-learning.json", DATA / "alta-learning-state.json", DATA / "alta-collins.json"

SITE = {"name": "Alta · Mid-Collins", "lat": 40.5763, "lon": -111.6383, "elev_m": 2945.0, "tz": "America/Denver"}
# every/back: hours between the archive's runs and how far back to blend; days: forecast length;
# delay: hours from a run's start until it can be downloaded; cell: the model's ground height at
# Collins in metres (Open-Meteo, elevation=nan); upper: the archive keeps its 700 hPa level
MODELS = {
    "hrrr": {"id": "ncep_hrrr_conus", "every": 3, "back": 18, "days": 3, "delay": 1.9, "cell": 2825, "upper": True},
    "gfs": {"id": "ncep_gfs013", "every": 6, "back": 30, "days": 16, "delay": 5.4, "cell": 2508},
    "nbm": {"id": "ncep_nbm_conus", "every": 3, "back": 27, "days": 12, "delay": 1.4, "cell": 2905},
    "nam": {"id": "ncep_nam_conus", "every": 6, "back": 24, "days": 3, "delay": 2.7, "cell": 2896},
    "ecmwf": {"id": "ecmwf_ifs", "every": 6, "back": 30, "days": 16, "delay": 6.4, "cell": 2775},
}
# The models weighed against each other. The HRRR stands in for the GFS while its runs reach an hour.
MEMBERS = {"gfs": ["hrrr", "gfs"], "nbm": ["nbm"], "nam": ["nam"], "ecmwf": ["ecmwf"]}
MEMBER_NAMES = {"gfs": "GFS + HRRR", "nbm": "NBM", "nam": "NAM", "ecmwf": "ECMWF"}
VARIANTS = {"split": "model's rain/snow split", "elev": "elevation fix"}
BLENDS = {"newest": "newest runs", "blended": "recent runs blended"}
HALF_LIFE = [(0, 3), (24, 3), (48, 5), (120, 12)]  # hours ahead -> hours of age that halve a run's weight
LEAD_DAYS = 16
BUCKETS = [("Day 1", 1, 1), ("Day 2", 2, 2), ("Day 3", 3, 3), ("Days 4–5", 4, 5),
           ("Days 6–7", 6, 7), ("Days 8–10", 8, 10), ("Days 11–16", 11, 16)]
ELEV_QPF = 0.08              # more precipitation per 1,000 ft the model's ground sits below Collins
RECENCY_DAYS = 90            # a sample's weight halves for every this many days of age
PRIOR_SAMPLES = 6            # how strongly the fit is held near an even average and a scale of 1
MIN_SAMPLES = 6              # informative samples a range needs before an approach can be recommended
MIN_SNOW_DAYS = 4            # ... and how many different days with measured snow they must cover, so
                             # one storm cannot decide it on its own
WET = 0.1                    # inches: a day counts if measured or forecast snow reaches this
MAX_BACKFILL = 40            # issue times rebuilt per run at most (the first run catches up)


# ---------- Mountain time, without a time zone database ----------
def mt_offset(utc):
    """Hours from UTC to Mountain time: -6 from the second Sunday of March (2 AM) to the first Sunday of November."""
    y = utc.year
    march = dt.datetime(y, 3, 8, 9, tzinfo=dt.timezone.utc)
    start = march + dt.timedelta(days=(6 - march.weekday()) % 7)
    nov = dt.datetime(y, 11, 1, 8, tzinfo=dt.timezone.utc)
    end = nov + dt.timedelta(days=(6 - nov.weekday()) % 7)
    return -6 if start <= utc < end else -7


def local_hour(utc):
    return (utc + dt.timedelta(hours=mt_offset(utc))).strftime("%Y-%m-%dT%H:00")


def today_local():
    return local_hour(dt.datetime.now(dt.timezone.utc))[:10]


# ---------- Downloads ----------
_cache = {}


def get_json(url):
    if url in _cache:
        return _cache[url]
    data = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=60) as res:
                data = json.load(res)
            break
        except urllib.error.HTTPError as err:
            if err.code == 400:  # the archive does not have this run
                break
            time.sleep(3 + 5 * attempt)
        except (urllib.error.URLError, TimeoutError):
            time.sleep(3 + 5 * attempt)
    time.sleep(0.12)
    _cache[url] = data
    return data


# ---------- The elevation fix (as on the Beta tab) ----------
def site_temp(cell, t_down, t700=None, z700=None):
    site = SITE["elev_m"]
    if t_down is None:
        return None
    if t700 is None or z700 is None or not (z700 > site > cell):
        return t_down
    t_cell = t_down + 0.0065 * (site - cell)
    return t_cell + (t700 - t_cell) * (site - cell) / (z700 - cell)


def wet_bulb(t, rh):
    if t is None or rh is None:
        return None
    return (t * math.atan(0.151977 * math.sqrt(rh + 8.313659)) + math.atan(t + rh) - math.atan(rh - 1.676331)
            + 0.00391838 * rh ** 1.5 * math.atan(0.023101 * rh) - 4.686035)


def snow_share(tw):
    return min(1.0, max(0.0, (35 - (tw * 9 / 5 + 32)) / 3))


def qpf_factor(cell):
    return 1 + ELEV_QPF * max(0.0, SITE["elev_m"] - cell) / 304.8


def kuchera(temps_f):
    temps = [t for t in temps_f if t is not None]
    if not temps:
        return 10.0
    tk = (max(temps) - 32) * 5 / 9 + 273.15
    slr = 12 + 2 * (271.16 - tk) if tk > 271.16 else 12 + (271.16 - tk)
    return min(max(slr, 3.0), 30.0)


# ---------- One model run ----------
def run_hours(key, init):
    """{local hour: (split snow water, elevation-fix snow water)} for one archived run, or None."""
    m = MODELS[key]
    hourly = "precipitation,rain,showers,snowfall,temperature_2m,relative_humidity_2m"
    if m.get("upper"):
        hourly += ",temperature_700hPa,geopotential_height_700hPa"
    q = {"latitude": SITE["lat"], "longitude": SITE["lon"], "elevation": SITE["elev_m"], "timezone": SITE["tz"],
         "hourly": hourly, "models": m["id"], "run": init.strftime("%Y-%m-%dT%H:%M"),
         "forecast_days": m["days"], "precipitation_unit": "inch"}
    j = get_json("https://single-runs-api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(q))
    if not j or "hourly" not in j:
        return None
    h = j["hourly"]
    col = lambda name, i: (h.get(name) or [None] * len(h["time"]))[i]
    out = {}
    for i, t in enumerate(h["time"]):
        p = col("precipitation", i)
        if p is None:
            continue
        if key == "gfs":
            split = max(0.0, p - (col("rain", i) or 0) - (col("showers", i) or 0))
        else:
            s = col("snowfall", i)
            split = None if s is None else s / 7
        temp = site_temp(m["cell"], col("temperature_2m", i), col("temperature_700hPa", i), col("geopotential_height_700hPa", i))
        tw = wet_bulb(temp, col("relative_humidity_2m", i))
        elev = None if tw is None else p * qpf_factor(m["cell"]) * snow_share(tw)
        out[t] = (split, elev)
    return out or None


_runs = {}


def runs_at(key, issue):
    """Every archived run of one model downloadable by `issue` and started within its blending window."""
    m = MODELS[key]
    found = []
    t = issue.replace(hour=issue.hour - issue.hour % m["every"], minute=0, second=0, microsecond=0)
    while t >= issue - dt.timedelta(hours=m["back"]):
        if t + dt.timedelta(hours=m["delay"]) <= issue:
            if (key, t) not in _runs:
                _runs[(key, t)] = run_hours(key, t)
            if _runs[(key, t)]:
                found.append((t, _runs[(key, t)]))
        t -= dt.timedelta(hours=m["every"])
    return found


def half_life(lead):
    if lead <= HALF_LIFE[0][0]:
        return HALF_LIFE[0][1]
    for (x0, y0), (x1, y1) in zip(HALF_LIFE, HALF_LIFE[1:]):
        if lead <= x1:
            return y0 + (y1 - y0) * (lead - x0) / (x1 - x0)
    return HALF_LIFE[-1][1]


# ---------- Step 1: snapshot one issue time ----------
def snapshot(issue):
    """Every model's four versions, hour by hour, for the 16 days after `issue` (sparse: zeros left out)."""
    runs = {key: runs_at(key, issue) for key in MODELS}
    series = {mem: {v: {b: {} for b in BLENDS} for v in VARIANTS} for mem in MEMBERS}
    cover = {mem: [None, None] for mem in MEMBERS}
    for k in range(LEAD_DAYS * 24):
        t = local_hour(issue + dt.timedelta(hours=k))
        for mem, pools in MEMBERS.items():
            for key in pools:
                have = [(init, hours[t]) for init, hours in runs[key] if t in hours]
                if not have:
                    continue
                ages = [(issue - init).total_seconds() / 3600 for init, _ in have]
                hl = half_life(k)
                w = [0.5 ** (a / hl) for a in ages]
                newest = ages.index(min(ages))
                for vi, v in enumerate(VARIANTS):
                    vals = [(val[vi], wi) for (_, val), wi in zip(have, w) if val[vi] is not None]
                    if not vals:
                        continue
                    nv = have[newest][1][vi]
                    blended = sum(x * wi for x, wi in vals) / sum(wi for _, wi in vals)
                    for b, x in (("newest", nv), ("blended", blended)):
                        if x is not None and x > 0.0005:
                            series[mem][v][b][t] = round(x, 4)
                cover[mem] = [cover[mem][0] or t, t]
                break
    return {"issue": issue.strftime("%Y-%m-%dT%H:%MZ"), "issue_local": local_hour(issue), "series": series,
            "cover": cover, "done": []}


# ---------- Step 2: what was measured ----------
def measured_days():
    """{local date: {"snow": inches, "readings": count}} from the Collins snow board, counted as the page counts it."""
    col = json.loads(TRUTH.read_text(encoding="utf-8"))
    ci = {c: i for i, c in enumerate(col["columns"])}
    rows = []
    for r in col["rows"]:
        if r[ci["snow_interval"]] is None:
            continue
        utc = dt.datetime.strptime(r[0], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        rows.append((local_hour(utc)[:10], r[ci["snow_interval"]], r[ci["air_temp"]]))
    steady = [r for i, r in enumerate(rows) if not (0 < i < len(rows) - 1 and r[1] - rows[i - 1][1] > 3
              and r[1] - rows[i + 1][1] > 3 and abs(rows[i + 1][1] - rows[i - 1][1]) <= 1)]
    days, peak = {}, None
    for day, board, temp in rows:
        days.setdefault(day, {"snow": 0.0, "readings": 0})["readings"] += 1
    for day, board, temp in steady:
        if temp is not None and temp > 40:
            continue
        if peak is None or board < peak - 2:
            if peak is not None and board > 0:
                days[day]["snow"] += board
            peak = board
        elif board > peak:
            days[day]["snow"] += board - peak
            peak = board
    return days


def ratios(first, last):
    """{local hour: Kuchera ratio} from the GFS's own record of the actual temperatures."""
    q = {"latitude": SITE["lat"], "longitude": SITE["lon"], "elevation": SITE["elev_m"], "timezone": SITE["tz"],
         "models": "ncep_gfs_seamless", "start_date": first, "end_date": last, "temperature_unit": "fahrenheit",
         "hourly": "temperature_2m,temperature_700hPa,temperature_650hPa,temperature_600hPa,temperature_550hPa,temperature_500hPa"}
    j = get_json("https://historical-forecast-api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(q))
    if not j:
        return {}
    h = j["hourly"]
    keys = [k for k in h if k != "time"]
    return {t: kuchera([h[k][i] for k in keys]) for i, t in enumerate(h["time"]) if h["temperature_2m"][i] is not None}


def verify(state, truth, ratio):
    """Turn every finished, measured forecast day of every snapshot into a sample."""
    added = 0
    for snap in state["snapshots"].values():
        issue_day = snap["issue_local"][:10]
        for d in range(LEAD_DAYS):
            day = (dt.date.fromisoformat(issue_day) + dt.timedelta(days=d)).isoformat()
            if day in snap["done"] or day not in truth or day >= today_local():
                continue
            if truth[day]["readings"] < 18:  # the board was not reporting most of that day
                continue
            hours = [f"{day}T{h:02d}:00" for h in range(24) if f"{day}T{h:02d}:00" >= snap["issue_local"]]
            if any(t not in ratio for t in hours):
                continue  # the day's temperatures are not in the record yet
            x = {}
            for v in VARIANTS:
                x[v] = {}
                for b in BLENDS:
                    x[v][b] = {}
                    for mem in MEMBERS:
                        first, last = snap["cover"][mem]
                        covered = sum(1 for t in hours if first and first <= t <= last)
                        if covered < min(12, len(hours)):
                            x[v][b][mem] = None  # the model's runs do not reach most of the day
                            continue
                        s = snap["series"][mem][v][b]
                        x[v][b][mem] = round(sum(s.get(t, 0) * ratio[t] for t in hours), 3)
            y = round(truth[day]["snow"], 2)
            snap["done"].append(day)
            wet = y >= WET or any((val or 0) >= WET for v in x.values() for b in v.values() for val in b.values())
            if wet:
                state["samples"].append({"issue": snap["issue"], "date": day, "lead": d + 1, "y": y, "x": x})
                added += 1
            else:
                state["dry"] = state.get("dry", 0) + 1
    return added


# ---------- Step 3: learning ----------
def predict(x, w, a):
    avail = [m for m in MEMBERS if x.get(m) is not None]
    sw = sum(w[m] for m in avail)
    if not avail or sw <= 0:
        return None
    return a * sum(w[m] * x[m] for m in avail) / sw


def fit(samples, start=None, iters=300):
    """Model weights (summing to 1) and a scale factor (0.5-2) that best match the measured snow.
    `samples` are (x, y, recency weight). Held near an even average and a scale of 1 by PRIOR_SAMPLES."""
    names = list(MEMBERS)
    u, c = dict(start[0]) if start else {m: 0.0 for m in names}, start[1] if start else -math.log(2)
    if not samples:
        return u, c
    n_eff = sum(r for _, _, r in samples)
    scale2 = sum(r * y * y for _, y, r in samples) / n_eff + 0.25
    lam = PRIOR_SAMPLES / (n_eff + PRIOR_SAMPLES) * scale2
    mu = {m: 0.0 for m in names}; mc = 0.0; vu = {m: 0.0 for m in names}; vc = 0.0
    for it in range(1, iters + 1):
        e = {m: math.exp(u[m] - max(u.values())) for m in names}
        z = sum(e.values()); w = {m: e[m] / z for m in names}
        sg = 1 / (1 + math.exp(-c)); a = 0.5 + 1.5 * sg
        gw = {m: 0.0 for m in names}; ga = 0.0
        for x, y, r in samples:
            avail = [m for m in names if x.get(m) is not None]
            W = sum(w[m] for m in avail)
            if not avail or W <= 0:
                continue
            S = sum(w[m] * x[m] for m in avail)
            err = a * S / W - y
            for m in avail:
                gw[m] += 2 * r * err * a * (x[m] - S / W) / W / n_eff
            ga += 2 * r * err * S / W / n_eff
        M = len(names)
        for m in names:
            gw[m] += lam * 2 * M * (w[m] - 1 / M)
        ga += lam * 2 * (a - 1)
        dot = sum(w[k] * gw[k] for k in names)
        gu = {m: w[m] * (gw[m] - dot) for m in names}
        gc = ga * 1.5 * sg * (1 - sg)
        # Adam steps
        for m in names:
            mu[m] = 0.9 * mu[m] + 0.1 * gu[m]; vu[m] = 0.999 * vu[m] + 0.001 * gu[m] ** 2
            u[m] -= 0.05 * (mu[m] / (1 - 0.9 ** it)) / (math.sqrt(vu[m] / (1 - 0.999 ** it)) + 1e-8)
        mc = 0.9 * mc + 0.1 * gc; vc = 0.999 * vc + 0.001 * gc ** 2
        c -= 0.05 * (mc / (1 - 0.9 ** it)) / (math.sqrt(vc / (1 - 0.999 ** it)) + 1e-8)
    return u, c


def weights_of(params):
    u, c = params
    e = {m: math.exp(u[m] - max(u.values())) for m in u}
    z = sum(e.values())
    return {m: e[m] / z for m in u}, 0.5 + 1.5 / (1 + math.exp(-c))


def recency(day, ref):
    return 0.5 ** ((dt.date.fromisoformat(ref) - dt.date.fromisoformat(day)).days / RECENCY_DAYS)


def learn(samples):
    """For each forecast range: every approach's score on forecasts made before the outcome, the
    weights each learned version has now, and the approach recommended."""
    ref = today_local()
    even = {m: 1 / len(MEMBERS) for m in MEMBERS}
    result = []
    for name, lo, hi in BUCKETS:
        bucket = sorted((s for s in samples if lo <= s["lead"] <= hi), key=lambda s: s["date"])
        dates = sorted({s["date"] for s in bucket})
        cands = []
        # Fixed approaches: the Forecast tab's average (first: everything is compared with it), an
        # even average of all four models, and each model alone
        forecast_tab = {m: (0.0 if m == "ecmwf" else 1 / 3) for m in MEMBERS}
        fixed = [("Forecast tab's average · model's rain/snow split · newest runs", "split", "newest", forecast_tab)]
        fixed += [(f"Even average of all four · {VARIANTS[v]} · {BLENDS[b]}", v, b, even) for v in VARIANTS for b in BLENDS]
        fixed += [(f"{MEMBER_NAMES[m]} alone · {VARIANTS[v]} · newest runs", v, "newest", {k: float(k == m) for k in MEMBERS})
                  for m in MEMBERS for v in VARIANTS]
        for label, v, b, w in fixed:
            errs = [(abs(p - s["y"]), recency(s["date"], ref)) for s in bucket
                    if (p := predict(s["x"][v][b], w, 1.0)) is not None]
            cands.append({"label": label, "kind": "fixed", "variant": v, "blend": b, "weights": w, "scale": 1.0,
                          "n": len(errs), "mae": sum(e * r for e, r in errs) / sum(r for _, r in errs) if errs else None})
        # Learned approaches: refitted each day on earlier days only, then once on everything
        for v in VARIANTS:
            for b in BLENDS:
                params, errs = None, []
                for day in dates:
                    train = [(s["x"][v][b], s["y"], recency(s["date"], day)) for s in bucket if s["date"] < day]
                    params = fit(train, params, iters=120 if params else 300)
                    w, a = weights_of(params)
                    for s in bucket:
                        if s["date"] == day and (p := predict(s["x"][v][b], w, a)) is not None:
                            errs.append((abs(p - s["y"]), recency(day, ref)))
                final = fit([(s["x"][v][b], s["y"], recency(s["date"], ref)) for s in bucket], params, iters=300)
                w, a = weights_of(final)
                cands.append({"label": f"Learned weights · {VARIANTS[v]} · {BLENDS[b]}", "kind": "learned", "variant": v,
                              "blend": b, "weights": {m: round(w[m], 3) for m in w}, "scale": round(a, 3), "n": len(errs),
                              "mae": sum(e * r for e, r in errs) / sum(r for _, r in errs) if errs else None})
        for cnd in cands:
            if cnd["mae"] is not None:
                cnd["mae"] = round(cnd["mae"], 2)
        baseline = cands[0]  # the Forecast tab's average
        snow_days = len({s["date"] for s in bucket if s["y"] >= WET})
        ranked = sorted((c for c in cands if c["mae"] is not None and c["n"] >= 1), key=lambda c: c["mae"])
        enough = snow_days >= MIN_SNOW_DAYS and len(bucket) >= MIN_SAMPLES
        # Until a range has enough storms behind it, the Forecast tab's average is used and the
        # best approach so far is only reported as leading
        pick = ranked[0] if enough and ranked else baseline
        result.append({"name": name, "days": [lo, hi], "samples": len(bucket), "snow_days": snow_days,
                       "recommended": pick["label"], "leading": ranked[0]["label"] if ranked else None,
                       "enough": enough, "baseline_mae": baseline["mae"], "candidates": cands})
    return result


# ---------- Run ----------
def main():
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {"snapshots": {}, "samples": [], "dry": 0}
    truth = measured_days()
    first_truth = min(truth) if truth else today_local()

    # 1. Snapshots for every 6 AM issue time not yet taken, back to 15 days before the first measured day
    now = dt.datetime.now(dt.timezone.utc)
    issue = dt.datetime.combine(dt.date.fromisoformat(first_truth) - dt.timedelta(days=LEAD_DAYS - 1),
                                dt.time(12), tzinfo=dt.timezone.utc)
    done_issues = set(state.get("issued", []))
    made = 0
    while issue <= now - dt.timedelta(minutes=30) and made < MAX_BACKFILL:
        key = issue.strftime("%Y-%m-%dT%H:%MZ")
        if key not in done_issues:
            state["snapshots"][key] = snapshot(issue)
            done_issues.add(key)
            made += 1
            print(f"snapshot {key}")
        issue += dt.timedelta(days=1)
    state["issued"] = sorted(done_issues)

    # 2. Verify finished days
    pending = sorted({(dt.date.fromisoformat(s["issue_local"][:10]) + dt.timedelta(days=d)).isoformat()
                      for s in state["snapshots"].values() for d in range(LEAD_DAYS)})
    pending = [d for d in pending if d < today_local() and d in truth]
    ratio = ratios(pending[0], pending[-1]) if pending else {}
    added = verify(state, truth, ratio)
    # Snapshots whose 16 days are all past are no longer needed
    cutoff = (dt.date.fromisoformat(today_local()) - dt.timedelta(days=LEAD_DAYS + 2)).isoformat()
    state["snapshots"] = {k: s for k, s in state["snapshots"].items() if s["issue_local"][:10] >= cutoff}
    print(f"{added} new samples, {len(state['samples'])} in all ({state.get('dry', 0)} dry days not kept)")

    # 3. Learn, and 4. write what the page shows
    buckets = learn(state["samples"])
    old = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    history = [h for h in old.get("history", []) if h["date"] != today_local()]
    history.append({"date": today_local(), "buckets": {
        b["name"]: next({k: c[k] for k in ("label", "variant", "blend", "weights", "scale", "mae", "n")}
                        for c in b["candidates"] if c["label"] == b["recommended"]) | {"baseline_mae": b["baseline_mae"]}
        for b in buckets}})
    measured = {d: round(v["snow"], 1) for d, v in sorted(truth.items()) if v["readings"] >= 18 and d < today_local()}
    STATE.write_text(json.dumps(state, separators=(",", ":")) + "\n", encoding="utf-8")
    OUT.write_text(json.dumps({
        "updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "site": SITE,
        "members": MEMBER_NAMES,
        "variants": VARIANTS,
        "blends": BLENDS,
        "settings": {"recency_days": RECENCY_DAYS, "prior_samples": PRIOR_SAMPLES, "min_samples": MIN_SAMPLES,
                     "min_snow_days": MIN_SNOW_DAYS,
                     "wet_inches": WET, "elev_qpf_per_1000ft": ELEV_QPF, "half_life": HALF_LIFE},
        "measured_days": len(measured),
        "first_measured": min(measured) if measured else None,
        "samples": len(state["samples"]),
        "storm_days": sum(1 for v in measured.values() if v >= WET),
        "buckets": buckets,
        "history": history,
        "measured": dict(list(measured.items())[-60:]),
    }, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT.name}")


if __name__ == "__main__":
    main()
