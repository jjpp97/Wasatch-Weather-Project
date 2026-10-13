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

// The resorts along the top of the page. Each one has its own forecast points (the entries in
// locations.json whose "area" matches `name`; the first is the point the whole page is for), its
// own measured-snow file and its own weather stations. The page shows one at a time, picked by
// "?area=" in the address, and reloads to switch.
//   snow        the study plot behind the measured-snow boxes (file written by scripts/fetch_stations.py)
//   tempExtra   the extra points on the temperature chart and the dash pattern each one gets
//   ridgePoint  the forecast point compared with a ridge-top station in the "Model check" line
//   stations    lat/lon are the stations' own positions; the wind loading rose uses them
const AREAS = {
  alta: {
    name: "Alta",
    snow: { file: "data/alta-collins.json", name: "Alta Collins station", tenths: false },
    tempExtra: { "alta-base": [7, 4], "alta-top-of-collins": [2, 3] },
    ridgePoint: "alta-mt-baldy",
    ridgeStations: ["AMB", "HDP"],
    // On the National Weather Service's public feed, read live. Alta's own four stations are
    // listed even when they are not reporting, so they appear on their own once they do.
    stationFeed: "nws",
    stations: [
      { id: "ATB", name: "Alta Base", elevation_ft: 8560, lat: 40.5890, lon: -111.6370 },
      { id: "AGD", name: "Alta Guard House", elevation_ft: 8799, lat: 40.5905, lon: -111.6380 },
      { id: "CLN", name: "Alta Collins", elevation_ft: 9662, lat: 40.5763, lon: -111.6383 },
      { id: "ALT", name: "Top of Collins", elevation_ft: 10443, lat: 40.5710, lon: -111.6310 },
      { id: "HDP", name: "Hidden Peak (Snowbird)", elevation_ft: 11000, lat: 40.5611, lon: -111.6452 },
      { id: "AMB", name: "Mt Baldy", elevation_ft: 11066, lat: 40.5677, lon: -111.6374 },
    ],
  },
  solitude: {
    name: "Solitude",
    snow: { file: "data/solitude-summit.json", name: "Solitude Summit station", tenths: true },
    tempExtra: { "solitude-base": [7, 4], "solitude-honeycomb-peak": [2, 3] },
    ridgePoint: "solitude-honeycomb-peak",
    ridgeStations: ["SOLHP"],
    // Not on the public feed: an hourly job saves their readings to this file (see scripts/fetch_stations.py)
    stationFeed: "data/solitude-stations.json",
    stations: [
      { id: "SOLBS", name: "Solitude Base", elevation_ft: 8200, lat: 40.6191, lon: -111.5939 },
      { id: "SOLMB", name: "Moonbeam", elevation_ft: 8750, lat: 40.61653, lon: -111.60297 },
      { id: "SOLAP", name: "Apex", elevation_ft: 9061, lat: 40.61379, lon: -111.60175 },
      { id: "SOLSM", name: "Solitude Summit", elevation_ft: 9641, lat: 40.60081, lon: -111.60364 },
      { id: "SOL", name: "Powderhorn", elevation_ft: 9888, lat: 40.6083, lon: -111.6044 },
      { id: "SOLHP", name: "Honeycomb Peak", elevation_ft: 10488, lat: 40.60167, lon: -111.61417 },
    ],
  },
};
const AREA_KEY = (() => {
  const asked = (new URLSearchParams(location.search).get("area") || "").toLowerCase();
  return asked in AREAS ? asked : "alta";
})();
const AREA = AREAS[AREA_KEY];

const charts = {};
let locations = [];   // this area's entries in locations.json; the first is the forecast point for the whole page
let locRows = [];     // processed GFS forecast for each location, in the same order
let allRows = [];     // processed GFS forecast for the first location, filled by main()
let currentObs = null; // current conditions from the same response
let modelData = null; // raw multi-model response per location, filled by loadModels()

// ---------- Entry point ----------
main();

async function main() {
  const status = document.getElementById("status");
  try {
    locations = (await fetch("locations.json").then(r => r.json())).filter(l => l.area === AREA.name);
    // The first location drives the whole page; the others only appear on the snowfall chart
    const loc = locations[0];
    showArea();

    // Run the NWS request in parallel; it renders on its own and never blocks the page
    loadNws(loc);
    loadModels(locations); // same idea: the comparison charts fill in when the other models arrive
    loadStations().catch(err => console.warn("Weather stations unavailable", err)); // measured conditions
    loadHistory(loc).catch(err => console.warn("Snow history unavailable", err));    // past days on the snow summary
    loadMeasured().catch(err => console.warn("Measured snow unavailable", err));     // storm totals from the area's study plot

    const all = await getForecast(locations);
    locRows = all.map(processForecast);
    const data = all[0];
    const fc = locRows[0];
    allRows = fc;
    currentObs = data.current;
    renderNow(fc, data.current);
    renderSummary();
    renderWater();
    renderDailyForecast();
    renderCharts(fc);
    status.hidden = true;
  } catch (err) {
    console.error(err);
    status.textContent = "Couldn't load the forecast: " + err.message;
    status.classList.add("error");
  }
}

// The resort tabs at the top, and every piece of wording on the page that names the resort or
// one of its forecast points. In index.html, <span data-fill="main"> is filled with the text
// for "main" below, and an element with data-area="solitude" only shows on the Solitude page.
function showArea() {
  document.title = `${AREA.name} · Wasatch Backcountry Ski Weather Forecast`;
  const nav = document.getElementById("areas");
  nav.innerHTML = Object.entries(AREAS).map(([key, a]) =>
    `<a class="area${key === AREA_KEY ? " active" : ""}" href="?area=${key}"${key === AREA_KEY ? ' aria-current="page"' : ""}>${a.name}</a>`).join("");
  // Switching resort keeps you on the tab you were looking at
  nav.onclick = e => { const a = e.target.closest("a"); if (a) a.href = a.getAttribute("href").split("#")[0] + location.hash; };
  document.querySelector(".tabs[data-area-pages]").setAttribute("aria-label", `${AREA.name} pages`);

  const ft = l => `${l.elevation_ft.toLocaleString()} ft`;
  const list = items => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}` : items.join(""));
  const byHeight = [...locations].sort((a, b) => a.elevation_ft - b.elevation_ft);
  const main = locations[0];
  const extra = byHeight.filter(l => l.id in AREA.tempExtra); // the temperature chart's other points, lowest first
  const ridge = locations.find(l => l.id === AREA.ridgePoint) ?? byHeight[byHeight.length - 1];
  const swatch = l => `<i class="sw" style="background:${l.color}"></i>`;
  const fills = {
    area: AREA.name,
    main: main.name,
    mainFt: ft(main),
    low: extra[0]?.name ?? "",
    high: extra[extra.length - 1]?.name ?? "",
    ridge: ridge.name,
    points: byHeight.map(l => l.name).join(", "),
    pointsFt: list(byHeight.map(l => `${l.name} (${ft(l)})`)),
    pointSwatches: byHeight.map(swatch).join(""),
    tempPoints: list(byHeight.filter(l => l === main || l.id in AREA.tempExtra).map(l => l.name)),
    snowStation: AREA.snow.name,
    stationNames: list(AREA.stations.map(s => s.name)),
  };
  document.querySelectorAll("[data-fill]").forEach(el => { el.innerHTML = fills[el.dataset.fill] ?? ""; });
  document.querySelectorAll("[data-area]").forEach(el => { el.hidden = el.dataset.area !== AREA_KEY; });

  // Key under the temperature chart: one line style per point, lowest first
  const line = l => (l === main ? 'stroke-width="3"' : `stroke-width="1.5" stroke-dasharray="${AREA.tempExtra[l.id].join(" ")}"`);
  document.getElementById("temp-key-points").outerHTML = byHeight.filter(l => l === main || l.id in AREA.tempExtra)
    .map(l => `<span><svg viewBox="0 0 34 10" aria-hidden="true"><line x1="0" y1="5" x2="34" y2="5" ${line(l)}/></svg>${l.name} (${ft(l)})</span>`).join("");
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
      hourly: "snowfall,cloud_cover,precipitation_probability,temperature_2m,wind_speed_10m",
      models: MODELS.map(m => m.id).join(","),
      forecast_days: 16,
      precipitation_unit: "inch",
      temperature_unit: "fahrenheit",
      wind_speed_unit: "mph",
    });
    const res = await fetch("https://api.open-meteo.com/v1/forecast?" + p, { cache: "no-store" });
    if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
    modelData = [].concat(await res.json());
    if (allRows.length) {
      renderNow(allRows, currentObs); // snow tiles switch to the model average
      renderSummary();
      renderWater();
      renderDailyForecast();
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
  // The forecast starts at the current hour
  const nowKey = (data.current?.time || h.time[0]).slice(0, 13);
  let start = h.time.findIndex(t => t.slice(0, 13) >= nowKey);
  if (start < 0) start = 0;
  const rows = hourRows(h);
  const forecast = rows.slice(start);
  // The response also covers today's hours before now. They ride along as `.earlier`: the
  // model's record of the day so far, which the daily forecast shows shaded.
  const today = h.time[start].slice(0, 10);
  forecast.earlier = rows.slice(0, start).filter(r => r.time.slice(0, 10) === today);
  return forecast;
}

// One row per hour of an Open-Meteo `hourly` block, with the snow calculation applied.
// Fields the block doesn't include come out as null.
function hourRows(h) {
  const get = (k, i) => (h[k] ? h[k][i] : null);
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
      slr: swe > 0.001 ? slr : null, // snow-to-water ratio for the hours when it snows
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
  return rows;
}

// ---------- Formatting helpers ----------
const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = d => (d == null ? "–" : DIRS[Math.round(d / 22.5) % 16]);
const r1 = v => (v == null ? "–" : (Math.round(v * 10) / 10).toFixed(1));
const r2 = v => (v == null ? "–" : v.toFixed(2));
const r0 = v => (v == null ? "–" : Math.round(v));

// Axis label for one time: the day at midnight, the hour otherwise. The day goes on its own
// line above the date, spelled out ("Wednesday") when `fullDay` is true and short ("Wed") when
// there is less room.
function hourLabel(t, fullDay = true) {
  const d = new Date(t);
  if (d.getHours() !== 0) return d.toLocaleTimeString([], { hour: "numeric" });
  return [d.toLocaleDateString([], { weekday: fullDay ? "long" : "short" }), `${d.getMonth() + 1}/${d.getDate()}`];
}

// Pixels a time-axis label needs: a full day name, and the least any label can get by on
const FULL_DAY_PX = 57, MIN_LABEL_PX = 36;

// Decides the label for one point on a time axis so that labels never overlap, however narrow
// the chart. `baseStep` is the wanted gap between labels in hours and `pxPerHour` the room there
// is. On a narrow chart (a phone) the gap widens: 3 h → 6 → 12 → daily → every 2nd day and so on.
function axisLabel(t, baseStep, pxPerHour) {
  let step = baseStep;
  while (step * pxPerHour < MIN_LABEL_PX && step < 24 * 16) step = step < 24 ? step * 2 : step + 24;
  const hour = Number(t.slice(11, 13));
  if (step <= 24) {
    if (hour % step !== 0) return null;
  } else {
    // Whole days apart: count days from a fixed date so the same days are picked on every chart
    const dayNumber = Math.floor(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10)) / 86400000);
    if (hour !== 0 || dayNumber % (step / 24) !== 0) return null;
  }
  return hourLabel(t, step * pxPerHour >= FULL_DAY_PX);
}

// The weather type for one hour, worked out from the page's own numbers the same way as the
// daily forecast's symbols: `snow` and `rain` in inches for the hour, `cloud` in %, and `isDay`
// 0 at night. A single model's "weather code" is not used, because one model can show a
// one-hour gap in a storm that the average of the models smooths over.
// Returns [symbol, words]. A symbol with a sun or moon in it is only used at 50% cloud or less.
function hourWeather({ snow, rain, cloud, isDay }) {
  const night = isDay === 0;
  if (snow >= 0.5) return ["❄️", "Heavy snow"];
  if (snow >= 0.15) return ["🌨️", "Snow"];
  if (snow >= 0.03) return ["🌨️", "Light snow"];
  if (rain >= 0.1) return ["🌧️", "Heavy rain"];
  if (rain >= 0.01) return ["🌧️", "Rain"];
  if (cloud == null) return ["", ""];
  if (cloud < 25) return night ? ["🌙", "Clear"] : ["☀️", "Sunny"];
  if (cloud <= 50) return night ? ["☁️", "Partly cloudy"] : ["⛅", "Partly cloudy"];
  return ["☁️", cloud < 90 ? "Mostly cloudy" : "Overcast"];
}

// ---------- Current conditions ----------
let activeHours = null; // how many hours the charts show; set by clicking a snow tile

function renderNow(rows, current) {
  activeHours ??= rows.length;
  // Snow tiles show the model average once the other models have loaded (the GFS alone until then)
  const avg = averageSnow(rows);
  const sum = (n, key) => avg[key].slice(0, n).reduce((a, v) => a + (v || 0), 0);
  const water = n => `${r2(sum(n, "swe"))}" water`;
  const cur = current || {};
  // The weather type and cloud cover for the current hour come from the average of the models,
  // like the daily forecast (rows[0] is the current hour). Before the other models load, and if
  // they never do, the averages are just the GFS.
  const series = modelSeries(rows);
  const cloudNow = (series.length > 1 ? averageAcross(series, "cloud")[0] : null) ?? rows[0].cloud;
  const [symbol, words] = hourWeather({ snow: avg.snow[0] ?? 0, rain: rows[0].rain ?? 0, cloud: cloudNow, isDay: rows[0].isDay });
  const tiles = [
    { label: "Now", value: `${r0(cur.temperature_2m ?? rows[0].temp)}°F`, sub: words,
      icon: symbol ? `<span class="wx-icon" aria-hidden="true">${symbol}</span>` : "", cls: "now" },
    { label: "Wind", value: `${r0(cur.wind_speed_10m ?? rows[0].wind)} mph`,
      sub: `${compass(cur.wind_direction_10m ?? rows[0].dir)} · G${r0(cur.wind_gusts_10m ?? rows[0].gust)}` }, // G = gust; kept short to fit the slim tile
    { label: "Clouds", value: `${r0(cloudNow)}%`,
      sub: cloudNow == null ? "" : cloudNow < 25 ? "Clear" : cloudNow <= 50 ? "Partly cloudy" : cloudNow < 90 ? "Mostly cloudy" : "Overcast" },
    { label: "Next 24 h snow", value: `${r1(sum(24, "snow"))}"`, sub: water(24), cls: "snow", hours: 24 },
    { label: "Next 72 h snow", value: `${r1(sum(72, "snow"))}"`, sub: water(72), cls: "snow", hours: 72 },
    { label: "7-day snow", value: `${r1(sum(168, "snow"))}"`, sub: water(168), cls: "snow", hours: 168 },
    { label: "16-day snow", value: `${r1(sum(rows.length, "snow"))}"`, sub: water(rows.length), cls: "snow", hours: rows.length },
  ];
  // Tiles with an `hours` value are buttons that set the time range of the charts
  const tileHtml = t => {
    const tag = t.hours ? "button" : "div";
    const pick = t.hours ? ` pick${t.hours === activeHours ? " active" : ""}` : "";
    const attrs = t.hours ? ` type="button" data-hours="${t.hours}" aria-pressed="${t.hours === activeHours}"` : "";
    return `
    <${tag} class="tile ${t.cls || ""}${pick}"${attrs}>
      <div class="label">${t.label}</div>
      <div class="value">${t.value}</div>
      <div class="sub">${t.sub}</div>
      ${t.icon || ""}
    </${tag}>`;
  };
  // Current conditions go in the strip above the Snow Summary, the snow totals in the one below it
  const conditions = document.getElementById("conditions");
  // The measured-snow boxes go in after these three; `contents` lets them sit in the same row
  conditions.innerHTML = tiles.filter(t => !t.hours).map(tileHtml).join("") +
    '<div id="measured-tiles" style="display: contents"></div>';
  conditions.hidden = false;
  refreshMeasuredTiles();
  const el = document.getElementById("now");
  el.innerHTML = tiles.filter(t => t.hours).map(tileHtml).join("");
  el.onclick = e => {
    const tile = e.target.closest("[data-hours]");
    if (tile) setRange(Number(tile.dataset.hours));
  };
  el.hidden = false;

  // The other tabs have no tiles, so each gets the same choice as a row of buttons
  const buttons = '<span class="muted small">Show the next</span>' + [
    { label: "24 hours", hours: 24 }, { label: "72 hours", hours: 72 },
    { label: "7 days", hours: 168 }, { label: "16 days", hours: rows.length },
  ].map(b => `<button type="button" class="range-btn${b.hours === activeHours ? " active" : ""}" data-hours="${b.hours}"
      aria-pressed="${b.hours === activeHours}">${b.label}</button>`).join("");
  document.querySelectorAll(".js-range-bar").forEach(bar => {
    bar.innerHTML = buttons;
    bar.onclick = e => {
      const btn = e.target.closest("[data-hours]");
      if (btn) setRange(Number(btn.dataset.hours));
    };
  });
}

// Sets how many hours the time-range charts show, from a snow tile or a range button, and
// keeps both sets of controls in step
function setRange(hours) {
  activeHours = hours;
  document.querySelectorAll("[data-hours]").forEach(el => {
    const on = Number(el.dataset.hours) === hours;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", on);
  });
  renderCharts(allRows.slice(0, hours));
}

// ---------- Measured snow (the area's snow study plot) ----------
// The file named in AREA.snow is written by scripts/fetch_stations.py, which a scheduled GitHub
// workflow runs every hour. The page only reads the file; the Synoptic token never comes here.
let measured = null;  // { name, elevation_ft, newSnow: [{ t, inches }], latest } once loaded
let snowStorms = [];  // the Snow Summary's storms as { from, to } day keys, set when it is drawn

async function loadMeasured() {
  const res = await fetch(AREA.snow.file, { cache: "no-store" });
  if (!res.ok) throw new Error(`station data file returned ${res.status}`);
  const file = await res.json();
  const col = name => file.columns.indexOf(name);
  const readings = file.rows.map(r => ({ t: Date.parse(r[col("time")]), board: r[col("snow_interval")], temp: r[col("air_temp")] }))
    .filter(r => r.board != null && !Number.isNaN(r.t));

  // New snow from the "snow interval" board, which staff clear from time to time. Snow is counted
  // whenever the board rises above its highest reading since it was last cleared. A drop of more
  // than 2" means it was cleared; smaller dips are settling or sensor noise and are ignored.
  // Readings taken above TOO_WARM_F are skipped altogether: the board cannot be gaining snow then,
  // so a jump is a sensor glitch (one read 9" for a single hour at 55°F).
  const TOO_WARM_F = 40;
  const newSnow = [];
  let peak = null;
  for (const r of readings) {
    if (r.temp != null && r.temp > TOO_WARM_F) continue;
    if (peak == null || r.board < peak - 2) {
      if (peak != null && r.board > 0) newSnow.push({ t: r.t, inches: r.board }); // already some on the cleared board
      peak = r.board;
    } else if (r.board > peak) {
      newSnow.push({ t: r.t, inches: r.board - peak });
      peak = r.board;
    }
  }
  measured = {
    name: AREA.snow.name,
    elevation_ft: file.station.elevation_ft,
    newSnow,
    first: readings.length ? readings[0].t : null,
    latest: readings.length ? readings[readings.length - 1].t : null,
  };
  refreshMeasuredTiles();
}

// The measured-snow boxes beside Now, Wind and Clouds: the most recent storm's total (the same
// storm days as the Snow Summary) and the snow in the last 12 hours, 24 hours and 7 days.
function refreshMeasuredTiles() {
  const box = document.getElementById("measured-tiles");
  const note = document.getElementById("measured-note");
  if (!box || !note) return;
  if (!measured || measured.latest == null) { box.innerHTML = ""; note.textContent = ""; return; }

  const now = Date.now();
  const total = keep => measured.newSnow.reduce((a, s) => a + (keep(s.t) ? s.inches : 0), 0);
  const lastHours = h => total(t => t > now - h * 3600000);
  const source = `${measured.name}, ${measured.elevation_ft.toLocaleString()} ft`;
  const tiles = [];

  // The newest storm on the Snow Summary that has started: one under way, or else the last one
  const dayOf = hourKeyIn(locations[0].timezone);
  const today = dayOf(now).slice(0, 10);
  const storm = [...snowStorms].reverse().find(s => s.from <= today);
  if (storm) {
    const md = k => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
    const dates = storm.from === storm.to ? md(storm.from) : `${md(storm.from)}–${md(storm.to)}`;
    const inStorm = t => { const d = dayOf(t).slice(0, 10); return d >= storm.from && d <= storm.to; };
    const cutShort = dayOf(measured.first).slice(0, 10) > storm.from; // the record starts after the storm did
    tiles.push({ label: "Storm total", value: total(inStorm),
      sub: `${dates} · ${cutShort ? "partial record · " : ""}${measured.name}` });
  }
  tiles.push({ label: "Snow, last 12 h", value: lastHours(12), sub: measured.name });
  tiles.push({ label: "Snow, last 24 h", value: lastHours(24), sub: measured.name });
  tiles.push({ label: "Snow, last 7 days", value: lastHours(168), sub: measured.name });

  box.innerHTML = tiles.map(t => `
    <div class="tile measured" title="Measured at the ${source}">
      <div class="label">${t.label}</div>
      <div class="value">${AREA.snow.tenths ? r1(t.value) : r0(t.value)}"</div>
      <div class="sub">${t.sub}</div>
    </div>`).join("");

  const when = new Date(measured.latest).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const hoursOld = (now - measured.latest) / 3600000;
  note.textContent = `Storm total and snow in the last 12 hours, 24 hours and 7 days are measured at the ${source}` +
    `, in ${AREA.snow.tenths ? "tenths of an inch" : "whole inches"}. Latest reading: ${when}` +
    (hoursOld > 3 ? `, which is ${r0(hoursOld)} hours old, so recent snow may be missing.` : ".");
}

// ---------- Snow summary ----------
// Writes the day's total above each stack of bars. `fmt` turns the number into text and
// totals under `min` get no label.
const barTotals = (fmt = r1, min = 0.05) => ({
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
      if (total < min) return;
      const bar = chart.getDatasetMeta(0).data[i];
      g.fillText(`${fmt(total)}"`, bar.x, chart.scales.y.getPixelForValue(total) - 3);
    });
    g.restore();
  },
});

// Snow density is given as a snow-to-water ratio: inches of snow per inch of water. A higher
// ratio is lighter snow (20 to 1 is very light powder, 10 to 1 is average, 6 to 1 is heavy and wet).
// Bar colour for a ratio: light at 14 to 1 or more, average from 9 to 14, heavy below 9.
// Shared by the snow summary and the snow ratio chart.
const RATIO_LIGHT = 14, RATIO_HEAVY = 9;
const ratioColor = ratio =>
  (ratio == null ? "transparent" : ratio >= RATIO_LIGHT ? "#9fd8ff" : ratio >= RATIO_HEAVY ? "#6cc3ff" : "#3f8cff");
const ratioText = ratio => `${r1(ratio)} to 1`;

// Line colour for cloud cover on a 0–100% axis: bright blue at 0% (clear sky) fading to dark
// grey at 100%. The axis is fixed, so a top-to-bottom gradient colours the line by its own value.
const SKY_CLEAR = "#38b6ff", SKY_OVERCAST = "#66707f";
const skyLineColor = ctx => {
  const area = ctx.chart.chartArea;
  if (!area) return SKY_CLEAR; // first pass, before the chart has been laid out
  const g = ctx.chart.ctx.createLinearGradient(0, area.bottom, 0, area.top);
  g.addColorStop(0, SKY_CLEAR);
  g.addColorStop(1, SKY_OVERCAST);
  return g;
};

// Covers the night part of each bar with a pattern of small see-through crescent moons
const nightMoons = {
  id: "nightMoons",
  afterDatasetsDraw(chart) {
    const di = chart.data.datasets.findIndex(d => d.isNight);
    if (di < 0 || !chart.isDatasetVisible(di)) return;
    const g = chart.ctx;
    const R = 3.2, STEP = 11; // moon radius and spacing in pixels
    const moon = (cx, cy) => {
      g.save();
      // Clipped to the moon's disc, then filled except for a second, offset disc that bites
      // the crescent out of it
      g.beginPath();
      g.arc(cx, cy, R, 0, Math.PI * 2);
      g.clip();
      g.beginPath();
      g.rect(cx - R, cy - R, R * 2, R * 2);
      g.arc(cx + R * 0.45, cy - R * 0.2, R * 0.85, 0, Math.PI * 2, true);
      g.fill("evenodd");
      g.restore();
    };
    g.save();
    g.fillStyle = "rgba(14, 22, 33, 0.4)";
    for (const bar of chart.getDatasetMeta(di).data) {
      const top = Math.min(bar.y, bar.base), height = Math.abs(bar.base - bar.y);
      if (height < R * 2 + 1) continue; // too thin to hold even one row
      const rows = Math.max(1, Math.floor(height / STEP)), cols = Math.max(1, Math.floor(bar.width / STEP));
      // Rows and columns are centred in the bar, with every other row shifted half a step
      const rowGap = height / rows, colGap = bar.width / cols, left = bar.x - bar.width / 2;
      for (let row = 0; row < rows; row++) {
        const shift = row % 2 && cols > 1 ? colGap / 2 : 0;
        for (let col = 0; col < cols - (shift ? 1 : 0); col++) {
          moon(left + colGap * (col + 0.5) + shift, top + rowGap * (row + 0.5));
        }
      }
    }
    g.restore();
  },
};

// Height in pixels of the strip above the bars that holds the storm totals
const PERIOD_BAND = 60;

// Draws each storm's name and total in that strip, with a bracket spanning exactly the bars
// it adds up. `sections` are { labels, value, from, to, past, split } with from/to as bar
// positions; `split` is the "fallen · to come" line for a storm that is under way.
// `scroller` is the box the chart scrolls inside: a storm that is partly scrolled out of view
// keeps its text centred over the part that can be seen, so its totals are always readable.
function periodTotals(sections, fmt = r1, scroller = null) {
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
        const y = area.top - 8;
        // Centre of the visible part of the bracket (the whole bracket if nothing is cut off)
        const viewLeft = scroller ? scroller.scrollLeft : -Infinity;
        const viewRight = scroller ? Math.min(scroller.scrollLeft + scroller.clientWidth, area.right) : Infinity;
        const seenLeft = Math.max(left, viewLeft), seenRight = Math.min(right, viewRight);
        const mid = seenRight > seenLeft ? (seenLeft + seenRight) / 2 : (left + right) / 2;
        // Bracket: a line over the bars with a short tick down at each end
        g.strokeStyle = "rgba(139, 155, 176, 0.7)";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(left, y + 5); g.lineTo(left, y); g.lineTo(right, y); g.lineTo(right, y + 5);
        g.stroke();
        g.textBaseline = "bottom";
        // Bottom line, only for a storm under way: how much has fallen and how much is still to come
        let up = 0;
        if (s.split) {
          g.font = "10.5px " + family;
          g.fillStyle = "#c9d4e2";
          g.fillText(s.split, mid, y - 3);
          up = 14;
        }
        g.font = "600 15px " + family;
        g.fillStyle = s.past ? "#8b9bb0" : "#9fd8ff";
        g.fillText(`${fmt(s.value)}"`, mid, y - 3 - up);
        // The name goes above the total: the longest version that fits within the bracket
        g.font = "10px " + family;
        const name = s.labels.map(l => l.toUpperCase()).find(l => g.measureText(l).width <= right - left);
        if (name) {
          g.fillStyle = "#8b9bb0";
          g.fillText(name, mid, y - 22 - up);
        }
      }
      g.restore();
    },
  };
}

// How far back the snow summary reaches, and how many bars fit across the card at once
const HISTORY_DAYS = 120;
const SUMMARY_VISIBLE_BARS = 16; // today and the fifteen forecast days after it
const SUMMARY_MIN_BAR_PX = 44;
const SUMMARY_AXIS_PX = 50; // width given to the inches scale on the right of the chart
let snowHistory = [];       // hourly rows for the last HISTORY_DAYS days, filled by loadHistory()
const dailyScrolled = new Set(); // charts already moved to "now"; after that they stay where the viewer puts them

// What is asked of the archive of past forecasts: enough for the snow calculation, plus wind
// speed for the drifting potential, which tracks how past wind used up loose snow
const HISTORY_VARS = ["precipitation", "rain", "showers", "temperature_2m", "wind_speed_10m", "temperature_700hPa",
  "temperature_650hPa", "temperature_600hPa", "temperature_550hPa", "temperature_500hPa"];

// The model's own record of the last few months at the page's forecast point, from Open-Meteo's
// archive of past forecasts. It is what the model estimated fell, not a measurement.
async function loadHistory(loc) {
  const day = offset => { const d = new Date(Date.now() + offset * 86400000); return d.toISOString().slice(0, 10); };
  const p = new URLSearchParams({
    ...pointParams([loc]),
    hourly: HISTORY_VARS.join(","),
    models: "ncep_gfs_seamless",
    start_date: day(-HISTORY_DAYS),
    end_date: day(1), // a day past today so the viewer's timezone can't cut today short
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
  });
  const res = await fetch("https://historical-forecast-api.open-meteo.com/v1/forecast?" + p, { cache: "no-store" });
  if (!res.ok) throw new Error(`Open-Meteo archive returned ${res.status}`);
  snowHistory = hourRows((await res.json()).hourly);
  renderSummary();
  renderWater();
  if (allRows.length) renderCharts(allRows.slice(0, activeHours ?? allRows.length)); // the drifting roses use the history
}

// A scrolling day-by-day bar chart with storm totals above the bars. Shared by the snow summary
// and the rain & water chart. `o` holds:
//   id        "summary" or "water": the chart is #chart-<id> inside #<id>-scroll > #<id>-inner
//   days      Map of "YYYY-MM-DD" -> that day's numbers, in whatever shape the caller likes
//   today     the key of the current day; hasPast: whether the past days have loaded yet
//   datasets  keys => the Chart.js datasets (stacked bars, one value per key)
//   fallen, toCome   day => how much has already fallen / is still forecast, for the storm totals
//   fmt       number => text without the inch mark; min: the least a day needs to count or be labelled
//   yTitle, tooltipLabel, plugins (extra chart plugins)
function dailyChart(o) {
  const sum = vals => vals.reduce((a, v) => a + (v || 0), 0);
  const all = [...o.days.keys()].sort();
  // Every past day on record, then today and the fifteen days after it
  const keys = all.slice(Math.max(0, all.indexOf(o.today) - HISTORY_DAYS), all.indexOf(o.today) + 16);
  const dateOf = key => new Date(key + "T12:00");

  // The chart is as wide as it needs to be for `visible` bars to fill the card, and scrolls
  // sideways inside it. A desktop card shows SUMMARY_VISIBLE_BARS; a phone shows fewer, wider
  // bars (at least SUMMARY_MIN_BAR_PX each) so the day labels stay readable.
  const scroller = document.getElementById(`${o.id}-scroll`);
  // The scale on the right has a fixed width (SUMMARY_AXIS_PX) so the bars can be sized to
  // leave exactly enough room for it beside the last day.
  const room = scroller.clientWidth - SUMMARY_AXIS_PX;
  const visible = Math.min(SUMMARY_VISIBLE_BARS, Math.max(5, Math.floor(room / SUMMARY_MIN_BAR_PX)));
  document.getElementById(`${o.id}-inner`).style.width =
    keys.length <= visible ? "100%" : `${(room / visible) * keys.length + SUMMARY_AXIS_PX}px`;

  // Storm totals, each drawn directly above the bars it adds up. A storm is a run of
  // back-to-back days with at least `min` each; one drier day ends it.
  const totalOf = k => o.fallen(o.days.get(k)) + o.toCome(o.days.get(k));
  const md = k => `${dateOf(k).getMonth() + 1}/${dateOf(k).getDate()}`;
  const ti = keys.indexOf(o.today);
  const sections = [];
  let from = null;
  for (let i = 0; i <= keys.length; i++) {
    const wet = i < keys.length && totalOf(keys[i]) >= o.min;
    if (wet && from == null) from = i;
    if (!wet && from != null) {
      const to = i - 1;
      const range = from === to ? md(keys[from]) : `${md(keys[from])}–${md(keys[to])}`;
      const stormDays = keys.slice(from, to + 1).map(k => o.days.get(k));
      const fallen = sum(stormDays.map(o.fallen)), toCome = sum(stormDays.map(o.toCome));
      sections.push({
        from, to,
        labels: [`Storm ${range}`, range], // the longest that fits is used
        value: fallen + toCome,
        past: to < ti, // entirely before today: a model estimate of what fell
        // A storm that has started but not finished also shows how its total splits
        split: fallen >= o.min && toCome >= o.min ? `${o.fmt(fallen)}" fallen · ${o.fmt(toCome)}" to come` : null,
      });
      from = null;
    }
  }

  // The measured storm total beside the Now box uses the Snow Summary's storm days
  if (o.id === "summary") {
    snowStorms = sections.map(s => ({ from: keys[s.from], to: keys[s.to] }));
    refreshMeasuredTiles();
  }

  makeChart(`chart-${o.id}`, {
    type: "bar",
    data: {
      labels: keys.map(k => [k === o.today ? "Today" : dateOf(k).toLocaleDateString([], { weekday: "short" }), md(k)]),
      datasets: o.datasets(keys),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: PERIOD_BAND } }, // room for the storm totals above the bars
      plugins: {
        legend: { display: false }, // the chart scrolls sideways, so its key sits under it in index.html
        tooltip: {
          filter: item => item.parsed.y >= o.min,
          callbacks: {
            title: items => (items.length ? dateOf(keys[items[0].dataIndex]).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }) : ""),
            label: o.tooltipLabel,
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, font: { size: 11 } } },
        // `grace` leaves headroom for the totals written above the bars.
        // On the right, so the scale is in view at the end of the chart the page opens on.
        y: { stacked: true, beginAtZero: true, grace: "15%", position: "right", title: { display: true, text: o.yTitle },
          afterFit: scale => { scale.width = SUMMARY_AXIS_PX; } },
      },
    },
    plugins: [barTotals(o.fmt, o.min), ...(o.plugins || []), periodTotals(sections, o.fmt, scroller)],
  });

  // Open with today as the first day in view, like every other chart; older days are a scroll to the left
  if (!dailyScrolled.has(o.id) && o.hasPast) {
    const x = charts[`chart-${o.id}`].scales.x;
    const first = Math.max(0, ti);
    scroller.scrollLeft = x.getPixelForValue(first) - (x.getPixelForValue(1) - x.getPixelForValue(0)) / 2;
    dailyScrolled.add(o.id);
    charts[`chart-${o.id}`].draw();
    // The storm totals re-centre themselves in the part of each bracket that is in view,
    // so the chart is redrawn as it scrolls
    let queued = false;
    scroller.addEventListener("scroll", () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; charts[`chart-${o.id}`]?.draw(); });
    });
  }
}

// Day-by-day snow at the page's forecast point: the last HISTORY_DAYS days (the model's estimate
// of what fell), today and the next fifteen (the model average), with storm totals above the bars.
function renderSummary() {
  const rows = allRows;
  if (!rows.length) return;
  const past = snowHistory.filter(r => r.time < rows[0].time); // everything before the current hour
  const avg = averageSnow(rows);
  const ahead = avg.snow.map(v => v || 0), aheadSwe = avg.swe.map(v => v || 0);

  // Bucket every hour into its calendar day
  const days = new Map();
  const bucket = t => {
    const key = t.slice(0, 10);
    if (!days.has(key)) days.set(key, { fallen: 0, day: 0, night: 0, daySwe: 0, nightSwe: 0 });
    return days.get(key);
  };
  past.forEach(r => { bucket(r.time).fallen += r.snow || 0; });
  rows.forEach((r, i) => {
    const b = bucket(r.time), part = r.isDay ? "day" : "night";
    b[part] += ahead[i];
    b[part + "Swe"] += aheadSwe[i]; // snow water, so each part's snow-to-water ratio can be worked out
  });
  // Snow-to-water ratio of the forecast snow in one part of a day: total snow over total snow
  // water, which weights each hour by how much fell. Null if there is no snow.
  const ratioOf = (k, part) => {
    const d = days.get(k);
    return d[part] > 0.005 && d[part + "Swe"] > 0 ? d[part] / d[part + "Swe"] : null;
  };

  dailyChart({
    id: "summary",
    days,
    today: rows[0].time.slice(0, 10),
    hasPast: past.length > 0,
    fallen: d => d.fallen,
    toCome: d => d.day + d.night,
    fmt: r1,
    min: 0.05, // any day that shows 0.1" or more
    yTitle: "inches of snow",
    datasets: keys => [
      { label: "Already fallen (model estimate)", data: keys.map(k => days.get(k).fallen), backgroundColor: "#8b9bb0" },
      // Forecast bars are coloured by snow-to-water ratio, the same scale as the snow ratio chart.
      // The night part sits on top with a hairline under it and moons drawn over it (nightMoons).
      { label: "Forecast, daytime", data: keys.map(k => days.get(k).day), ratio: keys.map(k => ratioOf(k, "day")),
        backgroundColor: keys.map(k => ratioColor(ratioOf(k, "day"))) },
      { label: "Forecast, night", data: keys.map(k => days.get(k).night), ratio: keys.map(k => ratioOf(k, "night")),
        backgroundColor: keys.map(k => ratioColor(ratioOf(k, "night"))), isNight: true,
        borderColor: "#16212f", borderWidth: { top: 0, right: 0, bottom: 1, left: 0 }, borderSkipped: false },
    ],
    tooltipLabel: ctx => {
      const ratio = ctx.dataset.ratio?.[ctx.dataIndex];
      return `${ctx.dataset.label}: ${r1(ctx.parsed.y)}"` + (ratio != null ? ` (${ratioText(ratio)} snow to water)` : "");
    },
    plugins: [nightMoons],
  });
}

// The same chart for liquid: each day's rain and snow water (SWE), which together are all the
// precipitation that fell. Past days are the model's estimate; forecast rain is the GFS and
// forecast snow water is the model average, the figure behind the snow tiles.
const WATER_COLORS = { rainPast: "#5b7f74", swePast: "#8b9bb0", rain: "#5fd3a3", swe: "#9fd8ff" };
function renderWater() {
  const rows = allRows;
  if (!rows.length) return;
  const past = snowHistory.filter(r => r.time < rows[0].time);
  const aheadSwe = averageSnow(rows).swe.map(v => v || 0);

  const days = new Map();
  const bucket = t => {
    const key = t.slice(0, 10);
    if (!days.has(key)) days.set(key, { rainPast: 0, swePast: 0, rain: 0, swe: 0 });
    return days.get(key);
  };
  past.forEach(r => { const b = bucket(r.time); b.rainPast += r.rain || 0; b.swePast += r.swe || 0; });
  rows.forEach((r, i) => { const b = bucket(r.time); b.rain += r.rain || 0; b.swe += aheadSwe[i]; });

  const part = (key, label) => keys => ({ label, data: keys.map(k => days.get(k)[key]), backgroundColor: WATER_COLORS[key] });
  dailyChart({
    id: "water",
    days,
    today: rows[0].time.slice(0, 10),
    hasPast: past.length > 0,
    fallen: d => d.rainPast + d.swePast,
    toCome: d => d.rain + d.swe,
    fmt: r2,
    min: 0.01,
    yTitle: "inches of water",
    datasets: keys => [
      part("rainPast", "Rain, already fallen (model estimate)")(keys),
      part("swePast", "Snow water, already fallen (model estimate)")(keys),
      part("rain", "Rain, forecast")(keys),
      part("swe", "Snow water (SWE), forecast")(keys),
    ],
    tooltipLabel: ctx => `${ctx.dataset.label}: ${r2(ctx.parsed.y)}"`,
  });
}

// ---------- Daily forecast (a strip of days, and one day's hours underneath) ----------
// Colours shared with the rest of the page: temperature above and below freezing, snow water,
// rain, and the wind and gust lines.
const TEMP_WARM = "#ff7a5c", TEMP_COLD = "#7aa8ff";
const PRECIP_COLORS = { snow: "#9fd8ff", rain: "#5fd3a3", none: "#8b9bb0" };
const WIND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true"><path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/></svg>';
const WINDY_MPH = 15; // a day's strongest wind must reach this to get the wind symbol

// The measures the hour-by-hour chart can show; the first is the one it opens on
const HOURLY_PARAMS = [
  { id: "precip", label: "Precip chance" },
  { id: "cloud", label: "Cloud cover" },
  { id: "temp", label: "Temperature" },
  { id: "feels", label: "Feels like" },
  { id: "wind", label: "Wind & gusts" },
  { id: "ratio", label: "Snow density" },
];
let dailyDay = null;      // "YYYY-MM-DD" of the day whose hours are showing
let dailyParam = HOURLY_PARAMS[0].id;
let dailyHours = [];      // every forecast hour with the model averages attached

// Writes each value above its bar (first dataset only). `fmt` gets the value and its position;
// values under `min` get no label. Where the bars are too narrow for every label to fit (a
// phone), only every second or third bar is labelled.
const valueLabels = (fmt, min) => ({
  id: "valueLabels",
  afterDatasetsDraw(chart) {
    const bars = chart.getDatasetMeta(0).data;
    if (!bars.length) return;
    const g = chart.ctx;
    g.save();
    g.font = "600 10px " + Chart.defaults.font.family;
    g.textAlign = "center";
    g.textBaseline = "bottom";
    g.fillStyle = "#c9d4e2";
    const values = chart.data.datasets[0].data;
    // `fmt` may return several lines (top line first); they are stacked upward from the bar
    const linesFor = (v, i) => (v != null && v >= min ? [].concat(fmt(v, i)) : []);
    const widest = Math.max(...values.map((v, i) => Math.max(0, ...linesFor(v, i).map(t => g.measureText(t).width))));
    const spacing = bars.length > 1 ? Math.abs(bars[1].x - bars[0].x) : Infinity;
    const every = Math.max(1, Math.ceil((widest + 3) / spacing));
    bars.forEach((el, i) => {
      if (i % every !== 0) return;
      const lines = linesFor(values[i], i);
      lines.forEach((t, n) => g.fillText(t, el.x, Math.min(el.y, el.base) - 3 - (lines.length - 1 - n) * 12));
    });
    g.restore();
  },
});

// Dims the first `count` hours of a chart (the ones that have already passed) by laying a
// see-through panel over them, bars and labels included, and draws a dashed "Now" line where
// the forecast takes over. It goes last in a chart's plugin list so it covers the value labels.
// `above` is how far over the top of the plot the panel reaches: 30 px on the hourly chart,
// whose labels sit above its bars, and 0 on charts that have a legend there instead.
const pastShade = (count, above = 30) => ({
  id: "pastShade",
  afterDatasetsDraw(chart) {
    const { ctx: g, chartArea: area, scales: { x } } = chart;
    const total = chart.data.labels.length;
    const edge = count >= total ? area.right : (x.getPixelForValue(count - 1) + x.getPixelForValue(count)) / 2;
    const top = area.top - above;
    g.save();
    g.fillStyle = "rgba(22, 33, 47, 0.62)"; // the card colour, so what is underneath fades toward it
    g.fillRect(area.left, top, edge - area.left, area.bottom - top);
    g.strokeStyle = "#e6edf5";
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.beginPath();
    g.moveTo(edge, top);
    g.lineTo(edge, area.bottom);
    g.stroke();
    g.setLineDash([]);
    g.font = "600 10px " + Chart.defaults.font.family;
    g.textBaseline = "top";
    g.fillStyle = "#e6edf5";
    if (count < total) { g.textAlign = "left"; g.fillText("NOW", edge + 4, top + 2); }
    if (edge - area.left > 90) { g.textAlign = "right"; g.fillStyle = "#8b9bb0"; g.fillText("EARLIER TODAY", edge - 5, top + 1); }
    g.restore();
  },
});

// A colour part of the way from one "#rrggbb" to another (t from 0 to 1)
const mixHex = (from, to, t) => {
  const part = (hex, i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const k = Math.min(1, Math.max(0, t));
  return "#" + [0, 1, 2].map(i => Math.round(part(from, i) + (part(to, i) - part(from, i)) * k).toString(16).padStart(2, "0")).join("");
};

function renderDailyForecast() {
  const rows = allRows;
  if (!rows.length) return;
  // Today's hours that have already gone, then the forecast, so today shows all 24 hours
  const earlier = rows.earlier || [];
  const full = [...earlier, ...rows];
  // The same model averages as the snow tiles and the cloud chart; the GFS alone until they load
  const series = modelSeries(full);
  const avg = averageSnow(full, series);
  const many = series.length > 1;
  const cloudAvg = many ? averageAcross(series, "cloud") : [];
  const popAvg = many ? averageAcross(series, "pop", 1) : [];
  dailyHours = full.map((r, i) => ({
    ...r,
    past: i < earlier.length, // already happened: the model's record, not a forecast
    snowAvg: avg.snow[i] ?? 0,
    sweAvg: avg.swe[i] ?? 0,
    cloudAvg: cloudAvg[i] ?? r.cloud,
    pop: popAvg[i] ?? null,
  }));

  const days = new Map();
  for (const h of dailyHours) {
    const key = h.time.slice(0, 10);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(h);
  }
  if (!days.has(dailyDay)) dailyDay = days.keys().next().value;
  const total = (hrs, pick) => hrs.reduce((a, h) => a + (pick(h) || 0), 0);

  document.getElementById("daily-days").innerHTML = [...days].map(([key, hrs]) => {
    const date = new Date(key + "T12:00");
    const temps = hrs.map(h => h.temp).filter(v => v != null);
    const hi = Math.max(...temps), lo = Math.min(...temps);
    const snow = total(hrs, h => h.snowAvg), rain = total(hrs, h => h.rain);
    // Sky from the daylight hours, since that is when it matters for skiing
    const light = hrs.filter(h => h.isDay !== 0);
    const sky = light.length ? light : hrs;
    const cloud = total(sky, h => h.cloudAvg) / sky.length;
    const [symbol, words] =
      snow >= 6 ? ["❄️", "Heavy snow"] :
      snow >= 0.3 ? ["🌨️", "Snow"] :
      rain >= 0.1 ? ["🌧️", "Rain"] :
      cloud < 25 ? ["☀️", "Sunny"] :
      cloud < 60 ? ["⛅", "Partly cloudy"] : ["☁️", "Cloudy"];
    // Wind symbol on windy days, in the wind rose's colour for the day's strongest wind
    const peak = Math.max(...hrs.map(h => h.wind ?? 0)), gust = Math.max(...hrs.map(h => h.gust ?? 0));
    const windColor = SPEED_BINS[peak >= 30 ? 3 : peak >= 20 ? 2 : 1].color;
    const wind = peak >= WINDY_MPH
      ? `<span class="wind" style="color:${windColor}" title="Windy: up to ${r0(peak)} mph, gusts ${r0(gust)}">${WIND_ICON}</span>`
      : '<span class="wind"></span>';
    const tip = `${date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}: ${words}` +
      (snow >= 0.05 ? `, ${r1(snow)}" of snow` : "") + `, wind up to ${r0(peak)} mph`;
    return `
    <button type="button" class="day${key === dailyDay ? " active" : ""}" data-day="${key}" aria-pressed="${key === dailyDay}" title="${tip}">
      <span class="dow">${date.toLocaleDateString([], { weekday: "short" })}</span>
      <span class="dom">${date.getDate()}</span>
      <span class="wx" aria-label="${words}">${symbol}</span>
      <span class="hi ${hi > 32 ? "warm" : "cold"}">${r0(hi)}°</span>
      <span class="lo ${lo > 32 ? "warm" : "cold"}">${r0(lo)}°</span>
      ${wind}
    </button>`;
  }).join("");

  document.getElementById("daily-tabs").innerHTML = HOURLY_PARAMS.map(p =>
    `<button type="button" class="range-btn${p.id === dailyParam ? " active" : ""}" data-param="${p.id}"
      aria-pressed="${p.id === dailyParam}">${p.label}</button>`).join("");

  // One click handler per strip: pick the day or the measure, mark it, redraw the hours
  const choose = (boxId, attr, set) => {
    const box = document.getElementById(boxId);
    box.onclick = e => {
      const btn = e.target.closest(`[data-${attr}]`);
      if (!btn) return;
      set(btn.dataset[attr]);
      box.querySelectorAll(`[data-${attr}]`).forEach(b => {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-pressed", b === btn);
      });
      drawHourly();
    };
  };
  choose("daily-days", "day", v => { dailyDay = v; });
  choose("daily-tabs", "param", v => { dailyParam = v; });
  drawHourly();
}

// The chosen day's hours for the chosen measure, with a key underneath that explains the colours
function drawHourly() {
  const hrs = dailyHours.filter(h => h.time.slice(0, 10) === dailyDay);
  if (!hrs.length) return;
  const labels = hrs.map(h => h.time);
  const options = (y, unit) => {
    const o = baseOptions({ y }, 3); // an axis label every 3 hours, fewer on a narrow screen
    o.plugins.legend.display = false;
    o.plugins.tooltip.callbacks.label = ctx => `${ctx.dataset.label}: ${r0(ctx.parsed.y)}${unit}`;
    return o;
  };
  const box = color => `<i class="box" style="background:${color}"></i>`;
  let config, key;

  if (dailyParam === "precip") {
    // Bar height is the chance of any precipitation; the colour says what it would fall as
    const kind = h => (h.sweAvg > 0.001 && h.sweAvg >= (h.rain || 0) ? "snow" : (h.rain || 0) > 0.001 ? "rain" : "none");
    const o = options({ min: 0, max: 100, title: { display: true, text: "chance of precipitation (%)" } }, "%");
    o.layout = { padding: { top: 14 } }; // room for the label above a 100% bar
    o.plugins.tooltip.callbacks.label = ctx => {
      const h = hrs[ctx.dataIndex];
      const lines = [`Chance of precipitation: ${r0(ctx.parsed.y)}%`];
      if (h.snowAvg >= 0.05) lines.push(`Snow: ${r1(h.snowAvg)}" (${r2(h.sweAvg)}" water)`);
      if ((h.rain || 0) >= 0.005) lines.push(`Rain: ${r2(h.rain)}"`);
      return lines;
    };
    config = {
      type: "bar",
      data: { labels, datasets: [{ label: "Chance of precipitation", data: hrs.map(h => h.pop),
        backgroundColor: hrs.map(h => PRECIP_COLORS[kind(h)]) }] },
      options: o,
      plugins: [valueLabels(v => `${r0(v)}%`, 10)],
    };
    key = `<span>${box(PRECIP_COLORS.snow)}Would fall as snow</span><span>${box(PRECIP_COLORS.rain)}Would fall as rain</span>` +
      `<span>${box(PRECIP_COLORS.none)}Chance only, no amount forecast</span>`;
  } else if (dailyParam === "ratio") {
    // Snow density as a snow-to-water ratio, for the hours when the model average has snow:
    // inches of snow per inch of water, so a taller bar is lighter snow. Same colours as the
    // Snow Summary and the Snow-to-Water Ratio chart.
    const ratios = hrs.map(h => (h.sweAvg > 0.001 && h.snowAvg > 0 ? h.snowAvg / h.sweAvg : null));
    const o = options({ beginAtZero: true, suggestedMax: 20, title: { display: true, text: "inches of snow per inch of water" } }, "");
    o.layout = { padding: { top: 14 } };
    o.plugins.tooltip.callbacks.label = ctx => {
      const h = hrs[ctx.dataIndex];
      return [`Snow to water: ${ratioText(ctx.parsed.y)}`, `${r2(h.snowAvg)}" of snow from ${r2(h.sweAvg)}" of water`];
    };
    config = {
      type: "bar",
      data: { labels, datasets: [{ label: "Snow-to-water ratio", data: ratios, backgroundColor: ratios.map(ratioColor) }] },
      options: o,
      plugins: [valueLabels(v => r1(v), 0)],
    };
    key = `<span>${box(ratioColor(RATIO_LIGHT))}Light, ${RATIO_LIGHT} to 1 or more</span>` +
      `<span>${box(ratioColor(RATIO_HEAVY))}Average, ${RATIO_HEAVY} to ${RATIO_LIGHT} to 1</span>` +
      `<span>${box(ratioColor(0))}Heavy, under ${RATIO_HEAVY} to 1</span>` +
      (ratios.some(v => v != null) ? "" : "<span>No snow forecast for this day</span>");
  } else if (dailyParam === "cloud") {
    // Each bar takes the colour the cloud line has at that height: blue when clear, grey when cloudy
    const o = options({ min: 0, max: 100, title: { display: true, text: "cloud cover (%)" } }, "%");
    o.layout = { padding: { top: 14 } };
    config = {
      type: "bar",
      data: { labels, datasets: [{ label: "Cloud cover", data: hrs.map(h => h.cloudAvg),
        backgroundColor: hrs.map(h => mixHex(SKY_CLEAR, SKY_OVERCAST, (h.cloudAvg ?? 0) / 100)) }] },
      options: o,
      plugins: [dayNightBands(hrs.map(h => h.isDay)), valueLabels(v => `${r0(v)}%`, 1)],
    };
    key = `<span><i class="box" style="width:34px;background:linear-gradient(90deg, ${SKY_CLEAR}, ${SKY_OVERCAST})"></i>` +
      "Model average: blue when clear, grey when cloudy</span>" +
      `<span>${box("rgba(255, 226, 120, 0.35)")}Day</span><span>${box("#0b1119")}Night</span>`;
  } else if (dailyParam === "temp" || dailyParam === "feels") {
    // Bars rise from the bottom of the chart (not from zero), red above freezing and blue at or below
    const name = dailyParam === "temp" ? "Temperature" : "Feels like";
    const vals = hrs.map(h => h[dailyParam]);
    const seen = vals.filter(v => v != null);
    const floor = Math.floor((Math.min(...seen, 32) - 6) / 5) * 5;
    const o = options({ min: floor, suggestedMax: Math.max(...seen, 32) + 4, title: { display: true, text: "°F" } }, "°F");
    o.layout = { padding: { top: 14 } };
    o.plugins.tooltip.filter = item => item.dataset.label !== "Freezing";
    config = {
      type: "bar",
      data: { labels, datasets: [
        { label: name, data: vals, base: floor, backgroundColor: vals.map(v => (v != null && v <= 32 ? TEMP_COLD : TEMP_WARM)) },
        { type: "line", label: "Freezing", data: hrs.map(() => 32), borderColor: "rgba(201,212,226,0.6)", borderWidth: 1,
          borderDash: [4, 3], pointRadius: 0 },
      ] },
      options: o,
      plugins: [valueLabels(v => `${r0(v)}°`, -Infinity)],
    };
    key = `<span>${box(TEMP_WARM)}Above freezing</span><span>${box(TEMP_COLD)}At or below freezing</span>` +
      '<span><svg viewBox="0 0 34 10" aria-hidden="true"><line x1="0" y1="5" x2="34" y2="5" stroke-width="1" stroke-dasharray="4 3"/></svg>32°F</span>';
  } else {
    // One bar per hour: the wind speed in the wind rose colours, with the gust rising above it in
    // faint pink at the same width (the pink part is the gust minus the wind, stacked on top)
    const binColor = mph => SPEED_BINS[SPEED_BINS.findIndex(s => (mph ?? 0) < s.max)].color;
    const o = options({ stacked: true, beginAtZero: true, grace: "22%", title: { display: true, text: "mph" } }, " mph");
    o.scales.x.stacked = true;
    o.layout = { padding: { top: 6 } };
    o.plugins.tooltip.callbacks.label = ctx =>
      `${ctx.dataset.label}: ${r0(ctx.dataset.label === "Gusts" ? hrs[ctx.dataIndex].gust : ctx.parsed.y)} mph`;
    o.plugins.tooltip.callbacks.afterBody = items =>
      (items.length && hrs[items[0].dataIndex].dir != null
        ? `From ${compass(hrs[items[0].dataIndex].dir)} (${r0(hrs[items[0].dataIndex].dir)}°)` : "");
    // An arrow for where the wind is blowing toward (as elsewhere on the page) and the compass
    // point it comes from, e.g. "↗ SW"
    const TOWARD = ["↓", "↙", "←", "↖", "↑", "↗", "→", "↘"]; // indexed by where it comes from: N, NE, E, …
    const direction = deg => (deg == null ? "" : `${TOWARD[Math.round(deg / 45) % 8]} ${compass(deg)}`);
    config = {
      type: "bar",
      data: { labels, datasets: [
        // Listed first so the labels sit on top of it; `order` stacks it above the wind
        { label: "Gusts", data: hrs.map(h => Math.max(0, (h.gust ?? 0) - (h.wind ?? 0))), backgroundColor: "rgba(255, 107, 139, 0.35)",
          borderColor: "#ff6b8b", borderWidth: { top: 2, right: 0, bottom: 0, left: 0 }, order: 2 },
        { label: "Wind", data: hrs.map(h => h.wind), backgroundColor: hrs.map(h => binColor(h.wind)), order: 1 },
      ] },
      options: o,
      // Above each bar: the direction, then the wind with the gust in brackets, e.g. "17 (31)"
      plugins: [valueLabels((v, i) => [direction(hrs[i].dir), `${r0(hrs[i].wind)} (${r0(hrs[i].gust)})`].filter(Boolean), -Infinity)],
    };
    key = SPEED_BINS.map(s => `<span>${box(s.color)}Wind ${s.label.toLowerCase()}</span>`).join("") +
      `<span>${box("rgba(255, 107, 139, 0.45)")}Gust (the number in brackets)</span>` +
      "<span>Direction: where the wind comes from; the arrow shows where it is blowing toward</span>";
  }
  // Today: dim the hours that have already passed and mark where "now" is
  const gone = hrs.filter(h => h.past).length;
  if (gone) {
    config.plugins = [...(config.plugins || []), pastShade(gone)];
    config.options.layout = { padding: { top: 32 } }; // room for the "Now" caption above the labels
    config.options.plugins.tooltip.callbacks.footer = items =>
      (items.length && hrs[items[0].dataIndex].past ? "Already passed (the model's record)" : "");
    key += `<span>${box("rgba(139, 155, 176, 0.35)")}Dimmed: hours already passed (the model's record)</span>`;
  }
  makeChart("chart-hourly", config);
  document.getElementById("hourly-key").innerHTML = key;
}

// ---------- Charts ----------
Chart.defaults.color = "#8b9bb0";
Chart.defaults.borderColor = "rgba(139,155,176,0.15)";
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

// On a touch screen there is no "mouse out", so a tapped point's info box would stay up for good.
// This clears it a few seconds after the last touch, on every chart. Devices with a mouse are
// left alone: there the box follows the pointer and goes when it leaves.
const TOUCH_TIP_MS = 4000;
if (window.matchMedia("(hover: none)").matches) {
  Chart.register({
    id: "touchTipTimeout",
    afterEvent(chart) {
      clearTimeout(chart.$tipTimer);
      chart.$tipTimer = setTimeout(() => {
        if (!chart.ctx) return; // the chart was redrawn in the meantime
        chart.setActiveElements([]);
        chart.tooltip?.setActiveElements([], { x: 0, y: 0 });
        chart.update("none");
      }, TOUCH_TIP_MS);
    },
    beforeDestroy(chart) { clearTimeout(chart.$tipTimer); },
  });
}

let tickEvery = 24; // hours between x-axis labels; set in renderCharts() from the time range

// `step` is the wanted gap between axis labels in hours; left out, it follows the time range
// the tiles have set (tickEvery).
function baseOptions(extra = {}, step = null) {
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
            // One point per hour, so the room per hour is the axis width over the number of points
            return axisLabel(this.getLabelForValue(val), step ?? tickEvery, this.width / Math.max(1, this.ticks.length));
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
    return [{ ...MODELS[0], swe: rows.map(r => r.swe), snow: rows.map(r => r.snow), cloud: rows.map(r => r.cloud),
      pop: rows.map(() => null), temp: rows.map(r => r.temp), wind: rows.map(r => r.wind) }];
  }
  const h = modelData[li].hourly;
  const at = new Map(h.time.map((t, i) => [t, i]));
  const pick = (arr, r) => { const i = at.get(r.time); return arr && i != null ? arr[i] : null; };
  return MODELS.map(m => {
    const snowfall = h[`snowfall_${m.id}`], cloud = h[`cloud_cover_${m.id}`];
    // Open-Meteo reports snowfall at a fixed 7:1 ratio. Convert back to snow water (SWE), then
    // apply the same Kuchera ratio to every model so the lines differ only in precipitation.
    // The GFS line uses the page's own figures so it matches the tiles.
    const isMain = m.id === MODELS[0].id;
    const swe = isMain ? rows.map(r => r.swe)
      : rows.map(r => { const v = pick(snowfall, r); return v == null ? null : v / 7; });
    return {
      ...m,
      swe,
      snow: isMain ? rows.map(r => r.snow) : swe.map((w, i) => (w == null ? null : w * rows[i].kuchera)),
      cloud: rows.map(r => pick(cloud, r)),
      pop: rows.map(r => pick(h[`precipitation_probability_${m.id}`], r)), // chance of precipitation, %
      // Temperature and wind for the Model Results charts; the GFS line uses the page's own values
      temp: isMain ? rows.map(r => r.temp) : rows.map(r => pick(h[`temperature_2m_${m.id}`], r)),
      wind: isMain ? rows.map(r => r.wind) : rows.map(r => pick(h[`wind_speed_10m_${m.id}`], r)),
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

// Wind drifting potential: an index of how readily the wind can move snow, hour by hour, counted
// on the aspect the wind blows toward. It is the product of two things, each from 0 to 1:
//
//   wind strength   Nothing below a threshold speed, then rising with the 4th power of wind speed
//                   to 1 at DRIFT.full. Blowing-snow transport measured on open ground grows as
//                   about u^4 (Tabler et al. 1990; Pomeroy & Gray), and lee-slope deposition
//                   behind a ridge as about u^3 (Föhn 1980). The threshold depends on the snow:
//                   about 10 mph while it is snowing (falling and fresh snow moves easily; CAIC,
//                   Liston et al. 2007), 17 mph for settled dry snow and 22 mph for wet snow
//                   (Li & Pomeroy 1997, 7.7 and 9.9 m/s at 10 m).
//   snow supply     How much loose snow is lying about to be moved. Every hour's snowfall joins a
//                   pool of loose snow. The pool shrinks as the snow ages and bonds (the drifting
//                   threshold rises with time since snowfall: Schmidt 1980; Li & Pomeroy 1997),
//                   shrinks fast once it is above freezing, and is used up by wind that is
//                   already moving it. Supply is pool / (pool + DRIFT.supplyHalf).
//
// The thresholds and the powers come from the studies named. The rates at which the pool shrinks
// are this page's own choices: the studies establish the effect but give no agreed rate.
// It is a guide to which aspects and which days, not an avalanche forecast.
const DRIFT = {
  fresh: 10, settled: 17, wet: 22, // threshold wind speeds, mph
  full: 30,                        // wind speed at which the wind factor reaches 1, mph
  power: 4,
  halfLifeCold: 36,                // hours for loose snow to halve by ageing at or below freezing
  halfLifeWet: 3,                  // the same above freezing
  strip: 0.25,                     // share of the loose snow a full-strength wind uses up each hour
  supplyHalf: 2,                   // inches of loose snow that give a supply of one half
};

// Runs the loose-snow pool through `before` (earlier hours, to set it up) and then `rows`, and
// returns the drifting potential for each hour of `rows`. `snow` is the hourly snowfall for `rows`.
function driftPotential(before, rows, snow) {
  let loose = 0;
  const step = (r, fell) => {
    loose += fell || 0;
    const wet = r.temp != null && r.temp > 32;
    const threshold = wet ? DRIFT.wet : (fell || 0) >= 0.05 ? DRIFT.fresh : DRIFT.settled;
    const u = r.wind ?? 0;
    const wind = u <= threshold ? 0
      : Math.min(1, (u ** DRIFT.power - threshold ** DRIFT.power) / (DRIFT.full ** DRIFT.power - threshold ** DRIFT.power));
    const supply = loose / (loose + DRIFT.supplyHalf);
    const out = { potential: wind * supply, loose };
    loose *= 0.5 ** (1 / (wet ? DRIFT.halfLifeWet : DRIFT.halfLifeCold)); // ageing
    loose *= 1 - DRIFT.strip * wind;                                        // moved by the wind
    return out;
  };
  before.forEach(r => step(r, r.snow));
  return rows.map((r, i) => step(r, snow[i]));
}

// Levels by the potential added up over the period shown, which reads as "hours of full-strength
// drifting"; deeper colour = more drifting. Because of the fourth power, moderate winds score
// far below 1 an hour, so the steps are small: with plenty of loose snow, about 12 hours of
// 20 mph wind lands in Moderate, 12 hours of 25 mph in High and 10 hours of 30 mph in Very high.
const LOADING_LEVELS = [
  { label: "Low", min: 0, color: "#cfe8ff" },
  { label: "Moderate", min: 0.5, color: "#7fc0ff" },
  { label: "High", min: 2, color: "#3f8cff" },
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
        display: legend.length > 0, // an empty list means no colour key
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

// Wind drifting potential by the aspect being loaded (the side the wind blows toward).
// `drift` is driftPotential()'s result for `rows`, hour for hour.
function makeLoadingRose(id, rows, drift) {
  const sectors = DIRS.map(() => ({ score: 0, hours: 0, wind: 0, loose: 0 }));
  rows.forEach((r, i) => {
    const p = drift[i]?.potential ?? 0;
    if (p <= 0 || r.dir == null) return;
    const s = sectors[sectorOf((r.dir + 180) % 360)];
    s.score += p;
    if (p >= 0.05) s.hours += 1;
    s.wind += p * r.wind;          // for averages weighted by how strong the drifting is
    s.loose += p * drift[i].loose;
  });
  makeChart(id, {
    type: "polarArea",
    data: {
      labels: DIRS,
      datasets: [{
        data: sectors.map(s => s.score),
        backgroundColor: sectors.map(s => loadingLevel(s.score).color),
        borderColor: "#16212f", borderWidth: 1,
      }],
    },
    // The scale is the index itself, so the rings carry plain numbers with no unit
    // No colour key for now (pass LOADING_LEVELS instead of [] to bring it back)
    options: roseOptions([], v => `${+v.toFixed(1)}`, {
      filter: item => sectors[item.dataIndex].score > 0.005,
      callbacks: {
        title: items => (items.length ? `${items[0].label} aspects · wind from ${oppositeDir(items[0].label)}` : ""),
        label: ctx => {
          const s = sectors[ctx.dataIndex];
          return [
            `Drifting potential: ${loadingLevel(s.score).label} (${r1(s.score)})`,
            `Hours with drifting: ${s.hours}`,
            `Typical wind then: ${r0(s.wind / s.score)} mph`,
            `Loose snow available then: about ${r1(s.loose / s.score)}"`,
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
          // A narrow chart (a phone) has no room for the snow water, so it gets the shorter label
          const roomy = area.right - area.left >= 520;
          const text = `${d.label}: ${r1(vals[at])}"` + (roomy && swe?.[at] != null ? ` (${r2(swe[at])}" SWE)` : "");
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

// `ahead` is the forecast for the chosen time range, starting at the current hour.
function renderCharts(ahead) {
  // Every time chart starts at midnight today, so its days line up with the snow summary and the
  // daily forecast: today's hours before now come first (the model's record of them, drawn
  // dimmed), then the forecast. `gone` is how many of those earlier hours there are.
  const fullRows = li => {
    const all = locRows[li] || [];
    return [...(all.earlier || []), ...all.slice(0, ahead.length)];
  };
  const rows = fullRows(0);
  const gone = rows.length - ahead.length;
  const fromNow = vals => vals.map((v, i) => (i < gone ? null : v)); // blank the hours before now
  const shade = gone ? [pastShade(gone, 0)] : [];
  // The scale goes on the right at a fixed width, the same as the snow summary, so the plot
  // areas of all the charts start and end at the same place across the page
  const onRight = y => ({ ...y, position: "right", afterFit: scale => { scale.width = SUMMARY_AXIS_PX; } });
  // The time axis starts hard against the left edge: each day's label begins at its midnight
  // line and runs under that day, instead of being centred on the line and pushing the plot in
  const alignDays = o => {
    o.scales.x.ticks.align = "start";
    o.scales.x.afterFit = scale => { scale.paddingLeft = 0; scale.paddingRight = 0; };
    o.layout = { ...o.layout, autoPadding: false }; // no extra margin for the wind arrows at the edges
    return o;
  };
  const labels = rows.map(r => r.time);
  tickEvery = ahead.length <= 24 ? 3 : ahead.length <= 72 ? 6 : ahead.length <= 168 ? 12 : 24;

  // Model comparison: one line per model, plus the average, so agreement and spread are visible
  const series = modelSeries(rows);
  // Model lines are drawn at ~55% opacity ("8c" alpha) so the white average stands out
  const modelLine = (s, data) => ({ label: s.name, data, borderColor: s.color + "8c", backgroundColor: s.color,
    borderWidth: 1, borderDash: s.dash, pointRadius: 0, order: 1 });
  const averageLine = data => ({ label: "Average of models", data, borderColor: "#ffffff", backgroundColor: "#ffffff",
    borderWidth: 3, pointRadius: 0, order: 0 });
  const hasData = vals => vals.some(v => v != null);
  const compareOptions = (yScale, fmt) => {
    const o = alignDays(baseOptions({ y: onRight(yScale) }));
    o.plugins.tooltip.callbacks.label = ctx => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`;
    o.plugins.tooltip.itemSort = (a, b) => b.parsed.y - a.parsed.y;
    return o;
  };

  // Snowfall chart: every location in its own colour, lowest first. Thin lines are the individual
  // models (told apart by dash pattern), the thick line is their average.
  const snowSets = [];
  const byElevation = locations.map((_, i) => i).sort((a, b) => locations[a].elevation_ft - locations[b].elevation_ft);
  for (const li of byElevation) {
    const loc = locations[li];
    const lr = li === 0 ? rows : fullRows(li);
    if (!lr.length) continue;
    const avg = averageSnow(lr, li === 0 ? series : modelSeries(lr, li));
    // Running totals count from now, so the lines begin at the "Now" mark, not at midnight
    if (avg.series.length > 1) {
      avg.series.forEach(s => {
        if (hasData(s.snow)) snowSets.push({ label: `${loc.name} · ${s.name}`, data: cumulative(fromNow(s.snow)),
          borderColor: loc.color + "8c", backgroundColor: loc.color, borderWidth: 1,
          borderDash: s.dash, pointRadius: 0, order: 1, loc: li });
      });
    }
    // `swe` rides along on the dataset so plateauLabels and the tooltip can show the matching water total
    snowSets.push({ label: loc.name, data: cumulative(fromNow(avg.snow)), swe: cumulative(fromNow(avg.swe)),
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
    plugins: [plateauLabels, ...shade],
  });

  // On the cloud chart the models share one colour and are told apart by line pattern alone
  const CLOUD_LINE = "#9fb3c8";
  const cloudSets = series.filter(s => hasData(s.cloud))
    .map(s => ({ ...modelLine(s, s.cloud), borderColor: CLOUD_LINE + "8c", backgroundColor: CLOUD_LINE })); // ~55% opacity
  if (series.length > 1) {
    // The average is coloured by its own value, blue when clear and grey when cloudy (skyLineColor)
    cloudSets.push({ ...averageLine(averageAcross(series, "cloud")), backgroundColor: SKY_CLEAR, borderColor: skyLineColor });
  }
  const cloudOptions = compareOptions({ min: 0, max: 100, title: { display: true, text: "%" } }, v => `${r0(v)}%`);
  cloudOptions.plugins.legend.display = false; // colour boxes can't show patterns; the key under the chart does
  makeChart("chart-cloud-models", {
    type: "line",
    data: { labels, datasets: cloudSets },
    options: cloudOptions,
    plugins: [dayNightBands(rows.map(r => r.isDay)), ...shade],
  });

  // Temperature and wind by model at the page's forecast point, drawn the same way as the cloud
  // chart: thin lines in one colour told apart by pattern, and a thick line for their average
  const thinModels = key => series.filter(s => hasData(s[key]))
    .map(s => ({ ...modelLine(s, s[key]), borderColor: CLOUD_LINE + "8c", backgroundColor: CLOUD_LINE }));
  const byModel = (id, key, yScale, fmt, average, extra = []) => {
    const sets = thinModels(key);
    if (series.length > 1) sets.push({ ...averageLine(averageAcross(series, key)), ...average });
    const o = compareOptions(yScale, fmt);
    o.plugins.legend.display = false; // the key under the chart shows the patterns
    o.plugins.tooltip.filter = item => !item.dataset.isGuide;
    makeChart(id, { type: "line", data: { labels, datasets: [...sets, ...extra] }, options: o, plugins: shade });
  };
  byModel("chart-temp-models", "temp", { title: { display: true, text: "°F" } }, v => `${r0(v)}°F`,
    // The average is red above freezing and blue at or below, as on the temperature chart
    { borderColor: "#ff7a5c", backgroundColor: "#ff7a5c", segment: { borderColor: ctx => (ctx.p1.parsed.y <= 32 ? "#7aa8ff" : "#ff7a5c") } },
    [{ label: "Freezing (32°F)", data: rows.map(() => 32), borderColor: "rgba(201,212,226,0.45)", borderWidth: 1, pointRadius: 0, isGuide: true }]);
  byModel("chart-wind-models", "wind", { beginAtZero: true, title: { display: true, text: "mph" } }, v => `${r0(v)} mph`,
    { borderColor: "#6cc3ff", backgroundColor: "#6cc3ff" });

  // The roses cover the forecast only, from now on. Drifting potential needs the loose snow
  // already lying about, so its calculation starts ten days back (the model's record of the
  // snow, temperature and wind at the page's forecast point) and then runs on through the
  // whole forecast with the model-average snowfall and that location's GFS wind.
  const before = snowHistory.filter(r => r.time < allRows[0].time).slice(-240);
  const driftFor = li => {
    const all = locRows[li];
    return driftPotential(before, all, averageSnow(all, modelSeries(all, li)).snow).slice(0, ahead.length);
  };
  // These charts are off the page while the Backcountry Ski Metrics tab is in development;
  // they are drawn again as soon as their canvases are put back in index.html.
  if (document.getElementById("chart-windrose")) {
    makeWindRose("chart-windrose", ahead);
    makeLoadingRose("chart-loading", ahead, driftFor(0));
    // The same pair for the top of Mt Baldy, from that point's own wind and snowfall
    const baldy = locations.findIndex(l => l.id === AREA.ridgePoint);
    if (baldy > 0 && locRows[baldy]?.length) {
      const baldyRows = locRows[baldy].slice(0, ahead.length);
      makeWindRose("chart-windrose-baldy", baldyRows);
      makeLoadingRose("chart-loading-baldy", baldyRows, driftFor(baldy));
    }
  }

  // Temperature at the page's forecast point plus the base and top of Collins. Colour shows
  // above or below freezing, so the locations are told apart by line style instead:
  // the forecast point is thick and solid, the extra ones thin with these dash patterns.
  const TEMP_EXTRA = AREA.tempExtra;
  const WARM = "#ff7a5c", COLD = "#7aa8ff";
  const tempLine = li => ({
    label: `${locations[li].name} (${locations[li].elevation_ft.toLocaleString()} ft)`,
    data: (li === 0 ? rows : fullRows(li)).map(r => r.temp),
    borderColor: WARM, borderWidth: li === 0 ? 2.5 : 1.5, borderDash: li === 0 ? [] : TEMP_EXTRA[locations[li].id],
    pointRadius: 0,
    segment: { borderColor: ctx => (ctx.p1.parsed.y <= 32 ? COLD : WARM) },
  });
  const tempLocs = byElevation.filter(li => li === 0 || locations[li].id in TEMP_EXTRA);
  const tempOptions = alignDays(baseOptions({ y: onRight({ title: { display: true, text: "°F" } }) }));
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
    plugins: shade,
  });

  // The direction the wind comes from is written above the gust line as compass letters, at
  // regular intervals that widen until the letters have room (about every 12 hours on 16 days)
  const every = ahead.length <= 24 ? 2 : ahead.length <= 72 ? 3 : 6; // the closest spacing, in hours
  const directionLetters = {
    id: "directionLetters",
    afterDatasetsDraw(chart) {
      const { ctx: g, chartArea: area, scales: { x, y } } = chart;
      const pxPerHour = (area.right - area.left) / Math.max(1, rows.length - 1);
      let step = every;
      while (step * pxPerHour < 28) step *= 2;
      g.save();
      g.font = "600 10px " + Chart.defaults.font.family;
      g.textAlign = "center";
      g.textBaseline = "bottom";
      g.lineWidth = 3;
      g.strokeStyle = "#16212f"; // card background, so the letters stay readable over the lines
      g.fillStyle = "#e6edf5";
      rows.forEach((r, i) => {
        if (i % step !== 0 || r.dir == null) return;
        const px = x.getPixelForValue(i);
        if (px < area.left + 10 || px > area.right - 10) return; // would be cut off at the edge
        const py = Math.max(area.top + 12, y.getPixelForValue(r.gust ?? r.wind ?? 0) - 5);
        g.strokeText(compass(r.dir), px, py);
        g.fillText(compass(r.dir), px, py);
      });
      g.restore();
    },
  };
  makeChart("chart-wind", {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Wind", data: rows.map(r => r.wind), borderColor: "#6cc3ff", backgroundColor: "rgba(108,195,255,0.15)",
          fill: true, borderWidth: 2, pointRadius: 0 },
        { label: "Gusts", data: rows.map(r => r.gust), borderColor: "#ff6b8b", borderWidth: 1.2, pointRadius: 0 },
      ],
    },
    options: (() => {
      const o = alignDays(baseOptions({ y: onRight({ beginAtZero: true, grace: "10%", title: { display: true, text: "mph" } }) }));
      o.plugins.tooltip.callbacks.label = ctx => `${ctx.dataset.label}: ${r0(ctx.parsed.y)} mph`;
      o.plugins.tooltip.callbacks.afterBody = items => {
        const r = items.length ? rows[items[0].dataIndex] : null;
        return r && r.dir != null ? `From ${compass(r.dir)} (${r0(r.dir)}°)` : "";
      };
      return o;
    })(),
    plugins: [directionLetters, ...shade],
  });

  // The rain & water chart is a day-by-day chart drawn by renderWater(), not zoomed by the tiles

  makeChart("chart-density", {
    type: "bar",
    data: {
      labels,
      datasets: [
        // Inches of snow per inch of water, for the hours when it snows; taller is lighter snow
        { label: "Snow-to-water ratio", data: rows.map(r => r.slr), backgroundColor: rows.map(r => ratioColor(r.slr)) },
      ],
    },
    options: (() => {
      const o = alignDays(baseOptions({ y: onRight({ beginAtZero: true, suggestedMax: 20,
        title: { display: true, text: "ratio" } }) }));
      o.plugins.legend.display = false;
      o.plugins.tooltip.callbacks.label = ctx => {
        const r = rows[ctx.dataIndex];
        return r.slr == null ? "No snow" : `${ratioText(r.slr)}: ${r2(r.snow)}" of snow from ${r2(r.swe)}" of water`;
      };
      return o;
    })(),
    plugins: shade,
  });
}

// ---------- Weather stations (measured, not forecast) ----------
// The area's stations are listed in AREAS at the top of this file. Every station ends up with
// `obs`: its readings, newest first, in the shape the National Weather Service feed uses
// ({ timestamp, temperature: { value }, windSpeed: { value }, ... } in °C and km/h).
const cToF = c => c * 9 / 5 + 32;
const kmhToMph = k => k * 0.621371;

async function loadStations() {
  const note = document.getElementById("stations-source");
  let results;
  if (AREA.stationFeed === "nws") {
    results = await Promise.all(AREA.stations.map(async s => {
      try {
        // 500 is the most the feed gives at once: 3.5 days at a reading every 10 minutes, more if less often
        const r = await fetch(`https://api.weather.gov/stations/${s.id}/observations?limit=500`);
        if (!r.ok) return { ...s, obs: [] };
        const j = await r.json();
        return { ...s, obs: (j.features || []).map(f => f.properties) }; // newest first
      } catch {
        return { ...s, obs: [] };
      }
    }));
  } else {
    // These stations are not on the public feed. scripts/fetch_stations.py saves their readings
    // to a file every hour (in °F, mph and inches), which is turned into the feed's shape here.
    let file = { columns: [], stations: {} };
    try {
      const res = await fetch(AREA.stationFeed, { cache: "no-store" });
      if (res.ok) file = await res.json();
    } catch { /* every station is then listed as not reporting */ }
    const col = name => file.columns.indexOf(name);
    const from = (row, name, convert = v => v) => {
      const v = row[col(name)];
      return { value: v == null ? null : convert(v) };
    };
    const fToC = f => (f - 32) * 5 / 9, mphToKmh = m => m / 0.621371;
    results = AREA.stations.map(s => ({
      ...s,
      obs: (file.stations[s.id]?.rows || []).map(row => ({
        timestamp: row[col("time")],
        temperature: from(row, "air_temp", fToC),
        relativeHumidity: from(row, "humidity"),
        dewpoint: from(row, "dew_point", fToC),
        windSpeed: from(row, "wind_speed", mphToKmh),
        windGust: from(row, "wind_gust", mphToKmh),
        windDirection: from(row, "wind_dir"),
        windChill: from(row, "wind_chill", fToC),
        snowDepth: from(row, "snow_depth"),       // inches; the public feed has no snow readings
        snowBoard: from(row, "snow_interval"),    // inches
      })).reverse(), // the file is oldest first
    }));
    if (note && file.updated) {
      const when = new Date(file.updated).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
      note.textContent = `${AREA.name}'s stations are collected once an hour, so a reading can be up to an hour or so old. Last collected ${when}.`;
    }
  }
  renderStations(results);
  checkRidgeWind(results).catch(err => console.warn("Station wind check unavailable", err));
}

function renderStations(results) {
  const val = (o, key, convert) => (o[key]?.value == null ? null : convert(o[key].value));
  const rows = [], silent = [];
  // The stations that have reported most in the last 24 hours come first; ties go to the lower one
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const useful = x => x.temperature?.value != null || x.windSpeed?.value != null;
  const lately = s => s.obs.filter(x => useful(x) && new Date(x.timestamp).getTime() >= dayAgo).length;
  const ranked = [...results].sort((a, b) => lately(b) - lately(a) || a.elevation_ft - b.elevation_ft);
  for (const s of ranked) {
    const o = s.obs.find(useful);
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
      <td>${lately(s)}</td>
    </tr>`);
  }
  const tbody = document.querySelector("#stations tbody");
  tbody.innerHTML = rows.length ? rows.join("")
    : '<tr><td colspan="8" class="muted">No station is reporting right now.</td></tr>';
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
            if (prev && prev.slice(0, 13) === t.slice(0, 13)) return null; // only an hour's first reading
            const spanHours = Math.max(1, (new Date(labels[labels.length - 1]) - new Date(labels[0])) / 3600000);
            return axisLabel(t.slice(0, 13) + ":00", everyHours, this.width / spanHours);
          },
        },
        grid: { color: ctx => (ctx.tick && ctx.tick.label ? "rgba(139,155,176,0.25)" : "transparent") },
      },
      y: yScale,
    },
  };
}

// How far back the station wind rose can look, in hours; the buttons in the corner of its card
const ROSE_SPANS = [
  { hours: 6, label: "6 h" }, { hours: 12, label: "12 h" }, { hours: 24, label: "24 h" },
  { hours: 48, label: "48 h" }, { hours: 72, label: "72 h" },
];
let stationRoseHours = 72;

// The picked station's measured wind rose over the last `stationRoseHours` hours, with the
// buttons that choose the period and a note saying what the rose actually covers
function drawStationRose() {
  const s = stationResults.find(r => r.id === activeStation);
  if (!s || !s.obs.length) return;
  const time = o => new Date(o.timestamp).getTime();
  const since = Date.now() - stationRoseHours * 3600000;
  const picked = s.obs.filter(o => time(o) >= since && o.windSpeed?.value != null && o.windDirection?.value != null);
  makeWindRose("chart-st-rose",
    picked.map(o => ({ dir: o.windDirection.value, wind: kmhToMph(o.windSpeed.value) })), "readings");

  const bar = document.getElementById("st-rose-range");
  bar.innerHTML = '<span class="muted small">Roses cover the last</span>' +
    ROSE_SPANS.map(p => `<button type="button" class="range-btn${p.hours === stationRoseHours ? " active" : ""}"
      data-span="${p.hours}" aria-pressed="${p.hours === stationRoseHours}">${p.label}</button>`).join("");
  bar.onclick = e => {
    const btn = e.target.closest("[data-span]");
    if (!btn) return;
    stationRoseHours = Number(btn.dataset.span);
    drawStationRose();
  };

  // Say plainly when the station's record is shorter than the period asked for
  const when = t => new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const oldest = time(s.obs[s.obs.length - 1]);
  document.getElementById("st-rose-note").textContent = !picked.length
    ? "No wind readings in this period."
    : `${picked.length} readings since ${when(time(picked[picked.length - 1]))}.` +
      (oldest > since + 3600000 ? ` This station's available readings only go back to ${when(oldest)}.` : "");

  drawStationDrift(); // the drifting rose beside it covers the same period
}

// Hour-by-hour model record at each station's own location (snow, temperature, wind), fetched
// the first time the station is picked. Keyed by station id; each entry is a promise.
const stationHistory = {};
function loadStationHistory(s) {
  if (!stationHistory[s.id]) {
    const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    const p = new URLSearchParams({
      latitude: s.lat,
      longitude: s.lon,
      elevation: Math.round(s.elevation_ft * 0.3048),
      timezone: locations[0].timezone,
      hourly: HISTORY_VARS.join(","),
      models: "ncep_gfs_seamless",
      start_date: day(-14), // ten days to build up the loose snow, plus the 72 hours the rose can show
      end_date: day(1),
      temperature_unit: "fahrenheit",
      precipitation_unit: "inch",
      wind_speed_unit: "mph",
    });
    stationHistory[s.id] = fetch("https://historical-forecast-api.open-meteo.com/v1/forecast?" + p, { cache: "no-store" })
      .then(res => { if (!res.ok) throw new Error(`Open-Meteo archive returned ${res.status}`); return res.json(); })
      .then(j => hourRows(j.hourly));
    stationHistory[s.id].catch(() => { delete stationHistory[s.id]; }); // let a later click try again
  }
  return stationHistory[s.id];
}

// "YYYY-MM-DDTHH:00" for a moment in time, in the given timezone: the format the model's hours use
const hourKeyIn = tz => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23" });
  return ms => {
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
  };
};

// Wind drifting potential at the picked station over the last `stationRoseHours` hours: the
// same index as the forecast roses, but with the wind the station actually measured. Snowfall
// is the model's record for the station's location, since the stations don't report snow.
async function drawStationDrift() {
  const s = stationResults.find(r => r.id === activeStation);
  const note = document.getElementById("st-drift-note");
  if (!s || !s.obs.length) return;
  const asked = { id: s.id, hours: stationRoseHours };
  note.textContent = "Loading the model's snowfall for this location…";
  let model;
  try {
    model = await loadStationHistory(s);
  } catch (err) {
    console.warn("Station snow history unavailable", err);
    note.textContent = "The model's snowfall for this location is unavailable right now.";
    return;
  }
  if (activeStation !== asked.id || stationRoseHours !== asked.hours) return; // another pick was made meanwhile

  // The station's readings averaged into hours: speed, direction (weighted by speed) and temperature
  const key = hourKeyIn(locations[0].timezone);
  const seen = {};
  for (const o of s.obs) {
    const b = (seen[key(new Date(o.timestamp).getTime())] ||= { n: 0, wind: 0, x: 0, y: 0, tn: 0, temp: 0 });
    if (o.windSpeed?.value != null && o.windDirection?.value != null) {
      const mph = kmhToMph(o.windSpeed.value), rad = o.windDirection.value * Math.PI / 180;
      b.n += 1; b.wind += mph; b.x += Math.sin(rad) * (mph || 0.1); b.y += Math.cos(rad) * (mph || 0.1);
    }
    if (o.temperature?.value != null) { b.tn += 1; b.temp += cToF(o.temperature.value); }
  }
  // The model's hours up to now, with the measured wind and temperature swapped in where the
  // station has them. Earlier hours keep the model's wind; they only build up the loose snow.
  const nowKey = key(Date.now());
  const rows = model.filter(r => r.time <= nowKey).map(r => {
    const b = seen[r.time];
    if (!b || !b.n) return { ...r, dir: null };
    return { ...r, wind: b.wind / b.n, dir: (Math.atan2(b.x, b.y) * 180 / Math.PI + 360) % 360,
      temp: b.tn ? b.temp / b.tn : r.temp, measured: true };
  });
  const drift = driftPotential([], rows, rows.map(r => r.snow));
  const sinceKey = key(Date.now() - stationRoseHours * 3600000);
  const picked = rows.map((_, i) => i).filter(i => rows[i].measured && rows[i].time > sinceKey);
  makeLoadingRose("chart-st-drift", picked.map(i => rows[i]), picked.map(i => drift[i]));

  const snow = picked.reduce((a, i) => a + (rows[i].snow || 0), 0);
  const score = picked.reduce((a, i) => a + drift[i].potential, 0);
  note.textContent = !picked.length ? "No wind readings in this period."
    : `Model snowfall here in this period: ${r1(snow)}". ` +
      (score < 0.005 ? "The measured wind was too light, or there was too little loose snow, for any drifting."
        : `Measured wind over ${picked.length} hours.`);
}

// Everything else a station on the NWS feed can report besides temperature and wind. Each one
// the picked station has readings for gets its own chart and its own column in the table.
// `convert` turns the feed's metric value into the unit shown; `zero` starts the axis at zero.
const STATION_EXTRAS = [
  { head: "Humidity", key: "relativeHumidity", unit: "%", color: "#6cc3ff", zero: true, convert: v => v, fmt: v => `${r0(v)}%` },
  { head: "Dew Point", key: "dewpoint", unit: "°F", color: "#5fd3a3", convert: cToF, fmt: v => `${r0(v)}°F` },
  { head: "Wind Chill", key: "windChill", unit: "°F", color: "#7aa8ff", convert: cToF, fmt: v => `${r0(v)}°F` },
  { head: "Heat Index", key: "heatIndex", unit: "°F", color: "#ff7a5c", convert: cToF, fmt: v => `${r0(v)}°F` },
  { head: "Precipitation, Last Hour", key: "precipitationLastHour", unit: "inches of water", color: "#6cc3ff", zero: true, bars: true,
    convert: v => v / 25.4, fmt: v => `${v.toFixed(2)}"` },
  { head: "Pressure", key: "barometricPressure", unit: "inHg", color: "#c9a6ff", convert: v => v / 3386.39, fmt: v => `${v.toFixed(2)} inHg` },
  { head: "Visibility", key: "visibility", unit: "miles", color: "#c9d4e2", zero: true, convert: v => v / 1609.34, fmt: v => `${r1(v)} mi` },
  // Snow only comes from the stations read from a saved file (see loadStations), already in inches
  { head: "New-Snow Board", key: "snowBoard", unit: "inches", color: "#9fd8ff", zero: true, convert: v => v, fmt: v => `${r1(v)}"` },
  { head: "Snow Depth", key: "snowDepth", unit: "inches", color: "#6cc3ff", zero: true, convert: v => v, fmt: v => `${r1(v)}"` },
];

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

  // A sensor that has read nothing but zero for a day (or nothing at all) is likely iced up or
  // broken: its charts go below the readings table. Worked out afresh on every load, so they
  // move back up once the sensor reports real values again.
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const recent = s.obs.filter(o => new Date(o.timestamp).getTime() >= dayAgo);
  const flat = keys => !(recent.length ? recent : s.obs).some(o => keys.some(k => o[k]?.value));
  // A station with no readings of a kind at all has no such sensor: those charts are left out
  const none = keys => !s.obs.some(o => keys.some(k => o[k]?.value != null));
  const blocks = [
    { id: "st-wind-block", name: "wind", keys: ["windSpeed", "windGust"] },
    { id: "st-temp-block", name: "temperature", keys: ["temperature"] },
  ].map(b => ({ ...b, missing: none(b.keys), flat: !none(b.keys) && flat(b.keys) }));
  blocks.forEach(b => { document.getElementById(b.id).hidden = b.missing; });
  const detail = document.getElementById("station-detail");
  // With four readings or fewer the charts say little, so the readings table goes first
  const live = [...blocks.filter(b => !b.flat), { id: "st-extra" }], log = { id: "st-log-block" };
  for (const b of [...(s.obs.length <= 4 ? [log, ...live] : [...live, log]), ...blocks.filter(b => b.flat)]) {
    const el = document.getElementById(b.id);
    el.classList.toggle("sensor-flat", !!b.flat); // red cards while moved down, the usual blue otherwise
    detail.appendChild(el);
  }
  const dead = blocks.filter(b => b.flat).map(b => b.name);
  document.getElementById("st-flat-note").textContent = !dead.length ? ""
    : `This station's ${dead.join(" and ")} ${dead.length > 1 ? "sensors have" : "sensor has"} read only zero, or nothing, ` +
      `over the last 24 hours, so the ${dead.join(" and ")} charts are at the bottom.`;

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

  drawStationRose(); // measured wind rose, over the period picked in its corner

  const tempOptions = stationOptions(labels, { title: { display: true, text: "°F" } });
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

  // One small chart for everything else the station reports, just above the readings table
  const extras = STATION_EXTRAS.filter(m => s.obs.some(o => o[m.key]?.value != null));
  Object.keys(charts).filter(id => id.startsWith("chart-st-x-")).forEach(id => { charts[id].destroy(); delete charts[id]; });
  document.getElementById("st-extra").innerHTML = extras.map(m => `<section class="card">
      <h2>${m.head} <span class="muted small">(${s.name} · ${s.elevation_ft.toLocaleString()} ft)</span></h2>
      <div class="chart-wrap"><canvas id="chart-st-x-${m.key}"></canvas></div>
    </section>`).join("");
  for (const m of extras) {
    const options = stationOptions(labels, { beginAtZero: !!m.zero, title: { display: true, text: m.unit } }, 12);
    options.plugins.legend.display = false;
    options.plugins.tooltip.callbacks.label = ctx => `${m.head}: ${m.fmt(ctx.parsed.y)}`;
    makeChart(`chart-st-x-${m.key}`, {
      type: m.bars ? "bar" : "line",
      data: {
        labels,
        datasets: [{ label: m.head, data: obs.map(o => get(o, m.key, m.convert)), borderColor: m.color,
          backgroundColor: m.bars ? m.color : m.color + "26", fill: !!m.zero, borderWidth: m.bars ? 0 : 2,
          pointRadius: 0, spanGaps: true }],
      },
      options,
    });
  }

  // Reading-by-reading table, newest first, with only the columns this station reports
  const columns = [
    { head: "Temp", key: "temperature", fmt: v => `${r0(cToF(v))}°F` },
    { head: "Wind", key: "windSpeed", fmt: v => `${r0(kmhToMph(v))} mph` },
    { head: "Gust", key: "windGust", fmt: v => `${r0(kmhToMph(v))} mph` },
    { head: "From", key: "windDirection", fmt: v => `${compass(v)} (${r0(v)}°)` },
    ...STATION_EXTRAS.map(m => ({ head: m.head, key: m.key, fmt: v => m.fmt(m.convert(v)) })),
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
  const st = AREA.ridgeStations.map(id => results.find(r => r.id === id)).find(hasWind);
  if (!st) return;
  const loc = locations.find(l => l.id === AREA.ridgePoint) ?? locations[0];

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
  for (const v of ["forecast", "metrics", "models", "stations", "guide", "info"]) document.getElementById(`view-${v}`).hidden = v !== view;
  document.querySelectorAll(".tab").forEach(b => {
    b.classList.toggle("active", b === btn);
    b.setAttribute("aria-pressed", b === btn);
  });
  // Keep the tab in the address, so a reload or a switch of resort comes back to it
  history.replaceState(null, "", location.pathname + location.search + (view === "forecast" ? "" : `#${view}`));
  // Charts can't measure themselves while hidden, so refit them when their tab comes back
  Object.values(charts).forEach(c => c.resize());
}));
// A link ending in #metrics, #models, #stations, #guide or #info opens straight on that tab
if (["#metrics", "#models", "#stations", "#guide", "#info"].includes(location.hash)) document.querySelector(`.tab[data-view="${location.hash.slice(1)}"]`).click();

// ---------- National Weather Service ----------
async function loadNws(loc) {
  const box = document.getElementById("nws");
  try {
    const point = await fetch(`https://api.weather.gov/points/${loc.lat},${loc.lon}`).then(r => {
      if (!r.ok) throw new Error(`NWS ${r.status}`);
      return r.json();
    });
    const fc = await fetch(point.properties.forecast).then(r => r.json());

    box.innerHTML = fc.properties.periods.map(p => `
      <div class="nws-period" title="${p.detailedForecast.replace(/"/g, "&quot;")}">
        <img src="${p.icon}" alt="">
        <div class="name">${p.name}</div>
        <div class="temp">${p.temperature}°${p.temperatureUnit}</div>
        <div>${p.shortForecast}</div>
        <div class="muted">${p.windSpeed} ${p.windDirection}</div>
      </div>`).join("");
  } catch (err) {
    console.error(err);
    box.innerHTML = `<p class="muted">NWS forecast unavailable right now (${err.message}).</p>`;
  }
}
