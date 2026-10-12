// Wasatch Weather — starter app
// Data: Open-Meteo (HRRR -> GFS, 16 days) + National Weather Service.
//
// FUTURE: when the Python training pipeline exists, only getForecast() needs to change
// (e.g. fetch("forecast.json") produced by GitHub Actions). Everything else just renders.

const HOURLY_VARS = [
  "temperature_2m", "apparent_temperature",
  "precipitation", "rain", "showers", "snowfall",
  "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
  "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m",
  "freezing_level_height",
  "is_day", // 1 while the sun is up; shades day and night on the cloud chart
  // Upper-air temperatures for the Kuchera snow-to-liquid ratio
  "temperature_700hPa", "temperature_650hPa", "temperature_600hPa",
  "temperature_550hPa", "temperature_500hPa",
];
// Fallback set if the API rejects any of the above
const HOURLY_VARS_MIN = [
  "temperature_2m", "precipitation", "rain", "snowfall", "cloud_cover",
  "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m",
];
const CURRENT_VARS = [
  "temperature_2m", "wind_speed_10m", "wind_gusts_10m", "wind_direction_10m",
  "cloud_cover", "weather_code",
];

// Models drawn on the comparison charts: the fine-grid US guidance that resolves the Wasatch,
// plus ECMWF's AI model for the longer-range storm signal (it is coarse, so it runs low at Alta).
// The other coarse global models (ECMWF, ICON, UKMO, JMA, GEM, Météo-France) are left out because
// they smooth the terrain and run low at Alta. Add a line here to bring one back.
// These run out at different lead times (NAM ~2.5 days, NBM ~11 days, ECMWF AI ~15 days, GFS 16 days).
const MODELS = [
  // `dash` is the line pattern each model gets on both comparison charts (and in the keys under them in index.html)
  { id: "gfs_seamless", name: "GFS + HRRR (US)", color: "#ff8a5c", dash: [] },
  { id: "ncep_nbm_conus", name: "NBM (NWS blend)", color: "#ffd166", dash: [6, 3] },
  { id: "ncep_nam_conus", name: "NAM (US)", color: "#6cc3ff", dash: [2, 3] },
  { id: "ecmwf_aifs025_single", name: "ECMWF AI", color: "#b388ff", dash: [8, 3, 2, 3], cloudOnly: true }, // not on the snowfall chart or in its average
];

const charts = {};
let locations = [];   // locations.json; the first entry is the forecast point for the whole page
let locRows = [];     // processed GFS forecast for each location, in the same order
let allRows = [];     // processed GFS forecast for the first location, filled by main()
let currentObs = null; // current conditions from the same response
let modelData = null; // raw multi-model response per location, filled by loadModels()

// ---------- Entry point ----------
main();

async function main() {
  const status = document.getElementById("status");
  try {
    locations = await fetch("locations.json").then(r => r.json());
    // The first location drives the whole page; the others only appear on the snowfall chart
    const loc = locations[0];
    showLocation(loc);

    // Run the NWS request in parallel; it renders on its own and never blocks the page
    loadNws(loc);
    loadModels(locations); // same idea: the comparison charts fill in when the other models arrive
    loadStations().catch(err => console.warn("Weather stations unavailable", err)); // measured conditions

    const all = await getForecast(locations);
    locRows = all.map(processForecast);
    const data = all[0];
    const fc = locRows[0];
    allRows = fc;
    currentObs = data.current;
    renderNow(fc, data.current);
    renderSummary();
    renderCharts(fc);
    renderDaily(fc);
    status.hidden = true;
  } catch (err) {
    console.error(err);
    status.textContent = "Couldn't load the forecast: " + err.message;
    status.classList.add("error");
  }
}

function showLocation(loc) {
  const area = loc.area ?? loc.name;
  document.getElementById("loc-name").textContent = area;
  document.title = `${area} · Wasatch Backcountry Ski Weather Forecast`;
}

// Open-Meteo takes several points in one request as comma-separated lists
const pointParams = locs => ({
  latitude: locs.map(l => l.lat).join(","),
  longitude: locs.map(l => l.lon).join(","),
  elevation: locs.map(l => Math.round(l.elevation_ft * 0.3048)).join(","), // meters, for elevation downscaling
  timezone: locs[0].timezone,
});

// ---------- Data fetching (the only part that changes later) ----------
// Returns one forecast per location, in the same order
async function getForecast(locs) {
  const build = (hourly) => {
    const p = new URLSearchParams({
      ...pointParams(locs),
      hourly: hourly.join(","),
      current: CURRENT_VARS.join(","),
      models: "ncep_gfs_seamless",
      past_days: 5, // for the snow summary's "last 5 days"
      forecast_days: 16,
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
      precipitation_unit: "inch",
    });
    return "https://api.open-meteo.com/v1/forecast?" + p;
  };

  let res = await fetch(build(HOURLY_VARS), { cache: "no-store" });
  if (!res.ok) {
    console.warn("Full variable set rejected, retrying with minimal set");
    res = await fetch(build(HOURLY_VARS_MIN), { cache: "no-store" });
  }
  if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
  const data = await res.json();
  document.getElementById("updated").textContent =
    "Updated " + new Date().toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  return [].concat(data); // a single location comes back as one object, several as a list
}

// Snowfall and cloud cover from every model in MODELS at every location, for the comparison charts
async function loadModels(locs) {
  try {
    const p = new URLSearchParams({
      ...pointParams(locs),
      hourly: "snowfall,cloud_cover",
      models: MODELS.map(m => m.id).join(","),
      forecast_days: 16,
      precipitation_unit: "inch",
    });
    const res = await fetch("https://api.open-meteo.com/v1/forecast?" + p, { cache: "no-store" });
    if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
    modelData = [].concat(await res.json());
    if (allRows.length) {
      renderNow(allRows, currentObs); // snow tiles switch to the model average
      renderSummary();
      renderCharts(allRows.slice(0, activeHours ?? allRows.length));
    }
  } catch (err) {
    console.warn("Model comparison unavailable, showing GFS only", err);
  }
}

// ---------- Snow math ----------
const fToK = f => (f - 32) * 5 / 9 + 273.15;

// Kuchera snow-to-liquid ratio: based on the warmest temperature in the column.
function kucheraSLR(tempsF) {
  const valid = tempsF.filter(t => t != null && !Number.isNaN(t));
  if (!valid.length) return 10;
  const tmaxK = fToK(Math.max(...valid));
  const slr = tmaxK > 271.16 ? 12 + 2 * (271.16 - tmaxK) : 12 + (271.16 - tmaxK);
  return Math.min(Math.max(slr, 3), 30); // keep within a realistic range
}

function processForecast(data) {
  const h = data.hourly;
  const get = (k, i) => (h[k] ? h[k][i] : null);

  // The forecast starts at the current hour; the hours before it are the last five days
  const nowKey = (data.current?.time || h.time[0]).slice(0, 13);
  let start = h.time.findIndex(t => t.slice(0, 13) >= nowKey);
  if (start < 0) start = 0;

  const rows = [];
  for (let i = 0; i < h.time.length; i++) {
    const precip = get("precipitation", i) ?? 0;
    const rainAll = (get("rain", i) ?? 0) + (get("showers", i) ?? 0);
    const swe = Math.max(0, precip - rainAll); // liquid water falling as snow

    const columnTemps = [
      get("temperature_2m", i),
      get("temperature_700hPa", i), get("temperature_650hPa", i),
      get("temperature_600hPa", i), get("temperature_550hPa", i), get("temperature_500hPa", i),
    ];
    const slr = kucheraSLR(columnTemps);
    const snow = swe * slr;

    rows.push({
      time: h.time[i],
      temp: get("temperature_2m", i),
      feels: get("apparent_temperature", i),
      precip, rain: rainAll, swe, snow,
      kuchera: slr, // ratio for this hour whether or not it snows; used by the model comparison
      slr: swe > 0.001 ? slr : null,
      density: swe > 0.001 ? 100 / slr : null,
      cloud: get("cloud_cover", i),
      cloudLow: get("cloud_cover_low", i),
      cloudMid: get("cloud_cover_mid", i),
      cloudHigh: get("cloud_cover_high", i),
      wind: get("wind_speed_10m", i),
      gust: get("wind_gusts_10m", i),
      dir: get("wind_direction_10m", i),
      isDay: get("is_day", i),
      freezeFt: get("freezing_level_height", i) != null ? get("freezing_level_height", i) * 3.281 : null,
    });
  }
  // The page works from the current hour on. The earlier hours ride along as `.past`
  // for the snow summary; they are the model's estimate of what fell, not a measurement.
  const forecast = rows.slice(start);
  forecast.past = rows.slice(0, start);
  return forecast;
}

// ---------- Formatting helpers ----------
const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = d => (d == null ? "–" : DIRS[Math.round(d / 22.5) % 16]);
const r1 = v => (v == null ? "–" : (Math.round(v * 10) / 10).toFixed(1));
const r2 = v => (v == null ? "–" : v.toFixed(2));
const r0 = v => (v == null ? "–" : Math.round(v));
const dayName = key => new Date(key + "T12:00").toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" });

// Axis label for one time: the day at midnight, the hour otherwise. With `fullDay` the day is
// spelled out ("Wednesday") on its own line above the date, which is how it fits under a 16-day axis.
function hourLabel(t, fullDay = true) {
  const d = new Date(t);
  if (d.getHours() !== 0) return d.toLocaleTimeString([], { hour: "numeric" });
  const date = `${d.getMonth() + 1}/${d.getDate()}`;
  return fullDay ? [d.toLocaleDateString([], { weekday: "long" }), date]
                 : `${d.toLocaleDateString([], { weekday: "short" })} ${date}`;
}

const WX = {
  0: "Clear", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Rain showers", 81: "Rain showers", 82: "Heavy showers", 85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm", 97: "Thunderstorm", 99: "Thunderstorm",
};

// ---------- Current conditions ----------
let activeHours = null; // how many hours the charts show; set by clicking a snow tile

function renderNow(rows, current) {
  activeHours ??= rows.length;
  // Snow tiles show the model average once the other models have loaded (the GFS alone until then)
  const avg = averageSnow(rows);
  const sum = (n, key) => avg[key].slice(0, n).reduce((a, v) => a + (v || 0), 0);
  const water = n => `${r2(sum(n, "swe"))}" water`;
  const cur = current || {};
  const tiles = [
    { label: "Now", value: `${r0(cur.temperature_2m ?? rows[0].temp)}°F`, sub: WX[cur.weather_code] ?? "" },
    { label: "Wind", value: `${r0(cur.wind_speed_10m ?? rows[0].wind)} mph`,
      sub: `${compass(cur.wind_direction_10m ?? rows[0].dir)} · G${r0(cur.wind_gusts_10m ?? rows[0].gust)}` }, // G = gust; kept short to fit the slim tile
    { label: "Clouds", value: `${r0(cur.cloud_cover ?? rows[0].cloud)}%`,
      sub: (cur.cloud_cover ?? rows[0].cloud) < 25 ? "Sunny" : (cur.cloud_cover ?? rows[0].cloud) < 70 ? "Partly sunny" : "Cloudy" },
    { label: "Next 24 h snow", value: `${r1(sum(24, "snow"))}"`, sub: water(24), cls: "snow", hours: 24 },
    { label: "Next 72 h snow", value: `${r1(sum(72, "snow"))}"`, sub: water(72), cls: "snow", hours: 72 },
    { label: "7-day snow", value: `${r1(sum(168, "snow"))}"`, sub: water(168), cls: "snow", hours: 168 },
    { label: "16-day snow", value: `${r1(sum(rows.length, "snow"))}"`, sub: water(rows.length), cls: "snow", hours: rows.length },
  ];
  const el = document.getElementById("now");
  // Tiles with an `hours` value are buttons that set the time range of the charts
  el.innerHTML = tiles.map(t => {
    const tag = t.hours ? "button" : "div";
    const pick = t.hours ? ` pick${t.hours === activeHours ? " active" : ""}` : "";
    const attrs = t.hours ? ` type="button" data-hours="${t.hours}" aria-pressed="${t.hours === activeHours}"` : "";
    return `
    <${tag} class="tile ${t.cls || ""}${pick}"${attrs}>
      <div class="label">${t.label}</div>
      <div class="value">${t.value}</div>
      <div class="sub">${t.sub}</div>
    </${tag}>`;
  }).join("");
  el.onclick = e => {
    const tile = e.target.closest("[data-hours]");
    if (!tile) return;
    activeHours = Number(tile.dataset.hours);
    el.querySelectorAll("[data-hours]").forEach(t => {
      const on = t === tile;
      t.classList.toggle("active", on);
      t.setAttribute("aria-pressed", on);
    });
    renderCharts(rows.slice(0, activeHours));
  };
  el.hidden = false;
}

// ---------- Snow summary ----------
// Writes the day's total above each stack of bars
const barTotals = {
  id: "barTotals",
  afterDatasetsDraw(chart) {
    const g = chart.ctx;
    g.save();
    g.font = "600 11px " + Chart.defaults.font.family;
    g.textAlign = "center";
    g.textBaseline = "bottom";
    g.fillStyle = "#e6edf5";
    chart.data.labels.forEach((_, i) => {
      const total = chart.data.datasets.reduce((a, d, di) => a + (chart.isDatasetVisible(di) ? d.data[i] || 0 : 0), 0);
      if (total < 0.05) return;
      const bar = chart.getDatasetMeta(0).data[i];
      g.fillText(`${r1(total)}"`, bar.x, chart.scales.y.getPixelForValue(total) - 3);
    });
    g.restore();
  },
};

// Height in pixels of the strip above the bars that holds the period totals
const PERIOD_BAND = 46;

// Draws each storm's name and total in that strip, with a bracket spanning exactly the bars
// it adds up. `sections` are { labels, value, from, to, past } with from/to as bar positions.
function periodTotals(sections) {
  return {
    id: "periodTotals",
    afterDraw(chart) {
      const { ctx: g, chartArea: area, scales: { x } } = chart;
      const half = (x.getPixelForValue(1) - x.getPixelForValue(0)) / 2;
      const family = Chart.defaults.font.family;
      g.save();
      g.textAlign = "center";
      for (const s of sections) {
        const left = x.getPixelForValue(s.from) - half + 4, right = x.getPixelForValue(s.to) + half - 4;
        const mid = (left + right) / 2, y = area.top - 8;
        // Bracket: a line over the bars with a short tick down at each end
        g.strokeStyle = "rgba(139, 155, 176, 0.7)";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(left, y + 5); g.lineTo(left, y); g.lineTo(right, y); g.lineTo(right, y + 5);
        g.stroke();
        g.textBaseline = "bottom";
        g.font = "600 15px " + family;
        g.fillStyle = s.past ? "#8b9bb0" : "#9fd8ff";
        g.fillText(`${r1(s.value)}"`, mid, y - 3);
        // The name goes above the total: the longest version that fits within the bracket
        g.font = "10px " + family;
        const name = s.labels.map(l => l.toUpperCase()).find(l => g.measureText(l).width <= right - left);
        if (name) {
          g.fillStyle = "#8b9bb0";
          g.fillText(name, mid, y - 22);
        }
      }
      g.restore();
    },
  };
}

// Day-by-day snow at the page's forecast point: the last five days (the model's estimate of
// what fell), today and the next fourteen (the model average), with period totals above the bars.
function renderSummary() {
  const rows = allRows;
  if (!rows.length) return;
  const past = rows.past || [];
  const ahead = averageSnow(rows).snow.map(v => v || 0);
  const sum = vals => vals.reduce((a, v) => a + (v || 0), 0);

  // Bucket every hour into its calendar day
  const days = new Map();
  const bucket = t => {
    const key = t.slice(0, 10);
    if (!days.has(key)) days.set(key, { fallen: 0, day: 0, night: 0 });
    return days.get(key);
  };
  past.forEach(r => { bucket(r.time).fallen += r.snow || 0; });
  rows.forEach((r, i) => { bucket(r.time)[r.isDay ? "day" : "night"] += ahead[i]; });
  const today = rows[0].time.slice(0, 10);
  const all = [...days.keys()].sort();
  // Up to five past days, then today and the fourteen days after it
  const keys = all.slice(Math.max(0, all.indexOf(today) - 5), all.indexOf(today) + 15);
  const dateOf = key => new Date(key + "T12:00");

  // Storm totals, each drawn directly above the bars it adds up. A storm is a run of
  // back-to-back days with at least STORM_DAY_MIN inches each; one drier day ends it.
  const STORM_DAY_MIN = 0.05; // the same cut-off as the day labels, i.e. any day that shows 0.1" or more
  const totalOf = k => days.get(k).fallen + days.get(k).day + days.get(k).night;
  const md = k => `${dateOf(k).getMonth() + 1}/${dateOf(k).getDate()}`;
  const ti = keys.indexOf(today);
  const sections = [];
  let from = null;
  for (let i = 0; i <= keys.length; i++) {
    const snowy = i < keys.length && totalOf(keys[i]) >= STORM_DAY_MIN;
    if (snowy && from == null) from = i;
    if (!snowy && from != null) {
      const to = i - 1;
      const range = from === to ? md(keys[from]) : `${md(keys[from])}–${md(keys[to])}`;
      sections.push({
        from, to,
        labels: [`Storm ${range}`, range], // the longest that fits is used
        value: sum(keys.slice(from, to + 1).map(totalOf)),
        past: to < ti, // entirely before today: a model estimate of what fell
      });
      from = null;
    }
  }

  makeChart("chart-summary", {
    type: "bar",
    data: {
      labels: keys.map(k => [k === today ? "Today" : dateOf(k).toLocaleDateString([], { weekday: "short" }),
        `${dateOf(k).getMonth() + 1}/${dateOf(k).getDate()}`]),
      datasets: [
        { label: "Already fallen (model estimate)", data: keys.map(k => days.get(k).fallen), backgroundColor: "#8b9bb0" },
        { label: "Forecast, daytime", data: keys.map(k => days.get(k).day), backgroundColor: "#9fd8ff" },
        { label: "Forecast, night", data: keys.map(k => days.get(k).night), backgroundColor: "#3f8cff" },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: PERIOD_BAND } }, // room for the period totals above the bars
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12 } },
        tooltip: {
          filter: item => item.parsed.y >= 0.05,
          callbacks: {
            title: items => (items.length ? dateOf(keys[items[0].dataIndex]).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }) : ""),
            label: ctx => `${ctx.dataset.label}: ${r1(ctx.parsed.y)}"`,
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, font: { size: 11 } } },
        // `grace` leaves headroom for the totals written above the bars
        y: { stacked: true, beginAtZero: true, grace: "15%", title: { display: true, text: "inches of snow" } },
      },
    },
    plugins: [barTotals, periodTotals(sections)],
  });
}

// ---------- Charts ----------
Chart.defaults.color = "#8b9bb0";
Chart.defaults.borderColor = "rgba(139,155,176,0.15)";
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

let tickEvery = 24; // hours between x-axis labels; set in renderCharts() from the time range

function baseOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { boxWidth: 12 } },
      tooltip: { callbacks: { title: items => new Date(items[0].label).toLocaleString([], { weekday: "long", hour: "numeric" }) } },
    },
    scales: {
      x: {
        ticks: {
          autoSkip: false, maxRotation: 0,
          // Only label midnight on the 16-day axis so it stays readable; shorter ranges get more labels
          callback(val) {
            const t = this.getLabelForValue(val);
            if (Number(t.slice(11, 13)) % tickEvery !== 0) return null;
            // Full day names need about 57 px per day at this font size ("Wednesday" next to
            // "Thursday"); on a narrower chart fall back to "Wed 10/14"
            const pxPerDay = this.width / Math.max(1, this.ticks.length / 24);
            return hourLabel(t, pxPerDay >= 57);
          },
          font: { size: 11 },
        },
        grid: { color: ctx => (ctx.tick && ctx.tick.label ? "rgba(139,155,176,0.25)" : "transparent") },
      },
      ...extra,
    },
  };
}

function makeChart(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

// Small arrow image used to show wind direction
function arrowImage() {
  const c = document.createElement("canvas");
  c.width = c.height = 18;
  const g = c.getContext("2d");
  g.fillStyle = "#e6edf5";
  g.beginPath();
  g.moveTo(9, 1); g.lineTo(15, 13); g.lineTo(9, 10); g.lineTo(3, 13); g.closePath();
  g.fill();
  return c;
}

// One entry per model for the comparison charts. Until the multi-model data arrives
// (or if it fails), this is just the GFS forecast the rest of the page uses.
// `rows` is the processed GFS forecast for location number `li` in locations.json.
function modelSeries(rows, li = 0) {
  if (!modelData?.[li]) {
    return [{ ...MODELS[0], swe: rows.map(r => r.swe), snow: rows.map(r => r.snow), cloud: rows.map(r => r.cloud) }];
  }
  const h = modelData[li].hourly;
  const at = new Map(h.time.map((t, i) => [t, i]));
  const pick = (arr, r) => { const i = at.get(r.time); return arr && i != null ? arr[i] : null; };
  return MODELS.map(m => {
    const snowfall = h[`snowfall_${m.id}`], cloud = h[`cloud_cover_${m.id}`];
    // Open-Meteo reports snowfall at a fixed 7:1 ratio. Convert back to snow water (SWE), then
    // apply the same Kuchera ratio to every model so the lines differ only in precipitation.
    // The GFS line uses the page's own figures so it matches the tiles and table.
    const isMain = m.id === MODELS[0].id;
    const swe = isMain ? rows.map(r => r.swe)
      : rows.map(r => { const v = pick(snowfall, r); return v == null ? null : v / 7; });
    return {
      ...m,
      swe,
      snow: isMain ? rows.map(r => r.snow) : swe.map((w, i) => (w == null ? null : w * rows[i].kuchera)),
      cloud: rows.map(r => pick(cloud, r)),
    };
  });
}

// Running total; stops (null) where a model's forecast ends
function cumulative(vals) {
  let acc = 0;
  return vals.map(v => (v == null ? null : (acc += v)));
}

// Hour-by-hour mean of the models that have data, while at least `min` of them still do
function averageAcross(series, key, min = 2) {
  return series[0][key].map((_, i) => {
    const v = series.map(s => s[key][i]).filter(x => x != null);
    return v.length >= min ? v.reduce((a, b) => a + b, 0) / v.length : null;
  });
}

// ---------- Wind roses ----------
const SPEED_BINS = [
  { label: "Under 10 mph", max: 10, color: "#fde3c8" },
  { label: "10–20 mph", max: 20, color: "#f8a55f" },
  { label: "20–30 mph", max: 30, color: "#e8590c" },
  { label: "30+ mph", max: Infinity, color: "#a8201a" },
];

// Wind loading potential. The measure is "wind-drifted snow": the inches of snow that fall
// while the wind at this location is strong enough to move it, counted on the aspect the wind
// blows toward. These numbers are rules of thumb for this page, not an avalanche forecast.
// Share of falling snow the wind can move: none below 10 mph, rising to all of it at 30 mph.
const driftFactor = mph => Math.min(1, Math.max(0, (mph - 10) / 20));
// Levels by inches of wind-drifted snow over the period shown; deeper colour = more loading
const LOADING_LEVELS = [
  { label: "Low", min: 0, color: "#cfe8ff" },
  { label: "Moderate", min: 1, color: "#7fc0ff" },
  { label: "High", min: 3, color: "#3f8cff" },
  { label: "Very high", min: 6, color: "#1d4ed8" },
];
const loadingLevel = v => LOADING_LEVELS.filter(l => v >= l.min).pop();

const sectorOf = deg => Math.round(deg / 22.5) % 16;
const oppositeDir = d => DIRS[(DIRS.indexOf(d) + 8) % 16];

// Options shared by both roses. Polar charts list one legend entry per direction by default,
// so the legend entries are passed in; clicking them is disabled.
function roseOptions(legend, tick, tooltip) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: true },
    scales: {
      r: {
        min: 0,
        startAngle: -11.25, // centre the N sector on straight up
        ticks: { backdropColor: "transparent", maxTicksLimit: 5, callback: tick },
        pointLabels: { display: true, centerPointLabels: true, font: { size: 11 } },
      },
    },
    plugins: {
      legend: {
        onClick: () => {},
        labels: {
          boxWidth: 12,
          generateLabels: () => legend.map(l => ({ text: l.label, fillStyle: l.color, strokeStyle: l.color,
            lineWidth: 0, fontColor: Chart.defaults.color })),
        },
      },
      tooltip,
    },
  };
}

// Share of hours by the direction the wind comes from, split into speed bands
// `unit` names what is being counted: forecast hours, or readings for a weather station.
function makeWindRose(id, rows, unit = "hours") {
  const valid = rows.filter(r => r.dir != null && r.wind != null);
  const bins = SPEED_BINS.map(() => new Array(16).fill(0));
  for (const r of valid) bins[SPEED_BINS.findIndex(s => r.wind < s.max)][sectorOf(r.dir)] += 100 / valid.length;
  // Polar charts can't stack, so each speed band is drawn as a running total from the centre,
  // with the slower bands on top (lower order) to give the stacked-ring look.
  const running = new Array(16).fill(0);
  const datasets = SPEED_BINS.map((s, b) => ({
    label: s.label,
    data: bins[b].map((v, i) => (running[i] += v)),
    own: bins[b], // this band's own share, for the tooltip
    backgroundColor: s.color, borderColor: "#16212f", borderWidth: 1, order: b,
  }));
  const pct = v => `${+v.toFixed(1)}%`;
  makeChart(id, {
    type: "polarArea",
    data: { labels: DIRS, datasets },
    options: roseOptions(SPEED_BINS, pct, {
      filter: item => item.dataset.own[item.dataIndex] > 0,
      callbacks: {
        title: items => (items.length ? `Wind from ${items[0].label}` : ""),
        label: ctx => `${ctx.dataset.label}: ${pct(ctx.dataset.own[ctx.dataIndex])} of ${unit}`,
      },
    }),
  });
}

// Wind-drifted snow by the aspect being loaded (the side the wind blows toward).
// `snow` is hourly snowfall in inches, lined up with `rows`.
function makeLoadingRose(id, rows, snow) {
  const sectors = DIRS.map(() => ({ drift: 0, snow: 0, windSnow: 0 }));
  rows.forEach((r, i) => {
    const w = snow[i] ?? 0;
    if (!w || r.dir == null || r.wind == null) return;
    const s = sectors[sectorOf((r.dir + 180) % 360)];
    s.snow += w;
    s.drift += w * driftFactor(r.wind);
    s.windSnow += w * r.wind; // for the snow-weighted average wind speed
  });
  const inches = v => `${r1(v)}"`;
  makeChart(id, {
    type: "polarArea",
    data: {
      labels: DIRS,
      datasets: [{
        data: sectors.map(s => s.drift),
        backgroundColor: sectors.map(s => loadingLevel(s.drift).color),
        borderColor: "#16212f", borderWidth: 1,
      }],
    },
    options: roseOptions(LOADING_LEVELS, inches, {
      filter: item => sectors[item.dataIndex].snow > 0,
      callbacks: {
        title: items => (items.length ? `${items[0].label} aspects · wind from ${oppositeDir(items[0].label)}` : ""),
        label: ctx => {
          const s = sectors[ctx.dataIndex];
          return [
            `Loading potential: ${loadingLevel(s.drift).label}`,
            `Wind-drifted snow: ${inches(s.drift)}`,
            `Snow that fell: ${inches(s.snow)}`,
            `Average wind while snowing: ${r0(s.windSnow / s.snow)} mph`,
          ];
        },
      },
    }),
  });
}

// Hourly snow and snow water averaged over the snow models; drives the white line on the snowfall
// chart and the snow tiles. Models marked cloudOnly are left out. The average carries on with
// whichever models still have data, so past ~11 days it is the GFS alone.
function averageSnow(rows, series = modelSeries(rows)) {
  const snowModels = series.filter(s => !s.cloudOnly);
  if (snowModels.length < 2) return { series: snowModels, snow: rows.map(r => r.snow), swe: rows.map(r => r.swe) };
  return { series: snowModels, snow: averageAcross(snowModels, "snow", 1), swe: averageAcross(snowModels, "swe", 1) };
}

// Shades the plot behind the lines: pale yellow while the sun is up, slightly darker at night.
// `isDay` holds 1 or 0 for each hour on the chart (null where unknown, which is left unshaded).
function dayNightBands(isDay) {
  return {
    id: "dayNightBands",
    beforeDatasetsDraw(chart) {
      const { ctx: g, chartArea: area, scales: { x } } = chart;
      const n = isDay.length;
      if (n < 2) return;
      // Each hour owns the strip halfway to its neighbours
      const edge = i => (i <= 0 ? area.left : i >= n ? area.right : (x.getPixelForValue(i - 1) + x.getPixelForValue(i)) / 2);
      g.save();
      let start = 0;
      for (let i = 1; i <= n; i++) {
        if (i < n && isDay[i] === isDay[start]) continue;
        if (isDay[start] != null) {
          g.fillStyle = isDay[start] ? "rgba(255, 226, 120, 0.10)" : "rgba(0, 0, 0, 0.22)"; // pale yellow day, dark night
          g.fillRect(edge(start), area.top, edge(i) - edge(start), area.bottom - area.top);
        }
        start = i;
      }
      g.restore();
    },
  };
}

// Writes the location and value above each long flat stretch of every average line (a lull between storms)
const plateauLabels = {
  id: "plateauLabels",
  afterDatasetsDraw(chart) {
    const avgs = chart.data.datasets.map((d, idx) => ({ d, idx }))
      .filter(a => a.d.isAverage && chart.isDatasetVisible(a.idx));
    const g = chart.ctx;
    const area = chart.chartArea;
    const H = 14; // label height in pixels
    g.save();
    g.font = "600 12px " + Chart.defaults.font.family;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 3;
    g.strokeStyle = "#16212f"; // card background, so the text stays readable over other lines

    // 1. Collect every label with the point on its line it belongs to
    const wanted = [];
    avgs.forEach(({ d, idx }, k) => {
      const vals = d.data, swe = d.swe;
      const pts = chart.getDatasetMeta(idx).data;
      // "Long" scales with the time range: about a day on the 16-day view, 6 hours on the short ones
      const minHours = Math.max(6, Math.round(vals.length / 16));
      let start = 0;
      for (let i = 1; i <= vals.length; i++) {
        const flat = i < vals.length && vals[i] != null && vals[start] != null && Math.abs(vals[i] - vals[start]) < 0.1;
        if (flat) continue;
        // Skip the flat-at-zero stretch before any snow has fallen
        if (vals[start] != null && vals[start] >= 0.1 && i - start >= minHours) {
          // Each line's label starts at a different point along the flat stretch
          const at = Math.floor(start + (i - 1 - start) * (k + 1) / (avgs.length + 1));
          const text = `${d.label}: ${r1(vals[at])}"` + (swe?.[at] != null ? ` (${r2(swe[at])}" SWE)` : "");
          const w = g.measureText(text).width + 8;
          // Keep the whole label inside the plot
          const x = Math.min(Math.max(pts[at].x, area.left + w / 2), area.right - w / 2);
          wanted.push({ text, x, lineY: pts[at].y, w, color: d.borderColor });
        }
        start = i;
      }
    });

    // 2. Place them one at a time, highest line first. Each label tries just above its line, then
    // just below, then further out each way, and takes the first spot that touches no label
    // already placed. A label with no free spot inside the plot is left off, so none ever overlap.
    const placed = [];
    const hits = (a, b) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < H;
    wanted.sort((a, b) => a.lineY - b.lineY);
    for (const label of wanted) {
      for (let step = 0; step < 16; step++) {
        const out = 6 + H / 2 + Math.floor(step / 2) * (H + 2);
        const y = label.lineY + (step % 2 === 0 ? -out : out);
        if (y - H / 2 < area.top || y + H / 2 > area.bottom) continue;
        const spot = { ...label, y };
        if (placed.some(p => hits(p, spot))) continue;
        placed.push(spot);
        g.fillStyle = label.color;
        g.strokeText(label.text, label.x, y);
        g.fillText(label.text, label.x, y);
        break;
      }
    }
    g.restore();
  },
};

function renderCharts(rows) {
  const labels = rows.map(r => r.time);
  tickEvery = rows.length <= 24 ? 3 : rows.length <= 72 ? 6 : rows.length <= 168 ? 12 : 24;

  // Model comparison: one line per model, plus the average, so agreement and spread are visible
  const series = modelSeries(rows);
  // Model lines are drawn at ~55% opacity ("8c" alpha) so the white average stands out
  const modelLine = (s, data) => ({ label: s.name, data, borderColor: s.color + "8c", backgroundColor: s.color,
    borderWidth: 1, borderDash: s.dash, pointRadius: 0, order: 1 });
  const averageLine = data => ({ label: "Average of models", data, borderColor: "#ffffff", backgroundColor: "#ffffff",
    borderWidth: 3, pointRadius: 0, order: 0 });
  const hasData = vals => vals.some(v => v != null);
  const compareOptions = (yScale, fmt) => {
    const o = baseOptions({ y: yScale });
    o.plugins.tooltip.callbacks.label = ctx => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`;
    o.plugins.tooltip.itemSort = (a, b) => b.parsed.y - a.parsed.y;
    return o;
  };

  // Snowfall chart: every location in its own colour, lowest first. Thin lines are the individual
  // models (told apart by dash pattern), the thick line is their average.
  const snowSets = [];
  let snowAvg; // the page's own forecast point, reused by the wind loading rose
  const snowAvgBy = {}; // the same for every location, by its position in locations.json
  const byElevation = locations.map((_, i) => i).sort((a, b) => locations[a].elevation_ft - locations[b].elevation_ft);
  for (const li of byElevation) {
    const loc = locations[li];
    const lr = li === 0 ? rows : (locRows[li] || []).slice(0, rows.length);
    if (!lr.length) continue;
    const avg = averageSnow(lr, li === 0 ? series : modelSeries(lr, li));
    if (li === 0) snowAvg = avg;
    snowAvgBy[li] = avg;
    if (avg.series.length > 1) {
      avg.series.forEach(s => {
        if (hasData(s.snow)) snowSets.push({ label: `${loc.name} · ${s.name}`, data: cumulative(s.snow),
          borderColor: loc.color + "8c", backgroundColor: loc.color, borderWidth: 1,
          borderDash: s.dash, pointRadius: 0, order: 1, loc: li });
      });
    }
    // `swe` rides along on the dataset so plateauLabels and the tooltip can show the matching water total
    snowSets.push({ label: loc.name, data: cumulative(avg.snow), swe: cumulative(avg.swe),
      borderColor: loc.color, backgroundColor: loc.color, borderWidth: 3, pointRadius: 0, order: 0,
      loc: li, isAverage: true });
  }
  const snowOptions = compareOptions({ beginAtZero: true, title: { display: true, text: "total snow (in)" } }, v => `${r1(v)}"`);
  // Sixteen lines is too many to list on hover, so the tooltip shows the four averages
  snowOptions.plugins.tooltip.filter = item => item.dataset.isAverage;
  snowOptions.plugins.tooltip.callbacks.label = ctx =>
    `${ctx.dataset.label}: ${r1(ctx.parsed.y)}" (${r2(ctx.dataset.swe[ctx.dataIndex])}" SWE)`;
  // One legend entry per location; clicking it shows or hides that location's average and model lines
  snowOptions.plugins.legend = {
    onClick(e, item, legend) {
      legend.chart.data.datasets.forEach((d, di) => { if (d.loc === item.loc) legend.chart.setDatasetVisibility(di, item.hidden); });
      legend.chart.update();
    },
    labels: {
      boxWidth: 12,
      generateLabels: chart => chart.data.datasets.map((d, di) => ({ d, di })).filter(x => x.d.isAverage).map(({ d, di }) => ({
        text: `${d.label} (${locations[d.loc].elevation_ft.toLocaleString()} ft)`,
        fillStyle: d.borderColor, strokeStyle: d.borderColor, lineWidth: 0, fontColor: Chart.defaults.color,
        hidden: !chart.isDatasetVisible(di), loc: d.loc,
      })),
    },
  };
  makeChart("chart-snow-models", {
    type: "line",
    data: { labels, datasets: snowSets },
    options: snowOptions,
    plugins: [plateauLabels],
  });

  // On the cloud chart the models share one colour and are told apart by line pattern alone
  const CLOUD_LINE = "#9fb3c8";
  const cloudSets = series.filter(s => hasData(s.cloud))
    .map(s => ({ ...modelLine(s, s.cloud), borderColor: CLOUD_LINE + "8c", backgroundColor: CLOUD_LINE })); // ~55% opacity
  if (series.length > 1) {
    // The average is coloured by its own value: bright blue at 0% cloud (clear sky), fading to
    // dark grey at 100%. The axis is fixed at 0–100, so a top-to-bottom gradient does exactly that.
    const CLEAR = "#38b6ff", OVERCAST = "#66707f";
    cloudSets.push({
      ...averageLine(averageAcross(series, "cloud")),
      backgroundColor: CLEAR,
      borderColor: ctx => {
        const area = ctx.chart.chartArea;
        if (!area) return CLEAR; // first pass, before the chart has been laid out
        const g = ctx.chart.ctx.createLinearGradient(0, area.bottom, 0, area.top);
        g.addColorStop(0, CLEAR);
        g.addColorStop(1, OVERCAST);
        return g;
      },
    });
  }
  const cloudOptions = compareOptions({ min: 0, max: 100, title: { display: true, text: "%" } }, v => `${r0(v)}%`);
  cloudOptions.plugins.legend.display = false; // colour boxes can't show patterns; the key under the chart does
  makeChart("chart-cloud-models", {
    type: "line",
    data: { labels, datasets: cloudSets },
    options: cloudOptions,
    plugins: [dayNightBands(rows.map(r => r.isDay))],
  });

  makeWindRose("chart-windrose", rows);
  makeLoadingRose("chart-loading", rows, snowAvg.snow); // model-average snowfall, GFS wind
  // The same pair for the top of Mt Baldy, from that point's own wind and snowfall
  const baldy = locations.findIndex(l => l.id === "alta-mt-baldy");
  if (baldy > 0 && snowAvgBy[baldy]) {
    const baldyRows = locRows[baldy].slice(0, rows.length);
    makeWindRose("chart-windrose-baldy", baldyRows);
    makeLoadingRose("chart-loading-baldy", baldyRows, snowAvgBy[baldy].snow);
  }

  // Temperature at the page's forecast point plus the base and top of Collins. Colour shows
  // above or below freezing, so the locations are told apart by line style instead:
  // the forecast point is thick and solid, the extra ones thin with these dash patterns.
  const TEMP_EXTRA = { "alta-base": [7, 4], "alta-top-of-collins": [2, 3] };
  const WARM = "#ff7a5c", COLD = "#7aa8ff";
  const tempLine = li => ({
    label: `${locations[li].name} (${locations[li].elevation_ft.toLocaleString()} ft)`,
    data: (li === 0 ? rows : (locRows[li] || []).slice(0, rows.length)).map(r => r.temp),
    borderColor: WARM, borderWidth: li === 0 ? 2.5 : 1.5, borderDash: li === 0 ? [] : TEMP_EXTRA[locations[li].id],
    pointRadius: 0,
    segment: { borderColor: ctx => (ctx.p1.parsed.y <= 32 ? COLD : WARM) },
  });
  const tempLocs = byElevation.filter(li => li === 0 || locations[li].id in TEMP_EXTRA);
  const tempOptions = baseOptions({ y: { title: { display: true, text: "°F" } } });
  tempOptions.plugins.tooltip.callbacks.label = ctx => `${ctx.dataset.label}: ${r0(ctx.parsed.y)}°F`;
  // The built-in legend can't show dash patterns, so the key under the chart in index.html replaces it
  tempOptions.plugins.legend.display = false;
  makeChart("chart-temp", {
    type: "line",
    data: {
      labels,
      datasets: [
        ...tempLocs.map(tempLine),
        { label: "Freezing (32°F)", data: rows.map(() => 32), borderColor: "rgba(201,212,226,0.45)",
          borderWidth: 1, pointRadius: 0 },
      ],
    },
    options: tempOptions,
  });

  const arrow = arrowImage();
  const every = rows.length <= 24 ? 2 : rows.length <= 72 ? 3 : 6; // hours between direction arrows
  makeChart("chart-wind", {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Wind", data: rows.map(r => r.wind), borderColor: "#6cc3ff", backgroundColor: "rgba(108,195,255,0.15)",
          fill: true, borderWidth: 2, pointRadius: 0 },
        { label: "Gusts", data: rows.map(r => r.gust), borderColor: "#ff6b8b", borderWidth: 1.2, pointRadius: 0 },
        { label: "Direction", data: rows.map((r, i) => (i % every === 0 ? (r.gust ?? r.wind) + 4 : null)),
          showLine: false, pointStyle: arrow, pointRadius: 9,
          rotation: ctx => ((rows[ctx.dataIndex]?.dir ?? 0) + 180) % 360 },
      ],
    },
    options: (() => {
      const o = baseOptions({ y: { beginAtZero: true, title: { display: true, text: "mph" } } });
      o.plugins.tooltip.callbacks.label = ctx => {
        const r = rows[ctx.dataIndex];
        if (ctx.dataset.label === "Direction") return `From ${compass(r.dir)} (${r0(r.dir)}°)`;
        return `${ctx.dataset.label}: ${r0(ctx.parsed.y)} mph`;
      };
      o.plugins.legend.labels.filter = item => item.text !== "Direction";
      return o;
    })(),
  });

  makeChart("chart-water", {
    data: {
      labels,
      datasets: [
        { type: "bar", label: "Rain (in)", data: rows.map(r => r.rain), backgroundColor: "#3f8cff" },
        { type: "line", label: "Water (in)", data: rows.map(r => r.precip), borderColor: "#5fd3a3",
          borderWidth: 1.5, pointRadius: 0 },
      ],
    },
    options: baseOptions({ y: { beginAtZero: true, title: { display: true, text: "in per hour" } } }),
  });

  makeChart("chart-density", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Snow density (% water)", data: rows.map(r => r.density),
          backgroundColor: rows.map(r => (r.density == null ? "transparent" : r.density < 7 ? "#9fd8ff" : r.density < 11 ? "#6cc3ff" : "#3f8cff")) },
      ],
    },
    options: (() => {
      const o = baseOptions({ y: { beginAtZero: true, suggestedMax: 15, title: { display: true, text: "%" } } });
      o.plugins.tooltip.callbacks.label = ctx => {
        const r = rows[ctx.dataIndex];
        return r.density == null ? "No snow" : `${r1(r.density)}% water (${r1(r.slr)}:1 ratio)`;
      };
      return o;
    })(),
  });
}

// ---------- 16-day table ----------
let nwsSnowByDay = {}; // filled by loadNws()

function summarizeDays(rows) {
  const days = {};
  for (const r of rows) {
    const k = r.time.slice(0, 10);
    (days[k] ||= []).push(r);
  }
  return Object.entries(days).map(([key, hrs]) => {
    const vals = k => hrs.map(h => h[k]).filter(v => v != null);
    const sum = k => vals(k).reduce((a, b) => a + b, 0);
    const swe = sum("swe");
    // Dominant direction: vector average weighted by speed
    let x = 0, y = 0;
    hrs.forEach(h => { if (h.dir != null) { const rad = h.dir * Math.PI / 180; x += Math.sin(rad) * (h.wind || 1); y += Math.cos(rad) * (h.wind || 1); } });
    const dir = (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
    return {
      key,
      hi: Math.max(...vals("temp")), lo: Math.min(...vals("temp")),
      wind: Math.max(...vals("wind")), gust: Math.max(...vals("gust")), dir,
      cloud: sum("cloud") / (vals("cloud").length || 1),
      swe, snow: sum("snow"), rain: sum("rain"),
      density: sum("snow") > 0.05 ? (swe / sum("snow")) * 100 : null,
    };
  });
}

let lastDays = [];
function renderDaily(rows) {
  lastDays = summarizeDays(rows);
  drawDailyTable();
}

function drawDailyTable() {
  const tbody = document.querySelector("#daily tbody");
  tbody.innerHTML = lastDays.map(d => {
    const nws = nwsSnowByDay[d.key];
    return `<tr>
      <td>${dayName(d.key)}</td>
      <td>${r0(d.hi)}° / ${r0(d.lo)}°</td>
      <td>${r0(d.wind)} / ${r0(d.gust)}</td>
      <td><span class="arrow" style="transform:rotate(${(d.dir + 180) % 360}deg)">↑</span> ${compass(d.dir)}</td>
      <td>${r0(d.cloud)}%</td>
      <td>${d.swe > 0.005 ? r2(d.swe) + '"' : "–"}</td>
      <td class="snow">${d.snow >= 0.1 ? r1(d.snow) + '"' : "–"}</td>
      <td class="rain">${d.rain > 0.005 ? r2(d.rain) + '"' : "–"}</td>
      <td>${d.density != null ? r1(d.density) + "%" : "–"}</td>
      <td>${nws != null ? (nws >= 0.1 ? r1(nws) + '"' : "0") : ""}</td>
    </tr>`;
  }).join("");
}

// ---------- Weather stations (measured, not forecast) ----------
// Station ids on the National Weather Service data feed, lowest first. Alta's own four stations
// are listed even when they are not reporting, so they appear on their own once they do.
const STATIONS = [
  { id: "ATB", name: "Alta Base", elevation_ft: 8560 },
  { id: "AGD", name: "Alta Guard House", elevation_ft: 8799 },
  { id: "CLN", name: "Alta Collins", elevation_ft: 9662 },
  { id: "ALT", name: "Top of Collins", elevation_ft: 10443 },
  { id: "HDP", name: "Hidden Peak (Snowbird)", elevation_ft: 11000 },
  { id: "AMB", name: "Mt Baldy", elevation_ft: 11066 },
];
const cToF = c => c * 9 / 5 + 32;
const kmhToMph = k => k * 0.621371;

async function loadStations() {
  const results = await Promise.all(STATIONS.map(async s => {
    try {
      const r = await fetch(`https://api.weather.gov/stations/${s.id}/observations?limit=300`);
      if (!r.ok) return { ...s, obs: [] };
      const j = await r.json();
      return { ...s, obs: (j.features || []).map(f => f.properties) }; // newest first
    } catch {
      return { ...s, obs: [] };
    }
  }));
  renderStations(results);
  checkRidgeWind(results).catch(err => console.warn("Station wind check unavailable", err));
}

function renderStations(results) {
  const val = (o, key, convert) => (o[key]?.value == null ? null : convert(o[key].value));
  const rows = [], silent = [];
  for (const s of results) {
    const o = s.obs.find(x => x.temperature?.value != null || x.windSpeed?.value != null);
    if (!o) { silent.push(s.name); continue; }
    const when = new Date(o.timestamp);
    const old = Date.now() - when > 3 * 3600 * 1000;
    const dir = o.windDirection?.value;
    rows.push(`<tr class="pick-row" data-id="${s.id}" tabindex="0" role="button" aria-pressed="false">
      <td>${s.name}</td>
      <td>${s.elevation_ft.toLocaleString()} ft</td>
      <td${old ? ' class="muted"' : ""}>${when.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}${old ? " (old)" : ""}</td>
      <td>${r0(val(o, "temperature", cToF))}°F</td>
      <td>${r0(val(o, "windSpeed", kmhToMph))} mph</td>
      <td>${r0(val(o, "windGust", kmhToMph))} mph</td>
      <td>${dir == null ? "–" : `<span class="arrow" style="transform:rotate(${(dir + 180) % 360}deg)">↑</span> ${compass(dir)}`}</td>
    </tr>`);
  }
  const tbody = document.querySelector("#stations tbody");
  tbody.innerHTML = rows.length ? rows.join("")
    : '<tr><td colspan="7" class="muted">No station is reporting right now.</td></tr>';
  document.getElementById("stations-silent").textContent =
    silent.length ? `Not reporting right now: ${silent.join(", ")}.` : "";

  // Clicking a station (or pressing Enter or Space on it) shows its charts and readings below
  stationResults = results;
  const pick = e => { const tr = e.target.closest("tr[data-id]"); if (tr) showStation(tr.dataset.id); };
  tbody.onclick = pick;
  tbody.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e); } };
  const first = tbody.querySelector("tr[data-id]");
  if (first) showStation(activeStation ?? first.dataset.id);
}

let stationResults = []; // every station with its recent readings, newest first
let activeStation = null; // id of the station whose detail is showing

// "2026-10-11T18:10" in the viewer's local time, the label format the charts use
const localKey = d => {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Chart options for station readings, which arrive every 10–30 minutes instead of hourly:
// the time axis is labelled at the first reading of every `everyHours`-th hour.
function stationOptions(labels, yScale, everyHours = 6) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { labels: { boxWidth: 12 } },
      tooltip: { callbacks: { title: items => new Date(items[0].label).toLocaleString([], { weekday: "long", hour: "numeric", minute: "2-digit" }) } },
    },
    scales: {
      x: {
        ticks: {
          autoSkip: false, maxRotation: 0,
          callback(val, i) {
            const t = labels[i], prev = labels[i - 1];
            const newHour = !prev || prev.slice(0, 13) !== t.slice(0, 13);
            return newHour && Number(t.slice(11, 13)) % everyHours === 0 ? hourLabel(t.slice(0, 13) + ":00") : null;
          },
        },
        grid: { color: ctx => (ctx.tick && ctx.tick.label ? "rgba(139,155,176,0.25)" : "transparent") },
      },
      y: yScale,
    },
  };
}

// Wind chart, temperature chart and reading-by-reading table for one station
function showStation(id) {
  const s = stationResults.find(r => r.id === id);
  if (!s || !s.obs.length) return;
  activeStation = id;
  document.querySelectorAll("#stations tbody tr[data-id]").forEach(tr => {
    tr.classList.toggle("active", tr.dataset.id === id);
    tr.setAttribute("aria-pressed", tr.dataset.id === id);
  });
  document.getElementById("station-detail").hidden = false;
  document.querySelectorAll(".st-name").forEach(el => { el.textContent = `${s.name} · ${s.elevation_ft.toLocaleString()} ft`; });

  const obs = s.obs.slice().reverse(); // oldest first for the charts
  const labels = obs.map(o => localKey(new Date(o.timestamp)));
  const get = (o, key, convert) => (o[key]?.value == null ? null : convert(o[key].value));
  const wind = obs.map(o => get(o, "windSpeed", kmhToMph));
  const gust = obs.map(o => get(o, "windGust", kmhToMph));
  const dir = obs.map(o => get(o, "windDirection", v => v));
  const temp = obs.map(o => get(o, "temperature", cToF));

  const every = Math.max(1, Math.round(obs.length / 40)); // about 40 direction arrows across the chart
  const windOptions = stationOptions(labels, { beginAtZero: true, title: { display: true, text: "mph" } });
  windOptions.plugins.tooltip.callbacks.label = ctx => (ctx.dataset.label === "Direction"
    ? `From ${compass(dir[ctx.dataIndex])} (${r0(dir[ctx.dataIndex])}°)`
    : `${ctx.dataset.label}: ${r0(ctx.parsed.y)} mph`);
  windOptions.plugins.legend.labels.filter = item => item.text !== "Direction";
  makeChart("chart-st-wind", {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Wind", data: wind, borderColor: "#6cc3ff", backgroundColor: "rgba(108,195,255,0.15)",
          fill: true, borderWidth: 2, pointRadius: 0, spanGaps: true },
        { label: "Gusts", data: gust, borderColor: "#ff6b8b", borderWidth: 1.2, pointRadius: 0, spanGaps: true },
        // Arrows point where the wind is blowing toward, like the forecast wind chart
        { label: "Direction", data: obs.map((_, i) => (i % every === 0 && dir[i] != null ? (gust[i] ?? wind[i] ?? 0) + 4 : null)),
          showLine: false, pointStyle: arrowImage(), pointRadius: 9, rotation: ctx => ((dir[ctx.dataIndex] ?? 0) + 180) % 360 },
      ],
    },
    options: windOptions,
  });

  // Measured wind rose over the same readings
  makeWindRose("chart-st-rose", obs.map((_, i) => ({ dir: dir[i], wind: wind[i] })), "readings");

  // Half-width chart, so label the time axis every 12 hours to keep the labels apart
  const tempOptions = stationOptions(labels, { title: { display: true, text: "°F" } }, 12);
  tempOptions.plugins.tooltip.callbacks.label = ctx => `${ctx.dataset.label}: ${r0(ctx.parsed.y)}°F`;
  makeChart("chart-st-temp", {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Temperature", data: temp, borderColor: "#ff7a5c", borderWidth: 2, pointRadius: 0, spanGaps: true,
          segment: { borderColor: ctx => (ctx.p1.parsed.y <= 32 ? "#7aa8ff" : "#ff7a5c") } },
        { label: "Freezing (32°F)", data: obs.map(() => 32), borderColor: "rgba(201,212,226,0.45)", borderWidth: 1, pointRadius: 0 },
      ],
    },
    options: tempOptions,
  });

  // Reading-by-reading table, newest first, with only the columns this station reports
  const columns = [
    { head: "Temp", key: "temperature", fmt: v => `${r0(cToF(v))}°F` },
    { head: "Humidity", key: "relativeHumidity", fmt: v => `${r0(v)}%` },
    { head: "Dew point", key: "dewpoint", fmt: v => `${r0(cToF(v))}°F` },
    { head: "Wind", key: "windSpeed", fmt: v => `${r0(kmhToMph(v))} mph` },
    { head: "Gust", key: "windGust", fmt: v => `${r0(kmhToMph(v))} mph` },
    { head: "From", key: "windDirection", fmt: v => `${compass(v)} (${r0(v)}°)` },
    { head: "Wind chill", key: "windChill", fmt: v => `${r0(cToF(v))}°F` },
  ].filter(c => s.obs.some(o => o[c.key]?.value != null));
  document.querySelector("#station-log thead").innerHTML =
    `<tr><th>Measured</th>${columns.map(c => `<th>${c.head}</th>`).join("")}</tr>`;
  document.querySelector("#station-log tbody").innerHTML = s.obs.map(o => `<tr>
      <td>${new Date(o.timestamp).toLocaleString([], { weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
      ${columns.map(c => `<td>${o[c.key]?.value == null ? "–" : c.fmt(o[c.key].value)}</td>`).join("")}
    </tr>`).join("");
}

// Compares the model's recent wind for the Mt Baldy point with what a summit station measured,
// to show how far the wind behind the Baldy roses can be trusted.
async function checkRidgeWind(results) {
  const note = document.getElementById("station-check");
  const hasWind = r => r && r.obs.some(o => o.windSpeed?.value != null);
  const st = ["AMB", "HDP"].map(id => results.find(r => r.id === id)).find(hasWind);
  if (!st) return;
  const loc = locations.find(l => l.id === "alta-mt-baldy") ?? locations[0];

  // Measured wind averaged into hours, keyed by the UTC hour ("2026-10-12T00")
  const byHour = {};
  for (const o of st.obs) {
    if (o.windSpeed?.value != null) (byHour[o.timestamp.slice(0, 13)] ||= []).push(kmhToMph(o.windSpeed.value));
  }
  const p = new URLSearchParams({
    ...pointParams([loc]),
    timezone: "GMT",
    hourly: "wind_speed_10m",
    models: "ncep_gfs_seamless",
    past_days: 3,
    forecast_days: 1,
    wind_speed_unit: "mph",
  });
  const res = await fetch("https://api.open-meteo.com/v1/forecast?" + p, { cache: "no-store" });
  if (!res.ok) return;
  const h = (await res.json()).hourly;
  const pairs = [];
  h.time.forEach((t, i) => {
    const seen = byHour[t.slice(0, 13)];
    if (seen && h.wind_speed_10m[i] != null) pairs.push([seen.reduce((a, b) => a + b, 0) / seen.length, h.wind_speed_10m[i]]);
  });
  if (pairs.length < 12) return;
  const mean = k => pairs.reduce((a, pair) => a + pair[k], 0) / pairs.length;
  const miss = pairs.reduce((a, [seen, model]) => a + Math.abs(model - seen), 0) / pairs.length;
  note.textContent = `Model check: over the last ${pairs.length} hours the wind measured at ${st.name} averaged ` +
    `${r0(mean(0))} mph. The model's wind for the ${loc.name} point averaged ${r0(mean(1))} mph over the same hours, ` +
    `and was off by about ${r0(miss)} mph in a typical hour.`;
}

// ---------- Forecast / Info tabs ----------
document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
  const view = btn.dataset.view;
  for (const v of ["forecast", "stations", "info"]) document.getElementById(`view-${v}`).hidden = v !== view;
  document.querySelectorAll(".tab").forEach(b => {
    b.classList.toggle("active", b === btn);
    b.setAttribute("aria-pressed", b === btn);
  });
  // Charts can't measure themselves while hidden, so refit them when their tab comes back
  Object.values(charts).forEach(c => c.resize());
}));
// A link ending in #stations or #info opens straight on that tab
if (["#stations", "#info"].includes(location.hash)) document.querySelector(`.tab[data-view="${location.hash.slice(1)}"]`).click();

// ---------- National Weather Service ----------
async function loadNws(loc) {
  const box = document.getElementById("nws");
  try {
    const point = await fetch(`https://api.weather.gov/points/${loc.lat},${loc.lon}`).then(r => {
      if (!r.ok) throw new Error(`NWS ${r.status}`);
      return r.json();
    });
    const [fc, grid] = await Promise.all([
      fetch(point.properties.forecast).then(r => r.json()),
      fetch(point.properties.forecastGridData).then(r => r.json()).catch(() => null),
    ]);

    box.innerHTML = fc.properties.periods.map(p => `
      <div class="nws-period" title="${p.detailedForecast.replace(/"/g, "&quot;")}">
        <img src="${p.icon}" alt="">
        <div class="name">${p.name}</div>
        <div class="temp">${p.temperature}°${p.temperatureUnit}</div>
        <div>${p.shortForecast}</div>
        <div class="muted">${p.windSpeed} ${p.windDirection}</div>
      </div>`).join("");

    if (grid?.properties?.snowfallAmount) {
      nwsSnowByDay = nwsDailySnow(grid.properties.snowfallAmount, loc.timezone);
      if (lastDays.length) drawDailyTable();
    }
  } catch (err) {
    console.error(err);
    box.innerHTML = `<p class="muted">NWS forecast unavailable right now (${err.message}).</p>`;
  }
}

// NWS grid snowfall comes as time ranges in mm; total it by local day in inches.
function nwsDailySnow(snow, tz) {
  const toMm = snow.uom && snow.uom.includes("cm") ? 10 : 1;
  const dayKey = d => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const out = {};
  for (const v of snow.values) {
    const start = new Date(v.validTime.split("/")[0]);
    const k = dayKey(start);
    out[k] = (out[k] || 0) + ((v.value || 0) * toMm) / 25.4;
  }
  return out;
}
