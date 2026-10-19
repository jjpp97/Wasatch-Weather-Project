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
  // ECMWF's main model at 9 km. Drawn on the snowfall charts for comparison only: it is in no
  // average and on no other chart (snowOnly, notInAverage). Its snowfall is reported at 7 to 1,
  // like NAM's, so it goes through the same conversion as the other models.
  { id: "ecmwf_ifs", name: "ECMWF IFS (not in average)", color: "#ff6fae", dash: [], snowOnly: true, notInAverage: true },
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
    // The resort's own mountain cams, shown on its Cams tab from highest on the mountain to lowest.
    // The addresses are the ones alta.com/weather uses; if Alta moves a camera its picture stops
    // loading and its address needs updating here.
    cams: [
      { name: "Mount Baldy", src: "https://app.prismcam.com/public/helpers/realtime_preview.php?c=88&s=720" },
      { name: "Salt Lake Valley", src: "https://alta-webcams.sfo3.cdn.digitaloceanspaces.com/collins_dtc.jpg" },
      { name: "Sugarloaf Peak", src: "https://alta-webcams.sfo3.cdn.digitaloceanspaces.com/sugar_peak.jpg" },
      { name: "East Greeley", src: "https://alta-webcams.sfo3.cdn.digitaloceanspaces.com/Greeley.jpg" },
      { name: "Mount Superior", src: "https://alta-webcams.sfo3.cdn.digitaloceanspaces.com/Superior.jpg" },
      { name: "Snow Stake", note: "Collins study plot · board cleared daily at 4am and 4pm, conditions permitting",
        src: "https://alta-webcams.sfo3.cdn.digitaloceanspaces.com/Collins_Snow_Stake.jpg" },
      { name: "Albion Basin", src: "https://app.prismcam.com/public/helpers/realtime_preview.php?c=65&s=720" },
      { name: "High Rustler", src: "https://alta-webcams.sfo3.cdn.digitaloceanspaces.com/Highrustler.jpg" },
    ],
    camSource: { name: "Alta Ski Area", url: "https://www.alta.com/weather" },
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
  deervalley: {
    name: "Deer Valley",
    // Ontario's precipitation gauge reads almost nothing while snow piles up on its board (it
    // looks like a rain gauge that cannot catch snow), so no SWE is worked out from it (swe: false)
    snow: { file: "data/deer-valley-ontario.json", name: "DV Ontario station", tenths: true, swe: false },
    tempExtra: { "deer-valley-base": [7, 4], "deer-valley-empire-peak": [2, 3] },
    ridgePoint: "deer-valley-empire-peak",
    ridgeStations: ["EMPUT", "MBY"],
    // All on the National Weather Service's public feed, read live like Alta's
    stationFeed: "nws",
    stations: [
      { id: "DVE", name: "DV Burns", elevation_ft: 7333, lat: 40.634029, lon: -111.479465 },
      { id: "UTONM", name: "SR-224 Ontario Mine (road)", elevation_ft: 7723, lat: 40.6253, lon: -111.4968 },
      { id: "SNV", name: "DV Ruby", elevation_ft: 8300, lat: 40.6152, lon: -111.5110 },
      { id: "DVB", name: "DV Bald Eagle", elevation_ft: 8400, lat: 40.6236, lon: -111.4809 },
      { id: "DVP", name: "DV Park Peak", elevation_ft: 8868, lat: 40.59296, lon: -111.49270 },
      { id: "DVO", name: "DV Ontario", elevation_ft: 9100, lat: 40.609141, lon: -111.497424 },
      { id: "MBY", name: "DV Mount Baldy", elevation_ft: 9347, lat: 40.6089, lon: -111.4802 },
      { id: "EMPUT", name: "DV Empire Peak", elevation_ft: 9570, lat: 40.6119, lon: -111.5272 },
    ],
  },
};
// A spot picked on the Map: "?lat=40.5763&lon=-111.6383&ft=9662" opens the full forecast for it.
// It is a page like a resort's with one forecast point and no stations, measured snow or cams.
// `ft` is the ground's height there; if it is missing it is looked up when the page opens.
const POINT = (() => {
  const q = new URLSearchParams(location.search);
  const lat = parseFloat(q.get("lat")), lon = parseFloat(q.get("lon")), ft = parseFloat(q.get("ft"));
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, ft: Number.isFinite(ft) ? ft : null } : null;
})();
const AREA_KEY = POINT ? "point" : (() => {
  const asked = (new URLSearchParams(location.search).get("area") || "").toLowerCase();
  return asked in AREAS ? asked : "alta";
})();
const AREA = POINT
  ? { name: "Map point", snow: null, tempExtra: {}, ridgePoint: null, ridgeStations: [], stationFeed: null, stations: [] }
  : AREAS[AREA_KEY];

// The forecast point for a spot on the map, in the shape of an entry in locations.json
const pointLoc = (lat, lon, ft) => ({ id: "point", area: "Map point", name: "This spot", lat, lon,
  elevation_ft: Math.round(ft), timezone: "America/Denver", color: "#ffffff" });
// The ground's height at a spot in feet, from Open-Meteo's elevation data (about 90 m resolution)
async function pointElevationFt(lat, lon) {
  const j = await apiJson(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
  return j.elevation[0] * 3.28084;
}

// ---------- Downloads, kept for three minutes ----------
// Every weather download goes through apiJson(). The answer is kept in the browser (its Cache
// Storage, which survives closing the page) and reused for API_FRESH_MS, so reopening the page,
// reloading it or switching resort inside three minutes asks the weather services for nothing.
const API_FRESH_MS = 3 * 60 * 1000;
const API_STORE = "wasatch-downloads-v1";
const apiFetchedAt = new Map(); // address -> when its data was actually downloaded (ms)
const apiStore = (async () => {
  try {
    const store = await caches.open(API_STORE);
    // Clear out answers that are too old to be used again
    for (const req of await store.keys()) {
      const hit = await store.match(req);
      if (!hit || Date.now() - Number(hit.headers.get("x-fetched-at")) >= API_FRESH_MS) store.delete(req);
    }
    return store;
  } catch {
    return null; // no Cache Storage (an old browser, or a page opened straight from a file): always download
  }
})();
const apiPending = new Map(); // downloads under way, so two requests for one address share a download

// The JSON at `url`, from the saved copy when it is under three minutes old. Throws if the
// download fails. `options` are passed to fetch().
function apiJson(url, options) {
  const key = new URL(url, location.href).href;
  if (!apiPending.has(key)) {
    apiPending.set(key, (async () => {
      const store = await apiStore;
      if (store) {
        const hit = await store.match(key);
        const at = hit ? Number(hit.headers.get("x-fetched-at")) : 0;
        if (hit && Date.now() - at < API_FRESH_MS) {
          apiFetchedAt.set(key, at);
          return hit.json();
        }
      }
      const res = await fetch(key, options);
      if (!res.ok) throw new Error(`${new URL(key).hostname} returned ${res.status}`);
      const text = await res.text();
      const data = JSON.parse(text);
      const at = Date.now();
      apiFetchedAt.set(key, at);
      if (store) {
        store.put(key, new Response(text, { headers: { "content-type": "application/json", "x-fetched-at": String(at) } }))
          .catch(() => {}); // a full disk only costs the saving
      }
      return data;
    })().finally(() => apiPending.delete(key)));
  }
  return apiPending.get(key);
}

const charts = {};
let locations = [];   // this area's entries in locations.json; the first is the forecast point for the whole page
let locRows = [];     // processed GFS forecast for each location, in the same order
let allRows = [];     // processed GFS forecast for the first location, filled by main()
let currentObs = null; // current conditions from the same response
let modelData = null; // raw multi-model response per location, filled by loadModels()

// ---------- Entry point ----------
// main() is called at the very end of this file, once everything below is defined. (A map spot's
// page reaches pointParams() and the rest without waiting on any download, so starting here
// failed with "cannot access before initialization".)

async function main() {
  const status = document.getElementById("status");
  try {
    locations = POINT
      ? [pointLoc(POINT.lat, POINT.lon, POINT.ft ?? await pointElevationFt(POINT.lat, POINT.lon))]
      : (await fetch("locations.json").then(r => r.json())).filter(l => l.area === AREA.name);
    // The first location drives the whole page; the others only appear on the snowfall chart
    const loc = locations[0];
    showArea();

    // Run the NWS request in parallel; it renders on its own and never blocks the page
    loadNws(loc);
    loadModels(locations); // same idea: the comparison charts fill in when the other models arrive
    loadStations().catch(err => console.warn("Weather stations unavailable", err)); // measured conditions
    loadHistory(loc).catch(err => console.warn("Snow history unavailable", err));    // past days on the snow summary
    loadMeasured().catch(err => console.warn("Measured snow unavailable", err));     // storm totals from the area's study plot

    await loadForecast();
    status.hidden = true;
  } catch (err) {
    console.error(err);
    status.textContent = "Couldn't load the forecast: " + err.message;
    status.classList.add("error");
  }
}

// The GFS + HRRR forecast for every forecast point, and everything on the Forecast tab drawn from it.
// Run by main() and again by the refresh button; a chosen time range is kept unless it was "16 days",
// which follows the new forecast's length.
async function loadForecast() {
  const all = await getForecast(locations);
  if (activeHours === allRows.length) activeHours = null;
  locRows = all.map(processForecast);
  applyModelAverages(); // does nothing yet if the other models have not arrived
  const data = all[0];
  const fc = locRows[0];
  allRows = fc;
  currentObs = data.current;
  renderNow(fc, data.current);
  renderSummary();
  renderWater();
  renderDailyForecast();
  renderCharts(fc.slice(0, activeHours ?? fc.length));
  // The Machine Learning tab corrects this forecast's models
  if (mlShowing()) drawMachineLearning();
}

// The downloads behind each of a resort's tabs that have data, so the refresh button can tell
// whether the open tab has anything over three minutes old. Filled as the downloads are made.
const tabDownloads = { forecast: new Set(), models: new Set(), stations: new Set(), "machine-learning": new Set() };
const track = (tabs, url) => { tabs.forEach(t => tabDownloads[t].add(new URL(url, location.href).href)); return url; };

// The resort's name and the menu of other resorts, and every piece of wording on the page that names the resort or
// one of its forecast points. In index.html, <span data-fill="main"> is filled with the text
// for "main" below, and an element with data-area="solitude" only shows on the Solitude page.
function showArea() {
  document.title = `${AREA.name} · Wasatch Backcountry Ski Weather Forecast`;
  // A tab for every resort in AREAS beside the refresh button, the one being shown highlighted.
  // They scroll sideways when there is not room for them all.
  const nav = document.getElementById("loc-name");
  // A spot from the Map gets just one tab, in place of the resorts': its position and height,
  // linking back to the Map
  nav.innerHTML = POINT
    ? `<a class="area-tab active" href="?#map" aria-current="page" title="Back to the map">📍 ` +
      `${POINT.lat.toFixed(4)}, ${POINT.lon.toFixed(4)} · ${locations[0].elevation_ft.toLocaleString()} ft</a>`
    : Object.entries(AREAS).map(([key, a]) =>
      `<a class="area-tab${key === AREA_KEY ? " active" : ""}" href="?area=${key}"${key === AREA_KEY ? ' aria-current="page"' : ""}>${a.name}</a>`).join("");
  if (POINT) document.getElementById("resort-forecasts").classList.remove("active");
  // The refresh button sits just after the open resort's tab
  nav.querySelector(".active")?.after(document.getElementById("refresh"));
  nav.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  // The same resorts under "Resort Forecasts" in the three-line menu, each opening on its Forecast
  // tab. The arrow beside "Resort Forecasts" shows and hides them.
  const resortList = document.getElementById("resort-list");
  resortList.innerHTML = Object.entries(AREAS).map(([key, a]) =>
    `<a class="tab${key === AREA_KEY ? " active" : ""}" href="?area=${key}">${a.name}</a>`).join("");
  const toggle = document.getElementById("resort-toggle");
  toggle.onclick = () => {
    resortList.hidden = !resortList.hidden;
    toggle.setAttribute("aria-expanded", !resortList.hidden);
  };
  // Switching resort keeps you on the tab you were looking at
  nav.onclick = e => {
    const a = e.target.closest("a");
    if (!a || a.getAttribute("href") === "?#map") return; // the map spot's own tab goes back to the Map
    a.href = a.getAttribute("href").split("#")[0] + (["#storms", "#mountains", "#cameras", "#allstations", "#map"].includes(location.hash) ? "" : location.hash);
  };
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
    snowStation: AREA.snow?.name ?? "",
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
async function getForecast(locs, quiet = false) {
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

  let url = build(HOURLY_VARS), data;
  try {
    data = await apiJson(url, { cache: "no-store" });
  } catch (err) {
    console.warn("Full variable set rejected, retrying with minimal set", err);
    url = build(HOURLY_VARS_MIN);
    data = await apiJson(url, { cache: "no-store" });
  }
  if (!quiet) { noteDownload(url); track(["forecast"], url); } // only the page's own forecast sets the "Updated" time
  return [].concat(data); // a single location comes back as one object, several as a list
}
// Shows when the page's forecast (at `url`) was downloaded, which can be up to three minutes
// before the page opened
function noteDownload(url) {
  document.getElementById("updated").textContent =
    "Updated " + new Date(apiFetchedAt.get(new URL(url).href) ?? Date.now()).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

// Snowfall and cloud cover from every model in MODELS at every location, for the comparison charts
const modelsUrl = locs => "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
  ...pointParams(locs),
  hourly: "snowfall,cloud_cover,precipitation_probability,temperature_2m,wind_speed_10m",
  models: MODELS.map(m => m.id).join(","),
  forecast_days: 16,
  precipitation_unit: "inch",
  temperature_unit: "fahrenheit",
  wind_speed_unit: "mph",
});
async function loadModels(locs) {
  try {
    // The Forecast tab's averages come from these as well as the Spaghettis tab's lines
    modelData = [].concat(await apiJson(track(["forecast", "models"], modelsUrl(locs)), { cache: "no-store" }));
    applyModelAverages();
    if (allRows.length) {
      renderNow(allRows, currentObs); // snow tiles switch to the model average
      renderSummary();
      renderWater();
      renderDailyForecast();
      renderCharts(allRows.slice(0, activeHours ?? allRows.length));
      if (mlShowing()) drawMachineLearning();
    }
  } catch (err) {
    console.warn("Model comparison unavailable, showing GFS only", err);
  }
}

// Temperature and wind speed on the Forecast tab are the average of the models, the same line
// as "Average of the models" on the Spaghettis tab. Each hour's `temp` and `wind` are
// replaced by that average once both the forecast and the other models have loaded; the GFS's
// own values are kept as `tempGfs` and `windGfs`. An hour that fewer than two models cover
// keeps the GFS value. Everything worked out from temperature inside processForecast (the
// snow-to-water ratio, rain or snow) has already been done with the GFS by then and is not
// touched, and gusts, direction and feels-like stay as the GFS gave them.
function applyModelAverages() {
  if (!modelData || !locRows.length) return;
  locRows.forEach((rows, li) => {
    if (!modelData[li]) return;
    const full = [...(rows.earlier || []), ...rows];
    full.forEach(r => { if (r.tempGfs === undefined) { r.tempGfs = r.temp; r.windGfs = r.wind; r.gustGfs = r.gust; } });
    const series = modelSeries(full, li);
    const temp = averageAcross(series, "temp"), wind = averageAcross(series, "wind");
    full.forEach((r, i) => {
      r.temp = temp[i] ?? r.tempGfs;
      r.wind = wind[i] ?? r.windGfs;
      // A gust is never less than the wind it is a gust of
      r.gust = r.gustGfs == null || r.wind == null ? r.gustGfs : Math.max(r.gustGfs, r.wind);
      r.averaged = temp[i] != null || wind[i] != null;
    });
  });
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
      // Already in feet above sea level: asking Open-Meteo for inches switches its heights to feet too
      freezeFt: get("freezing_level_height", i),
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
    // Once the models have loaded, the temperature and wind are their average for the current hour
    { label: "Now", value: `${r0(rows[0].averaged ? rows[0].temp : cur.temperature_2m ?? rows[0].temp)}°F`, sub: words,
      icon: symbol ? `<span class="wx-icon" aria-hidden="true">${symbol}</span>` : "", cls: "now" },
    // The direction the wind comes from sits beside the speed; gusts go underneath
    { label: "Wind", value: `${r0(rows[0].averaged ? rows[0].wind : cur.wind_speed_10m ?? rows[0].wind)} mph <span class="wind-dir">${compass(cur.wind_direction_10m ?? rows[0].dir)}</span>`,
      sub: `Gusts ${r0(cur.wind_gusts_10m ?? rows[0].gust)} mph`, cls: "wind" },
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
  // The measured-snow box goes in after these three; `contents` lets it sit in the same row
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
  if (!AREA.snow) return; // a map point has no study plot
  measured = parseMeasured(await apiJson(track(["forecast"], AREA.snow.file), { cache: "no-store" }), AREA.snow);
  refreshMeasuredTiles();
}

// A study plot's data file turned into its measured new snow (and snow water, where the station
// has a gauge that can be trusted). `snow` is the area's AREAS[...].snow settings.
function parseMeasured(file, snow) {
  const col = name => file.columns.indexOf(name);
  const all = file.rows.map(r => ({ t: Date.parse(r[col("time")]), board: r[col("snow_interval")], temp: r[col("air_temp")],
    precip: col("precip_1h") < 0 ? null : r[col("precip_1h")] })).filter(r => !Number.isNaN(r.t));
  const readings = all.filter(r => r.board != null);

  // Snow water (SWE) from the station's precipitation gauge, where it has one: the water that
  // fell in each hour, counted only while it was SNOW_MAX_F or colder at the station, since the
  // gauge cannot tell snow from rain. Null for a station with no gauge.
  const SNOW_MAX_F = 35;
  const gauge = all.filter(r => r.precip != null);
  const water = gauge.length && snow.swe !== false
    ? gauge.filter(r => r.precip > 0 && (r.temp == null || r.temp <= SNOW_MAX_F)).map(r => ({ t: r.t, inches: r.precip }))
    : null;

  // New snow from the "snow interval" board, which staff clear from time to time. Snow is counted
  // whenever the board rises above its highest reading since it was last cleared. A drop of more
  // than 2" to 1" or less means it was cleared; a drop that leaves more is settling, and smaller
  // dips are settling or sensor noise and are ignored.
  // Readings taken above TOO_WARM_F are skipped altogether: the board cannot be gaining snow then,
  // so a jump is a sensor glitch (one read 9" for a single hour at 55°F).
  const TOO_WARM_F = 40;
  // A one-reading spike is a sensor glitch too: a reading more than 3" above the readings on
  // both sides of it, when those two agree to within 1". (A board cleared straight after a big
  // hour drops far below the reading before, so real snow is not thrown away.)
  const steady = readings.filter((r, i) => {
    const a = readings[i - 1], b = readings[i + 1];
    return !(a && b && r.board - a.board > 3 && r.board - b.board > 3 && Math.abs(b.board - a.board) <= 1);
  });
  const newSnow = [];
  let peak = null;
  for (const r of steady) {
    if (r.temp != null && r.temp > TOO_WARM_F) continue;
    if (peak == null || r.board < peak - 2) {
      // A drop of more than 2" is a clearing only if the board is left near empty (1" or less);
      // otherwise the snow has settled, and counting carries on from the lower level. (Counting a
      // settled board as cleared added up to 75" a season too much against Alta's own totals.)
      if (peak != null && r.board > 1) { peak = r.board; continue; }
      if (peak != null && r.board > 0) newSnow.push({ t: r.t, inches: r.board }); // already some on the cleared board
      peak = r.board;
    } else if (r.board > peak) {
      newSnow.push({ t: r.t, inches: r.board - peak });
      peak = r.board;
    }
  }
  return {
    name: snow.name,
    tenths: snow.tenths,
    elevation_ft: file.station.elevation_ft,
    newSnow,
    water,
    first: readings.length ? readings[0].t : null,
    latest: readings.length ? readings[readings.length - 1].t : null,
  };
}

// The snow box beside Now, Wind and Clouds, as wide as those three together. Four periods side
// by side: the most recent storm (the same storm days as the Snow Summary) and the last 12
// hours, 24 hours and 7 days. Each shows the snow measured at the area's study plot and, smaller
// underneath, the model's estimate of what fell at the forecast point over the same period.
function refreshMeasuredTiles() {
  const box = document.getElementById("measured-tiles");
  const note = document.getElementById("measured-note");
  if (!box || !note) return;
  if (!measured || measured.latest == null) { box.innerHTML = ""; note.textContent = ""; return; }

  // The newest storm on the Snow Summary that has started: one under way, or else the last one
  const today = hourKeyIn(locations[0].timezone)(Date.now()).slice(0, 10);
  const storm = [...snowStorms].reverse().find(s => s.from <= today);
  // The model's record of snow already fallen: every hour before the one under way
  const past = allRows.length ? snowHistory.filter(r => r.time < allRows[0].time) : [];
  const { cols, partial } = snowBoxCols(measured, storm, past, locations[0].timezone);
  box.innerHTML = snowBoxHtml(cols, measured, locations[0].name);
  note.textContent = measuredNote(measured, partial);
}

// The four columns of a snow box: { label, measured, swe, model } for the storm (`storm` is
// { from, to } day keys, or null) and the last 12 hours, 24 hours and 7 days. `past` is the
// model's hourly record before the hour under way; `tz` the forecast point's timezone.
function snowBoxCols(m, storm, past, tz) {
  const now = Date.now();
  const dayOf = hourKeyIn(tz); // "YYYY-MM-DDTHH:00" for a moment in time
  const add = (list, keep) => list.reduce((a, s) => a + (keep(s.t) ? s.inches : 0), 0);
  const total = keep => add(m.newSnow, keep);
  const swe = keep => (m.water ? add(m.water, keep) : null); // null: the station has no usable gauge
  const model = keep => (past.length ? past.reduce((a, r) => a + (keep(r.time) ? r.snow || 0 : 0), 0) : null);
  const lastHours = (label, h) => {
    const since = dayOf(now - h * 3600000);
    const recent = t => t > now - h * 3600000;
    return { label, measured: total(recent), swe: swe(recent), model: model(time => time >= since) };
  };
  const cols = [];
  let partial = false;
  if (storm) {
    const md = k => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
    const dates = storm.from === storm.to ? md(storm.from) : `${md(storm.from)}–${md(storm.to)}`;
    const inDays = day => day >= storm.from && day <= storm.to;
    partial = m.first != null && dayOf(m.first).slice(0, 10) > storm.from; // the measured record starts after the storm did
    const inStorm = t => inDays(dayOf(t).slice(0, 10));
    cols.push({ label: `Storm ${dates}`, isStorm: true, measured: total(inStorm), swe: swe(inStorm),
      model: model(time => inDays(time.slice(0, 10))) });
  }
  cols.push(lastHours("Last 12 h", 12), lastHours("Last 24 h", 24), lastHours("Last 7 days", 168));
  return { cols, partial };
}

// The snow box itself, measured snow large with SWE beside it and the model's estimate below.
// `head` is optional HTML for a line across the top of the box (Storm Results uses it).
function snowBoxHtml(cols, m, pointName, head = "") {
  const inches = v => `${m.tenths ? r1(v) : r0(v)}"`;
  return `
    <div class="tile snow-box" style="--cols: ${cols.length}"
         title="Top: snow${m.water ? " and snow water (SWE)" : ""} measured at the ${m.name}, ${m.elevation_ft.toLocaleString()} ft. Below: the model's snow estimate for ${pointName}.">
      ${head ? `<div class="snow-head">${head}</div>` : ""}
      ${cols.map(c => `<div class="snow-col">
        <div class="label">${c.label}</div>
        <div class="snow-line">
          <span class="value">${inches(c.measured)}</span>
          ${c.swe == null ? "" : `<span class="swe">${r2(c.swe)}" SWE</span>`}
        </div>
        <div class="model"><span class="model-word">model</span> ${c.model == null ? "–" : `${r1(c.model)}"`}</div>
      </div>`).join("")}
    </div>`;
}

// The line under a snow box: where the snow was measured and how fresh the reading is
function measuredNote(m, partial) {
  const when = new Date(m.latest).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const hoursOld = (Date.now() - m.latest) / 3600000;
  return `Measured at the ${m.name}, latest ${when}` +
    (hoursOld > 3 ? ` (${r0(hoursOld)} hours old)` : "") +
    (partial ? "; its record starts partway through the storm" : "") +
    `. Small numbers: model estimate.`;
}

// ---------- Storm Results (in the Locations menu) ----------
// Every resort's snow box on one page, the resort with the most measured storm snow first.
// Each resort needs only its study plot's file and one download of the GFS model's record and
// forecast for its main forecast point, which also picks out the storm: the run of days with at
// least 0.05" of model snow that is under way, or else the last one (the Snow Summary's rule,
// but from the GFS alone rather than the model average, so a storm's last day can differ by one).
let stormResultsShown = false;
let stormUrls = []; // the downloads behind Storm Results, for its refresh button
async function renderStormResults() {
  const holder = document.getElementById("storm-results");
  if (!holder || stormResultsShown) return;
  stormResultsShown = true;
  holder.innerHTML = '<p class="muted">Loading every resort…</p>';
  const when = ms => new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const allLocs = await fetch("locations.json").then(r => r.json());
  stormUrls = [];
  const day = offset => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  const results = await Promise.all(Object.entries(AREAS).map(async ([key, area]) => {
    const loc = allLocs.find(l => l.area === area.name);
    try {
      const p = new URLSearchParams({
        ...pointParams([loc]), hourly: HISTORY_VARS.join(","), models: "ncep_gfs_seamless",
        start_date: day(-14), end_date: day(15),
        temperature_unit: "fahrenheit", wind_speed_unit: "mph", precipitation_unit: "inch",
      });
      const histUrl = "https://historical-forecast-api.open-meteo.com/v1/forecast?" + p;
      stormUrls.push(new URL(area.snow.file, location.href).href, new URL(histUrl).href);
      const [file, hist] = await Promise.all([apiJson(area.snow.file, { cache: "no-store" }),
        apiJson(histUrl, { cache: "no-store" })]);
      const m = parseMeasured(file, area.snow);
      const rows = hourRows(hist.hourly);
      const nowKey = hourKeyIn(loc.timezone)(Date.now());
      const daily = new Map();
      rows.forEach(r => daily.set(r.time.slice(0, 10), (daily.get(r.time.slice(0, 10)) || 0) + (r.snow || 0)));
      const storm = latestStorm(daily, nowKey.slice(0, 10));
      const { cols, partial } = snowBoxCols(m, storm, rows.filter(r => r.time < nowKey), loc.timezone);
      return { key, area, loc, m, cols, partial, stormSnow: cols.find(c => c.isStorm)?.measured ?? 0 };
    } catch (err) {
      console.warn(`Storm results unavailable for ${area.name}`, err);
      return { key, area, failed: true, stormSnow: -1 };
    }
  }));
  results.sort((a, b) => b.stormSnow - a.stormSnow);
  // Each resort is its own card and the whole card links to that resort's forecast. The station
  // and the time of its latest reading sit at the right of the resort's name.
  holder.innerHTML = results.map(r => {
    const ok = !r.failed && r.m.latest != null;
    const hoursOld = ok ? (Date.now() - r.m.latest) / 3600000 : 0;
    const source = ok ? `${r.m.name.replace(/ station$/, "")} · updated ${when(r.m.latest)}` +
      (hoursOld > 3 ? ` (${r0(hoursOld)} h old)` : "") + (r.partial ? " · partial storm record" : "") : "";
    // The resort's name and the station sit inside the snow box, along its top
    const head = `<h3>${r.area.name}</h3><span class="muted small">${source}</span>`;
    return `<a class="storm-card" href="?area=${r.key}" aria-label="${r.area.name} forecast">
      ${ok ? snowBoxHtml(r.cols, r.m, r.loc.name, head)
        : `<div class="tile snow-box"><div class="snow-head">${head}</div><p class="muted small">No data right now.</p></div>`}
    </a>`;
  }).join("");
}

// ---------- Weather Cameras (in the Locations menu) ----------
// First Alta's own mountain cams (the same list as Alta's Cams tab, highest first), then UDOT's
// road cameras in and below the Cottonwood canyons, from its Cottonwood Canyons page. A UDOT cam's
// `view` is a camera view number: the picture is at udottraffic.utah.gov/map/Cctv/<view>, a plain
// image UDOT updates about once a minute, with no key needed. Listed from the top of each canyon
// down. If UDOT replaces a camera its picture stops loading and its number needs updating here.
// A group without `source` is UDOT's; `source` can be one { name, url } or a list of them, and
// `about` is added to the credit line under the pictures.
const UDOT_SOURCE = { name: "UDOT Cottonwood Canyons", url: "https://cottonwoodcanyons.udot.utah.gov/road-information/" };
const SNOWBIRD_SOURCE = { name: "Snowbird", url: "https://www.snowbird.com/the-mountain/webcams/snowstake-webcam/" };
const SOLITUDE_SOURCE = { name: "Solitude Mountain Resort", url: "https://www.solitudemountain.com/mountain-and-village/webcams" };
const SNOWBASIN_SOURCE = { name: "Snowbasin Resort", url: "https://www.snowbasin.com/the-mountain/web-cams/" };
// The line under a resort cam's picture naming the resort it comes from (`s` is { name, url })
const camCredit = s => (s ? `<span class="cam-credit">Courtesy of <a href="${s.url}" target="_blank" rel="noopener">${s.name}</a></span>` : "");
const CAMERA_GROUPS = [
  { key: "alta", name: "Alta", cams: AREAS.alta.cams, source: AREAS.alta.camSource,
    about: "used with permission, highest on the mountain first" },
  // Each resort's snow stake cam, from the address its own website uses. Solitude's is a YouTube
  // live stream, so its picture is the stream's current frame; if Solitude restarts the stream
  // under a new video id, the id here needs updating.
  // Each cam's `credit` is the resort named under its picture.
  { key: "stakes", name: "Snowstakes", source: [AREAS.alta.camSource, SNOWBIRD_SOURCE, SOLITUDE_SOURCE, SNOWBASIN_SOURCE], cams: [
    { name: "Alta", note: "Collins study plot · board cleared daily at 4am and 4pm, conditions permitting",
      src: "https://alta-webcams.sfo3.cdn.digitaloceanspaces.com/Collins_Snow_Stake.jpg", credit: AREAS.alta.camSource },
    { name: "Snowbird", src: "https://img.hdrelay.com/frames/8611e276-7ee5-42c0-b8cd-d9e1890e1cd4/default/last.jpg",
      credit: SNOWBIRD_SOURCE },
    { name: "Solitude", note: "Top of the mountain · unofficial snowfall",
      src: "https://i.ytimg.com/vi/lkEM6EC8NVA/maxresdefault_live.jpg", credit: SOLITUDE_SOURCE },
    // HDRelay camera id from Snowbasin's player settings (manage.hdrelay.com/player/f9e1b19a-...)
    { name: "Snowbasin", note: "8,000 ft · 24-hour board, cleared about 4pm daily",
      src: "https://img.hdrelay.com/frames/09f922af-169d-4949-9bb7-295c6a859daa/default/last.jpg", credit: SNOWBASIN_SOURCE },
  ] },
  { key: "lcc", name: "Little Cottonwood", cams: [
    { view: 165271, name: "Alta", where: "SR-210 · mile 12.16" },
    { view: 165175, name: "Alta Bypass", where: "SR-210 · mile 10.95" },
    { view: 165174, name: "Upper White Pine", where: "SR-210 · mile 9.7" },
    { view: 165998, name: "White Pine parking", where: "SR-210 · mile 9.2" },
    { view: 166033, name: "Seven Turns", where: "SR-210 · mile 7.4" },
    { view: 164767, name: "Upper Vault", where: "SR-210 · mile 5.96" },
    { view: 164559, name: "Canyon mouth", where: "SR-210 at SR-209" },
  ] },
  { key: "bcc", name: "Big Cottonwood", cams: [
    { view: 165825, name: "Brighton", where: "SR-190 · mile 16.07" },
    { view: 165123, name: "Solitude", where: "SR-190 · mile 14.53" },
    { view: 164818, name: "Silver Fork", where: "SR-190 · mile 12.54" },
    { view: 165945, name: "Cardiff Fork", where: "SR-190 · mile 10.74" },
    { view: 164788, name: "S-Curves", where: "SR-190 · mile 6.38" },
    { view: 164416, name: "Dogwood", where: "SR-190 · mile 4.1" },
    { view: 164333, name: "Canyon mouth", where: "Wasatch Blvd at Fort Union Blvd" },
  ] },
  { key: "below", name: "Below the Canyons", cams: [
    { view: 165939, name: "9800 S at Wasatch Blvd", where: "SR-209 · 3400 E" },
    { view: 164567, name: "Old Wasatch Blvd", where: "SR-209 at 9710 S" },
    { view: 164812, name: "9400 S at 2300 E", where: "SR-209 · Quail Hollow Dr" },
  ] },
];
// The canyon tab that opens first: the one the resort being viewed is up
let cameraGroup = AREA_KEY === "solitude" ? "bcc" : "lcc";
let cameraTimer = null;

// Shows or hides the cameras. While shown, the pictures reload every minute.
function showCameras(on) {
  clearInterval(cameraTimer);
  cameraTimer = null;
  if (!on) return;
  drawCameras();
  cameraTimer = setInterval(() => {
    if (document.hidden) return; // nothing to refresh while the page is out of sight
    const stamp = Date.now();
    document.querySelectorAll("#camera-grid img").forEach(img => { img.src = camUrl(img.dataset.src, stamp); });
  }, 60000);
}

function drawCameras() {
  const tabs = document.getElementById("camera-tabs");
  tabs.innerHTML = CAMERA_GROUPS.map(g => `<button type="button" class="tab${g.key === cameraGroup ? " active" : ""}"
    data-group="${g.key}" aria-pressed="${g.key === cameraGroup}">${g.name}</button>`).join("");
  tabs.onclick = e => {
    const btn = e.target.closest("[data-group]");
    if (!btn) return;
    cameraGroup = btn.dataset.group;
    drawCameras();
  };
  const group = CAMERA_GROUPS.find(g => g.key === cameraGroup);
  const stamp = Date.now();
  const sources = [].concat(group.source ?? UDOT_SOURCE);
  document.getElementById("camera-grid").innerHTML = group.cams.map(c => {
    const src = c.src ?? `https://www.udottraffic.utah.gov/map/Cctv/${c.view}`;
    const where = c.where ?? c.note;
    // A resort cam names its resort under the picture; a group with one source credits it for every cam
    const credit = c.credit ?? (group.source && !Array.isArray(group.source) ? group.source : null);
    return `<figure class="camera">
      <a href="${src}" target="_blank" rel="noopener"><img src="${camUrl(src, stamp)}" data-src="${src}" alt="${credit ? credit.name : "UDOT"} camera: ${c.name}" loading="lazy"></a>
      <figcaption>${c.name}${where ? `<span class="muted">${where}</span>` : ""}${camCredit(credit)}</figcaption>
    </figure>`;
  }).join("");
  document.getElementById("camera-source").innerHTML = "Images: " +
    sources.map(s => `<a href="${s.url}">${s.name}</a>`).join(", ") +
    (group.about ? `, ${group.about}` : "") + "; refreshed every minute while this page is open";
}

// ---------- Cams tab (resorts with AREA.cams) ----------
// The resort's own mountain cams, in the order AREA.cams lists them. While shown, the pictures
// reload every five minutes; the resort's cameras update less often than UDOT's.
let mountainCamTimer = null;
const camUrl = (src, stamp) => src + (src.includes("?") ? "&" : "?") + "t=" + stamp;

function showMountainCams(on) {
  clearInterval(mountainCamTimer);
  mountainCamTimer = null;
  if (!on || !AREA.cams) return;
  drawMountainCams();
  mountainCamTimer = setInterval(() => {
    if (document.hidden) return;
    const stamp = Date.now();
    document.querySelectorAll("#mtn-cam-grid img").forEach(img => { img.src = camUrl(img.dataset.src, stamp); });
  }, 5 * 60000);
}

function drawMountainCams() {
  const stamp = Date.now();
  document.getElementById("mtn-cam-grid").innerHTML = AREA.cams.map(c => `<figure class="camera">
      <a href="${c.src}" target="_blank" rel="noopener"><img src="${camUrl(c.src, stamp)}" data-src="${c.src}" alt="${AREA.name} cam: ${c.name}" loading="lazy"></a>
      <figcaption>${c.name}${c.note ? `<span class="muted">${c.note}</span>` : ""}${camCredit(c.credit ?? AREA.camSource)}</figcaption>
    </figure>`).join("");
  const s = AREA.camSource;
  document.getElementById("mtn-cam-source").innerHTML =
    `Images: <a href="${s.url}">${s.name}</a>, used with permission, highest on the mountain first, refreshed every five minutes while this page is open`;
}

// ---------- Map (in the Locations menu) ----------
// USGS hybrid map: satellite imagery with topo lines and names (Leaflet, from index.html), with
// USGS contour lines over it; plain imagery, a topo map and turning the contours off are in its
// switcher. Clicking a spot opens a small window with the
// Snow Summary for exactly that spot; clicking elsewhere on the map closes it, and clicking the
// window opens the full forecast for the spot (the ?lat=&lon=&ft= page, see POINT). The map
// remembers where it was left, in this browser only.
const MAP_VIEW_KEY = "wasatch-map-view-v2"; // v2: the default map changed to Topo, so earlier saved choices are dropped once
let map = null;
let mapPopupSeq = 0; // each window's chart gets its own id, so a new one never reuses an old one's

function showMap(on) {
  if (!on) { map?.closePopup(); return; }
  if (map) { map.invalidateSize(); return; } // it cannot measure itself while its tab is hidden
  let view = { lat: 40.595, lon: -111.62, zoom: 12 }; // the Cottonwoods
  try { Object.assign(view, JSON.parse(localStorage.getItem(MAP_VIEW_KEY)) || {}); } catch { /* first visit */ }
  // Popups are closed by hand below, so a click that closes one does not open another
  map = L.map("map", { closePopupOnClick: false }).setView([view.lat, view.lon], view.zoom);
  // The National Map's base maps, picked with the switcher in the top right corner of the map.
  // Topo opens first. Hybrid is the imagery with roads, trails, place names and contour lines drawn over it. All
  // have detail down to zoom 16; one level more just enlarges it.
  const usgs = (service, credit) => L.tileLayer(`https://basemap.nationalmap.gov/arcgis/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`, {
    maxNativeZoom: 16, maxZoom: 17,
    attribution: `${credit}: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noopener">USGS The National Map</a>`,
  });
  const bases = {
    Hybrid: usgs("USGSImageryTopo", "Imagery and topo"),
    Satellite: usgs("USGSImageryOnly", "Imagery"),
    Topo: usgs("USGSTopo", "Topo"),
  };
  (bases[view.base] ?? bases.Topo).addTo(map);
  // Contour lines drawn over whichever map is picked: the National Map's contours (40-foot steps
  // with height labels close in, 50 and 100 feet further out), on a clear background. The
  // service has no ready-made tiles, so each square is drawn on request, which can take a few seconds.
  const contours = new (L.TileLayer.extend({
    getTileUrl(c) {
      const size = 40075016.68557849 / 2 ** c.z, edge = 20037508.342789244; // Web Mercator metres
      const xmin = -edge + c.x * size, ymax = edge - c.y * size;
      return "https://carto.nationalmap.gov/arcgis/rest/services/contours/MapServer/export?" + new URLSearchParams({
        bbox: [xmin, ymax - size, xmin + size, ymax].join(","), bboxSR: 3857, imageSR: 3857,
        size: "256,256", format: "png32", transparent: true, f: "image",
      });
    },
  }))("", { minZoom: 10, maxZoom: 17, opacity: 0.3, attribution: "Contours: USGS 3DEP" }); // faint, so the imagery shows through
  const overlays = { "Contour lines": contours };
  if (view.contours !== false) contours.addTo(map);
  L.control.layers(bases, overlays, { position: "topright" }).addTo(map);
  let base = bases[view.base] ? view.base : "Topo";
  const save = () => {
    const c = map.getCenter();
    try {
      localStorage.setItem(MAP_VIEW_KEY, JSON.stringify({ lat: c.lat, lon: c.lng, zoom: map.getZoom(), base, contours: map.hasLayer(contours) }));
    } catch { /* not saved */ }
  };
  map.on("moveend", save);
  map.on("baselayerchange", e => { base = e.name; save(); });
  map.on("overlayadd overlayremove", save);
  let popupOpen = false;
  map.on("popupopen", () => { popupOpen = true; });
  map.on("popupclose", e => {
    popupOpen = false;
    const id = `chart-${e.popup.chartId}`;
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  });
  map.on("click", e => {
    if (popupOpen) { map.closePopup(); return; }
    openSpotForecast(e.latlng.wrap());
  });
}

// The small window for one spot: its position and height, then its Snow Summary
async function openSpotForecast(latlng) {
  const id = `mapspot-${++mapPopupSeq}`;
  const lat = Number(latlng.lat.toFixed(4)), lon = Number(latlng.lng.toFixed(4));
  const width = Math.min(560, map.getSize().x - 70);
  const box = document.createElement("div");
  box.className = "map-spot";
  box.style.width = `${width}px`;
  box.innerHTML = `<div class="map-spot-head"><b>📍 ${lat.toFixed(4)}, ${lon.toFixed(4)}</b> <span class="muted small"></span></div>
    <div id="${id}-scroll" class="summary-scroll" tabindex="0" aria-label="Snow summary for this spot, scrolls sideways">
      <div id="${id}-inner" class="chart-wrap summary"><canvas id="chart-${id}"></canvas></div>
    </div>
    <p class="muted small map-spot-note">Loading the snow forecast for this spot…</p>`;
  const popup = L.popup({ minWidth: width, maxWidth: width, autoPanPadding: [16, 16], className: "map-popup" })
    .setLatLng(latlng).setContent(box);
  popup.chartId = id;
  popup.openOn(map);
  const note = box.querySelector(".map-spot-note");
  try {
    const ft = await pointElevationFt(lat, lon);
    box.querySelector(".map-spot-head .muted").textContent = `${Math.round(ft).toLocaleString()} ft`;
    // The same three downloads Forecast Summaries makes for a resort, for this one spot
    const loc = pointLoc(lat, lon, ft);
    const [[fc], md, hist] = await Promise.all([
      getForecast([loc], true),
      apiJson(modelsUrl([loc]), { cache: "no-store" }).then(d => [].concat(d)).catch(() => null), // GFS alone if it fails
      apiJson(historyUrl(loc), { cache: "no-store" }).then(h => hourRows(h.hourly)).catch(() => []),
    ]);
    if (!map.hasLayer(popup)) return; // closed while it loaded
    const rows = processForecast(fc);
    const series = modelSeries(rows, 0, md);
    summaryChart({ id, rows, history: hist, series });
    const ahead = averageSnow(rows, series).snow.reduce((a, v) => a + (v || 0), 0);
    note.innerHTML = `Next 16 days: <b class="snow-total">${r1(ahead)}"</b> · click here for the full forecast at this spot`;
    // No popup.update() here: it takes the window's contents out and puts them back, which resets
    // the chart's sideways scroll to four months ago. The window's width is fixed, so none is needed.
    // Clicking the window opens the full forecast; dragging the chart sideways does not count
    let scrolled = false;
    box.querySelector(".summary-scroll").addEventListener("scroll", () => { scrolled = true; });
    box.addEventListener("pointerdown", () => { scrolled = false; });
    box.addEventListener("click", () => {
      if (!scrolled) location.href = `?lat=${lat}&lon=${lon}&ft=${Math.round(ft)}`;
    });
    box.classList.add("ready");
  } catch (err) {
    console.warn("Spot forecast unavailable", err);
    note.textContent = "Couldn't load the forecast for this spot right now.";
  }
}

// ---------- Machine Learning tab (Alta only) ----------
// A self-correcting snow forecast for Mid Collins, built step by step. Each morning
// ml_forecast/run.py (see ml_forecast/README.md) measures each model's usual mistake at Collins,
// lead day by lead day, and writes data/ml-forecast.json: today's corrections, and a walk-forward
// test of every step over past winters. This tab applies those corrections to the live models the
// Forecast tab already loads, with each model's snow water capped at its precipitation (see drawMlUpcoming).
//   Step 0a  the plain average of GFS + HRRR, NBM and NAM; Step 0b  the NBM alone
//   Step 1   each model's precipitation times its correction for that lead day, then averaged
// Days 8–11 of Step 1 are the uncorrected average; Days 12–16 the GFS ensemble (ML_ENSEMBLES), marked "outlook".
const ML_STEPS = {
  "0a": { name: "Plain average", line: "#c9d4e2" },
  "0b": { name: "NBM alone", line: "#ffd166" },
  "1": { name: "Corrected average", line: "#5fd3a3" },
};
const ML_MODEL_KEYS = { gfs_seamless: "gfs", ncep_nbm_conus: "nbm", ncep_nam_conus: "nam" };
const ML_GHOST = "rgba(201, 212, 226, 0.22)"; // Step 0a drawn faintly behind the other steps
let mlData = null;  // data/ml-forecast.json once loaded
let mlPrecip = null; // each model's hourly precipitation: Map(model id -> Map(time -> inches))
let mlLead = 1;     // lead day shown in the track records

// Days 12–16 of the corrected Snow Summary: the GFS ensemble's outlook. Days 8–11 stay the average
// of the models (uncorrected; the NBM ends about Day 10, leaving the GFS). The ensemble's snow water
// is the mean of its 31 runs, each capped at its own precipitation like the models above; snow uses
// the same Kuchera ratio. Not bias-corrected: there is no history of past ensemble forecasts to
// measure it against yet (ml_forecast/outlook.py saves them each day so they can be scored later).
const ML_OUTLOOK_FROM = 12;
const ML_ENSEMBLES = [
  { api: "gfs_seamless", ending: "ncep_gefs_seamless", name: "GFS ensemble", weight: 1 },
];
const ML_OUTLOOK_COLOR = "#b39dff"; // the outline on the outlook's bars, so they never pass for corrected days
let mlEnsemble = null; // Map(ending -> Map(time -> mean snow water of its runs))

async function loadMlEnsemble() {
  const j = await apiJson(track(["machine-learning"], "https://ensemble-api.open-meteo.com/v1/ensemble?" + new URLSearchParams({
    ...pointParams([locations[0]]), hourly: "precipitation,snowfall", models: ML_ENSEMBLES.map(e => e.api).join(","),
    forecast_days: 16, precipitation_unit: "inch",
  })), { cache: "no-store" });
  const h = j.hourly;
  mlEnsemble = new Map(ML_ENSEMBLES.map(e => {
    const runs = Object.keys(h).filter(k => k.startsWith("precipitation_") && k.endsWith(e.ending));
    const mean = new Map();
    h.time.forEach((t, i) => {
      const w = runs.map(k => {
        const p = h[k][i], s = h[k.replace("precipitation_", "snowfall_")]?.[i];
        return p == null || s == null ? null : Math.min(s / 7, p);
      }).filter(v => v != null);
      if (w.length) mean.set(t, w.reduce((a, b) => a + b, 0) / w.length);
    });
    return [e.ending, mean];
  }));
}

// Each model's own precipitation, which caps its snow water (see drawMlUpcoming). Fetched here,
// not added to the Forecast tab's download, so that tab is unchanged.
async function loadMlPrecip() {
  const ids = Object.keys(ML_MODEL_KEYS);
  const j = await apiJson(track(["machine-learning"], "https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
    ...pointParams([locations[0]]), hourly: "precipitation", models: ids.join(","), forecast_days: 16, precipitation_unit: "inch",
  })), { cache: "no-store" });
  mlPrecip = new Map(ids.map(id => [id, new Map(j.hourly.time.map((t, i) => [t, j.hourly[`precipitation_${id}`]?.[i]]))]));
}

const mlShowing = () => !document.getElementById("view-machine-learning").hidden;
const mlDayName = lead => (lead === 0 ? "Day 0 (today)" : lead === 1 ? "Day 1 (tomorrow)" : `Day ${lead}`);

async function showMachineLearning() {
  const status = document.getElementById("ml-status");
  if (!mlData) {
    try {
      mlData = await apiJson(track(["machine-learning"], "data/ml-forecast.json"), { cache: "no-store" });
    } catch {
      status.textContent = "The daily Machine Learning job has not written its results yet (data/ml-forecast.json).";
      return;
    }
  }
  drawMachineLearning();
}

let mlPrecipLoading = null, mlEnsembleLoading = null;
function drawMachineLearning() {
  if (!mlData) return;
  // The page's forecast point is known once main() has read locations.json; this draws again when it arrives
  if (!mlPrecip && !mlPrecipLoading && locations.length) {
    mlPrecipLoading = loadMlPrecip().then(drawMachineLearning)
      .catch(err => console.warn("Model precipitation unavailable", err)).finally(() => { mlPrecipLoading = null; });
  }
  if (!mlEnsemble && !mlEnsembleLoading && locations.length) {
    mlEnsembleLoading = loadMlEnsemble().then(drawMachineLearning)
      .catch(err => console.warn("Ensembles unavailable", err)).finally(() => { mlEnsembleLoading = null; });
  }
  const status = document.getElementById("ml-status");
  const updated = new Date(mlData.updated).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  status.textContent = `Last updated ${updated}.` + (modelData && mlPrecip ? "" : " Waiting for the models to load…");
  drawMlLeads();
  if (allRows.length && modelData && mlPrecip) drawMlUpcoming();
  drawMlTracks();
  drawMlCorrections();
  drawMlCompare();
  drawMlNotes();
}

// Today's precipitation factor for one model at one lead day, or null when it is uncorrected
function mlFactor(key, lead) {
  const c = mlData.corrections[key]?.[lead]?.precip;
  return c?.status === "ok" ? c.value : null;
}

// Upcoming: today and the next fifteen days, for each step, from the live models
function drawMlUpcoming() {
  const rows = allRows;
  const today = rows[0].time.slice(0, 10);
  const leadOf = t => Math.round((new Date(t.slice(0, 10) + "T12:00") - new Date(today + "T12:00")) / 86400000);
  // The NBM's snowfall is not at 7 to 1 (its snowfall ÷ 7 has run about twice its precipitation),
  // so on this tab every model's snow water is capped at its own precipitation, snow scaled to match.
  // ml_forecast/forecasts.py does the same in the test, so every step here is on the same footing.
  const series = modelSeries(rows).map(s => {
    const p = mlPrecip.get(s.id);
    if (!p || !ML_MODEL_KEYS[s.id]) return s;
    const keep = rows.map((r, i) => { const w = s.swe[i], cap = p.get(r.time); return w > 0 && cap != null && w > cap ? cap / w : 1; });
    return { ...s, swe: s.swe.map((v, i) => (v == null ? v : v * keep[i])), snow: s.snow.map((v, i) => (v == null ? v : v * keep[i])) };
  });
  const corrected = series.map(s => {
    const key = ML_MODEL_KEYS[s.id];
    if (!key) return s;
    const f = rows.map(r => mlFactor(key, leadOf(r.time)));
    const scale = arr => arr.map((v, i) => (v == null || f[i] == null ? v : v * f[i]));
    return { ...s, snow: scale(s.snow), swe: scale(s.swe) };
  });
  const nbm = series.find(s => s.id === "ncep_nbm_conus");
  const hourly = { "0a": averageSnow(rows, series), "0b": nbm && { snow: nbm.snow, swe: nbm.swe }, "1": averageSnow(rows, corrected) };

  // Days 12–16: the ensemble outlook takes the place of Step 1 (see ML_ENSEMBLES), hour by hour
  const outlook = rows.map(r => {
    if (!mlEnsemble || leadOf(r.time) < ML_OUTLOOK_FROM) return null;
    let sum = 0, weight = 0;
    for (const e of ML_ENSEMBLES) {
      const v = mlEnsemble.get(e.ending)?.get(r.time);
      if (v != null) { sum += v * e.weight; weight += e.weight; }
    }
    return weight ? sum / weight : null;
  });
  hourly["1"] = {
    swe: hourly["1"].swe.map((v, i) => outlook[i] ?? v),
    snow: hourly["1"].snow.map((v, i) => (outlook[i] == null ? v : outlook[i] * rows[i].kuchera)),
  };

  // Day totals; for Step 1, whether every model in that day's average was corrected, or the day is the outlook
  const days = new Map();
  rows.forEach((r, i) => {
    const k = r.time.slice(0, 10);
    if (!days.has(k)) days.set(k, { lead: leadOf(r.time), models: new Set(), outlook: false,
      "0a": 0, "0b": 0, "1": 0, swe: { "0a": 0, "0b": 0, "1": 0 } });
    const d = days.get(k);
    for (const step in hourly) {
      d[step] += hourly[step]?.snow[i] || 0;
      d.swe[step] += hourly[step]?.swe[i] || 0;
    }
    if (outlook[i] != null) d.outlook = true;
    series.forEach(s => { if (ML_MODEL_KEYS[s.id] && s.swe[i] != null) d.models.add(ML_MODEL_KEYS[s.id]); });
  });
  const keys = [...days.keys()].slice(0, 16);
  const state = keys.map(k => {
    const d = days.get(k);
    if (d.outlook) return "ensemble outlook";
    const fixed = [...d.models].filter(m => mlFactor(m, d.lead) != null).length;
    return fixed === 0 ? "uncorrected" : fixed < d.models.size ? "partly corrected" : "corrected";
  });
  const stateMark = { "uncorrected": "uncorr.", "partly corrected": "partly", "ensemble outlook": "outlook" };
  const top = Math.max(1, ...keys.flatMap(k => ["0a", "0b", "1"].map(s => days.get(k)[s])));
  const yMax = Math.ceil(top * 1.25);

  // Where each day's snow comes from, as [long, short] labels for the brackets above the bars
  const NAMES = { gfs: ["GFS + HRRR", "GFS"], nbm: ["NBM", "NBM"], nam: ["NAM", "NAM"] };
  const sourceOf = (step, i) => {
    const d = days.get(keys[i]);
    const models = ["gfs", "nbm", "nam"].filter(m => d.models.has(m));
    const list = n => models.map(m => NAMES[m][n]).join(", ");
    if (step === "0b") return d.models.has("nbm") ? ["NBM alone", "NBM"] : null;
    if (step === "1" && state[i] === "ensemble outlook") return ["GFS ensemble (31 runs) · not bias-corrected", "GFS ens."];
    if (!models.length) return null;
    const kind = step === "0a" ? "Plain average" : d.lead <= 7 ? "Corrected average" : "Uncorrected average";
    const one = models.length === 1;
    const alone = step === "0a" ? `${list(0)} alone` : `${kind.split(" ")[0]} ${list(0)} alone`;
    return [one ? alone : `${kind} of ${list(0)}`,
      step === "0a" ? list(1) : `${d.lead <= 7 ? "Corr." : "Uncorr."} ${list(1)}`];
  };

  for (const step of ["0a", "0b", "1"]) {
    const vals = keys.map(k => days.get(k)[step]);
    const colour = keys.map((k, i) => {
      const d = days.get(k), ratio = d.swe[step] > 0.001 ? d[step] / d.swe[step] : null;
      const c = ratioColor(ratio ?? 12);
      if (step !== "1") return c;
      // The Snow Summary's blues throughout: a little see-through on the outlook, more where not fully corrected
      return state[i] === "ensemble outlook" ? c + "aa" : state[i] !== "corrected" ? c + "66" : c;
    });
    // The outlook days also get a thin outline in their own colour, so they never pass for corrected days
    const outlined = state.map(s => step === "1" && s === "ensemble outlook");
    const label = step === "1" ? i => (state[i] === "ensemble outlook" ? "GFS ensemble outlook" : ML_STEPS[step].name) : () => ML_STEPS[step].name;
    const datasets = [{ label: ML_STEPS[step].name, data: vals, backgroundColor: colour, order: 1, grouped: false, labelAt: label,
      borderColor: outlined.map(o => (o ? ML_OUTLOOK_COLOR : "transparent")), borderWidth: outlined.map(o => (o ? 1.5 : 0)), borderSkipped: false }];
    if (step !== "0a") datasets.push({ label: "Plain average", data: keys.map(k => days.get(k)["0a"]), backgroundColor: ML_GHOST,
      order: 2, grouped: false, barPercentage: 1, categoryPercentage: 0.95 });
    const labels = keys.map((k, i) => {
      const date = new Date(k + "T12:00");
      const lines = [i === 0 ? "Today" : date.toLocaleDateString([], { weekday: "short" }), `${date.getMonth() + 1}/${date.getDate()}`];
      if (step === "1" && state[i] !== "corrected") lines.push(stateMark[state[i]]);
      return lines;
    });
    // Runs of back-to-back days with the same source, each bracketed and named above its bars
    const sources = keys.map((_, i) => sourceOf(step, i));
    const sections = [];
    sources.forEach((s, i) => {
      const last = sections[sections.length - 1];
      if (last && s && last.labels[0] === s[0]) last.to = i;
      else if (s) sections.push({ from: i, to: i, labels: s });
    });
    // Storm totals, found the same way as on every Snow Summary (stormRuns)
    const md = k => { const d = new Date(k + "T12:00"); return `${d.getMonth() + 1}/${d.getDate()}`; };
    const storms = stormRuns(vals, 0.05, SNOW_LULL_IN).map(([from, to]) => {
      const total = r1(vals.slice(from, to + 1).reduce((a, b) => a + b, 0));
      const range = from === to ? md(keys[from]) : `${md(keys[from])}–${md(keys[to])}`;
      return { from, to, labels: [`Storm ${range}: ${total}"`, `${total}"`] };
    });
    makeChart(`chart-ml-up-${step}`, {
      type: "bar",
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 56 } }, // room for the source brackets and storm totals
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            title: items => new Date(keys[items[0].dataIndex] + "T12:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }),
            label: ctx => `${ctx.dataset.labelAt ? ctx.dataset.labelAt(ctx.dataIndex) : ctx.dataset.label}: ${r1(ctx.parsed.y)}"`,
            footer: items => {
              const i = items[0].dataIndex, from = sources[i] ? `From: ${sources[i][0]}` : "";
              return step === "1" && state[i] !== "ensemble outlook" ? [from, `Step 1 on this day: ${state[i]}`] : from;
            },
          } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, font: { size: 11 } } },
          y: { beginAtZero: true, max: yMax, position: "right", title: { display: true, text: "inches of snow" } },
        },
      },
      plugins: [valueLabels(v => r1(v), 0.05), mlBrackets("mlSources", sections, 38),
        mlBrackets("mlStorms", storms, 10, { font: "700 11px", text: "#e6edf5", line: "rgba(159, 216, 255, 0.6)" })],
    });
    const week = vals.slice(0, 7).reduce((a, b) => a + b, 0);
    const later = vals.reduce((a, v, i) => a + (state[i] === "ensemble outlook" ? v : 0), 0);
    document.getElementById(`ml-total-${step}`).textContent = `· next 7 days ${r1(week)}"` +
      (step === "1" && state.includes("ensemble outlook") ? ` · Days 12–16 GFS ensemble ${r1(later)}"` : "");
  }
}

// Brackets across the top of an upcoming chart, `rise` px above the plot: one row names where
// each run of days' snow comes from, a lower row gives each storm's total. Each bracket gets the
// longest of its labels that fits (none if even the shortest doesn't; the tooltip still says).
// `sections` are { from, to, labels: [long, short] } with from/to as bar positions.
const mlBrackets = (id, sections, rise, { font = "600 10px", text = "#c9d4e2", line = "rgba(201, 212, 226, 0.45)" } = {}) => ({
  id,
  afterDatasetsDraw(chart) {
    const { ctx: g, chartArea: area, scales: { x } } = chart;
    const half = chart.data.labels.length > 1 ? (x.getPixelForValue(1) - x.getPixelForValue(0)) / 2 : 20;
    const y = area.top - rise;
    g.save();
    g.font = `${font} ${Chart.defaults.font.family}`;
    g.textAlign = "center";
    g.textBaseline = "bottom";
    g.strokeStyle = line;
    g.lineWidth = 1;
    for (const s of sections) {
      const left = x.getPixelForValue(s.from) - half + 3, right = x.getPixelForValue(s.to) + half - 3;
      g.beginPath();
      g.moveTo(left, y + 5); g.lineTo(left, y); g.lineTo(right, y); g.lineTo(right, y + 5);
      g.stroke();
      const label = s.labels.find(t => g.measureText(t).width <= right - left);
      if (label) { g.fillStyle = text; g.fillText(label, (left + right) / 2, y - 2); }
    }
    g.restore();
  },
});

// The lead day picker above the track records
function drawMlLeads() {
  const bar = document.getElementById("ml-leads");
  bar.innerHTML = mlData.leads.map(l => `<button type="button" class="range-btn${l === mlLead ? " active" : ""}" ` +
    `data-lead="${l}" aria-pressed="${l === mlLead}">${l === 0 ? "the same day" : l === 1 ? "1 day ahead" : `${l} days ahead`}</button>`).join("");
  bar.onclick = e => {
    const btn = e.target.closest("[data-lead]");
    if (!btn) return;
    mlLead = Number(btn.dataset.lead);
    drawMlLeads();
    drawMlTracks();
  };
}

// Track record: each step's forecast against the snow measured on the Collins board, over the
// most recent winter the test covers, at the chosen lead day. All three share one scale.
function drawMlTracks() {
  const t = mlData.track;
  const lead = t.leads?.[mlLead];
  if (!lead) return;
  const n = t.dates.length;
  const ok = i => t.observed[i] != null && ["0a", "0b", "1"].every(s => lead[s][i] != null); // the days every step is scored on
  const top = Math.max(1, ...t.observed.filter(v => v != null), ...["0a", "0b", "1"].flatMap(s => lead[s].filter(v => v != null)));
  const mae = s => {
    const idx = [...Array(n).keys()].filter(ok);
    return idx.length ? idx.reduce((a, i) => a + Math.abs(lead[s][i] - t.observed[i]), 0) / idx.length : null;
  };
  const base = mae("0a");
  for (const step of ["0a", "0b", "1"]) {
    const scroller = document.getElementById(`ml-track-${step}-scroll`);
    if (scroller.clientWidth) document.getElementById(`ml-track-${step}-inner`).style.width = `${Math.max(scroller.clientWidth, n * 6)}px`;
    makeChart(`chart-ml-track-${step}`, {
      type: "bar",
      data: {
        labels: t.dates,
        datasets: [
          { type: "line", label: `${ML_STEPS[step].name}, forecast ${mlLead} day${mlLead === 1 ? "" : "s"} ahead`, data: lead[step],
            borderColor: ML_STEPS[step].line, backgroundColor: ML_STEPS[step].line, borderWidth: 1.5, pointRadius: 0, spanGaps: false, order: 1 },
          { label: "Measured at Mid Collins", data: t.observed, backgroundColor: "#8b9bb0", order: 2, barPercentage: 1, categoryPercentage: 0.9 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "top", align: "start", labels: { boxWidth: 12 } },
          tooltip: { callbacks: {
            title: items => new Date(t.dates[items[0].dataIndex] + "T12:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
            label: ctx => `${ctx.dataset.label}: ${r1(ctx.parsed.y)}"`,
          } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 0, font: { size: 11 },
            callback(v) { const d = t.dates[v]; return d?.endsWith("-01") ? new Date(d + "T12:00").toLocaleDateString([], { month: "short" }) : ""; } } },
          y: { beginAtZero: true, max: Math.ceil(top * 1.1), position: "right", title: { display: true, text: "inches of snow" } },
        },
      },
    });
    const m = mae(step);
    const days = [...Array(n).keys()].filter(ok);
    const total = arr => days.reduce((a, i) => a + arr[i], 0);
    const skill = step === "0a" || !base ? "the yardstick for the other steps" : `skill ${m <= base ? "+" : ""}${Math.round((1 - m / base) * 100)}% against the plain average`;
    document.getElementById(`ml-score-${step}`).textContent = days.length
      ? `Winter ${t.winter}, forecasts made ${mlLead === 0 ? "the same day" : `${mlLead} day${mlLead === 1 ? "" : "s"} ahead`}, ${days.length} days: ` +
        `average miss (MAE) ${r2(m)}" a day, ${skill}. Winter total ${r0(total(lead[step]))}" forecast, ${r0(total(t.observed))}" measured.`
      : "No days to score at this lead day yet.";
  }
}

// Today's corrections, in words
function drawMlCorrections() {
  const table = document.getElementById("ml-corrections");
  const flag = text => `<span class="ml-flag">Not corrected</span> <span class="muted">${text}</span>`;
  const why = (c, unit) => (c.status === "no_history" ? "no forecast history at this lead day"
    : `only ${c.n} ${unit} of the ${c.needs} it needs`);
  const ratioWords = (c, more, less, unit) => {
    if (c.status !== "ok") return flag(why(c, unit));
    const f = c.value;
    const limit = f <= mlData.settings.RATIO_CLIP[0] || f >= mlData.settings.RATIO_CLIP[1] ? " (the limit)" : "";
    if (Math.abs(f - 1) < 0.03) return `about right → leaving it (×${f.toFixed(2)})`;
    const pct = f > 1 ? Math.round((1 - 1 / f) * 100) : Math.round((1 / f - 1) * 100);
    return `forecasting ${pct}% ${f > 1 ? less : more} → multiplying by ${f.toFixed(2)}${limit}`;
  };
  const tempWords = c => {
    if (c.status !== "ok") return flag(why(c, "days"));
    const v = c.value;
    if (Math.abs(v) < 0.3) return `about right → leaving it (${v >= 0 ? "+" : ""}${v.toFixed(1)} °F)`;
    return `${Math.abs(v).toFixed(1)} °F too ${v > 0 ? "cold" : "warm"} → ${v > 0 ? "adding" : "subtracting"} ${Math.abs(v).toFixed(1)} °F`;
  };
  table.querySelector("thead").innerHTML = "<tr><th>Model</th><th>Lead day</th><th>Precipitation (snow)</th><th>Temperature</th><th>Wind</th></tr>";
  const rows = [];
  for (const [key, model] of Object.entries(mlData.models)) {
    // The NAM's live forecast reaches Day 2, so it is listed to there; the others to Day 7
    const shown = mlData.leads.filter(l => key !== "nam" || l <= 2);
    shown.forEach(l => {
      const e = mlData.corrections[key][l];
      rows.push(`<tr><td>${model.name}</td><td>${mlDayName(l)}</td>
        <td>${ratioWords(e.precip, "too much precipitation", "too little precipitation", "wet days")}</td>
        <td>${tempWords(e.temp)}</td>
        <td>${ratioWords(e.wind, "too much wind", "too little wind", "days")}</td></tr>`);
    });
  }
  table.querySelector("tbody").innerHTML = rows.join("");
}

// The walk-forward test, lead day by lead day, the smallest snow miss highlighted
function drawMlCompare() {
  const table = document.getElementById("ml-compare");
  const pct = v => (v == null ? "–" : `${v >= 0 ? "+" : ""}${Math.round(v * 100)}%`);
  const hmf = s => `${s.hits} / ${s.misses} / ${s.false_alarms}`;
  table.querySelector("thead").innerHTML = `<tr><th rowspan="2">Lead day</th><th rowspan="2">Days</th>
    <th colspan="3">Snow MAE (inches a day)</th><th colspan="2">Skill</th><th colspan="3">1" days: hits / misses / false alarms</th>
    <th colspan="2">Temperature MAE (°F)</th><th colspan="2">Wind MAE (mph)</th></tr>
    <tr><th>Plain avg</th><th>NBM</th><th>Corrected</th><th>NBM</th><th>Corrected</th><th>Plain avg</th><th>NBM</th><th>Corrected</th>
    <th>Plain avg</th><th>Corrected</th><th>Plain avg</th><th>Corrected</th></tr>`;
  table.querySelector("tbody").innerHTML = mlData.leads.map(l => {
    const m = mlData.metrics[l];
    const s = m.snow;
    if (!s["0a"].days) return `<tr><td>${mlDayName(l)}</td><td>0</td><td colspan="12" class="muted">No days to score yet</td></tr>`;
    const best = Math.min(s["0a"].mae, s["0b"].mae, s["1"].mae);
    const cell = k => `<td${s[k].mae === best ? ' class="ml-best"' : ""}>${r2(s[k].mae)}</td>`;
    const num = v => (v == null ? "–" : r2(v));
    return `<tr><td>${mlDayName(l)}</td><td>${s["0a"].days}</td>${cell("0a")}${cell("0b")}${cell("1")}
      <td>${pct(s["0b"].skill)}</td><td>${pct(s["1"].skill)}</td>
      <td>${hmf(s["0a"])}</td><td>${hmf(s["0b"])}</td><td>${hmf(s["1"])}</td>
      <td>${num(m.temp["0a"].mae)}</td><td>${num(m.temp["1"].mae)}</td><td>${num(m.wind["0a"].mae)}</td><td>${num(m.wind["1"].mae)}</td></tr>`;
  }).join("");
  const seasons = mlData.metrics[1]?.seasons ?? {};
  document.getElementById("ml-compare-note").textContent = "Season totals, Day 1 forecasts on the scored days: " +
    Object.entries(seasons).map(([w, s]) => `${w}: measured ${r0(s.observed)}", plain average ${r0(s["0a"])}", NBM ${r0(s["0b"])}", corrected ${r0(s["1"])}" (${s.days} days)`).join(" · ") +
    `. Highlighted: the smallest snow miss for that lead day. Temperature and wind are scored only where Collins measured them (wind from ${mlData.data_used.station.wind_first ?? "–"}).`;
}

// "Data used" and "How it works", from the settings the job ran with
function drawMlNotes() {
  const u = mlData.data_used, st = mlData.settings;
  const models = Object.entries(mlData.models).map(([key, m]) => {
    const leads = u.models[key] ?? {};
    const d1 = leads[1] ?? leads[0];
    if (!d1) return `<li><b>${m.name}</b>: no overlap with the station yet.</li>`;
    const days = Object.entries(leads).map(([l, v]) => `Day ${l} ${v.winter_days}`).join(", ");
    return `<li><b>${m.name}</b> (<code>${m.api}</code>): forecasts from ${d1.first} to ${d1.last}. Winter days with both a forecast and a measurement: ${days}.` +
      (key === "nam" ? " Open-Meteo's archive keeps the NAM for Day 0 and Day 1 only, and is missing about 6 days of every 2 weeks." : "") + "</li>";
  }).join("");
  document.getElementById("ml-data-used").innerHTML = `<ul>
    <li><b>Measured:</b> the Alta – Collins station (CLN, 9,662 ft), hourly, ${u.station.first} to ${u.station.last}: the liquid gauge, the new-snow board, temperature, and wind (from ${u.station.wind_first ?? "–"}).
      Two years of it are a CSV download from the Synoptic Data Viewer; newer hours come from the site's hourly station job.</li>
    ${models}
    <li><b>Only real overlap is used:</b> a model counts on the days it has a forecast and Collins has a measurement. Nothing missing is filled in.</li>
  </ul>`;
  document.getElementById("ml-how").innerHTML = `
    <li><b>Snow water capped at precipitation:</b> the NBM's snowfall from Open-Meteo is not at the 7 to 1 the site assumes. Over the last two winters its snowfall ÷ 7 came to about twice its own precipitation. So on this tab, for every step, a model's snow water is never more than its precipitation. That alone made the plain average's miss about a third smaller in the test. The Forecast tab does not do this yet, so its NBM, and with it its average, can run higher than Step 0 here.</li>
    <li><b>Days</b> run midnight to midnight Mountain time, the same as the Snow Summary bars. "Day 1" is a forecast made the day before; "Day 0" is the same day.</li>
    <li><b>Precipitation:</b> for each model and lead day, the water Collins's gauge caught on the last ${st.PRECIP_WET_DAYS} wet days (at least ${st.WET_DAY_IN}" measured or forecast, within ${st.PRECIP_LOOKBACK_DAYS} days), divided by what the model forecast for them. The model's snow water is multiplied by that, held between ×${st.RATIO_CLIP[0]} and ×${st.RATIO_CLIP[1]}, then turned into snow with the Forecast tab's Kuchera ratio. Fewer than ${st.MIN_WET_DAYS} wet days: left uncorrected.</li>
    <li><b>Temperature:</b> the model's average error over the last ${st.TEMP_WINDOW_DAYS} days is added. <b>Wind:</b> scaled by measured ÷ forecast over the last ${st.WIND_WINDOW_DAYS} days. Each needs at least ${st.MIN_DAYS} days.</li>
    <li><b>Measured snow</b> is the new snow on the Collins board, counted as on the Forecast tab, with sensor spikes (a jump of 6" or more that falls back within 3 hours) skipped.</li>
    <li><b>Fair test:</b> every past winter day (November–April) is forecast using only what was known when the forecast was made, and every step is scored on the same days. Past runs keep no upper-air temperatures, so in the test snow comes from the 2 m temperature's Kuchera ratio, the same for every step.</li>
    <li><b>Where a model has no correction</b> in Days 0–7, its own forecast is used, and the day is marked under the Step 1 chart.</li>
    <li><b>Days 8–11</b> of the Step 1 chart are the average of the models, uncorrected (the NBM ends about Day 10, leaving the GFS). <b>Days 12–16</b> are the GFS ensemble's outlook: the average of its 31 runs. There is no history of past ensemble forecasts to correct it with, so the job now saves it (and the ECMWF ensemble) every day; after a winter they can be scored and corrected like Days 0–7.</li>`;
}

// ---------- Forecast Summaries (in the Locations menu) ----------
// Every resort's Snow Summary on one page, the resort with the most forecast snow over the next
// 16 days first. Each needs its own GFS forecast, model comparison and model record for its main
// forecast point: the same three downloads its own page makes, for that one point.
let mountainsShown = false;
let mountainUrls = []; // the downloads behind it, for the refresh button
async function renderMountainForecasts() {
  const holder = document.getElementById("mountain-forecasts");
  if (!holder || mountainsShown) return;
  mountainsShown = true;
  holder.innerHTML = '<p class="muted">Loading every resort…</p>';
  const allLocs = await fetch("locations.json").then(r => r.json());
  mountainUrls = [];
  const results = await Promise.all(Object.entries(AREAS).map(async ([key, area]) => {
    const loc = allLocs.find(l => l.area === area.name);
    try {
      const [[fc], md, hist] = await Promise.all([
        getForecast([loc], true),
        apiJson(modelsUrl([loc]), { cache: "no-store" }).then(d => [].concat(d)).catch(() => null), // GFS alone if it fails
        apiJson(historyUrl(loc), { cache: "no-store" }).then(h => hourRows(h.hourly)).catch(() => []),
      ]);
      mountainUrls.push(...[modelsUrl([loc]), historyUrl(loc)].map(u => new URL(u).href));
      const rows = processForecast(fc);
      const series = modelSeries(rows, 0, md);
      const ahead = averageSnow(rows, series).snow.reduce((a, v) => a + (v || 0), 0);
      return { key, area, loc, rows, series, hist, ahead };
    } catch (err) {
      console.warn(`Mountain forecast unavailable for ${area.name}`, err);
      return { key, area, failed: true, ahead: -1 };
    }
  }));
  results.sort((a, b) => b.ahead - a.ahead);
  // Each resort's card holds the same chart elements as the Snow Summary, with its own ids
  holder.innerHTML = results.map(r => `<section class="card mtn-card" data-href="?area=${r.key}">
      <div class="storm-head"><h3><a href="?area=${r.key}">${r.area.name}</a></h3>
        <span class="muted small">${r.failed ? "" : `${r.loc.name} · ${r.loc.elevation_ft.toLocaleString()} ft · next 16 days: <b class="snow-total">${r1(r.ahead)}"</b>`}</span></div>
      ${r.failed ? '<p class="muted small">No forecast right now.</p>' : `
      <div id="mtn-${r.key}-scroll" class="summary-scroll" tabindex="0" aria-label="${r.area.name} snow summary, scrolls sideways">
        <div id="mtn-${r.key}-inner" class="chart-wrap summary"><canvas id="chart-mtn-${r.key}"></canvas></div>
      </div>`}
    </section>`).join("") +
    // One key for all of them, copied from the Snow Summary's own
    (document.querySelector("#summary-scroll")?.closest(".card")?.querySelector(".line-key")?.outerHTML ?? "") +
    `<p class="source">Models: forecast is the average of ${SNOW_MODELS} · already fallen is the GFS + HRRR record</p>`;
  // Like Storm Results, clicking anywhere on a resort's card opens its forecast. (The name at the
  // top is also a real link, for the keyboard.) Dragging the chart sideways does not count.
  holder.querySelectorAll(".mtn-card").forEach(card => {
    let scrolled = false;
    card.querySelector(".summary-scroll")?.addEventListener("scroll", () => { scrolled = true; });
    card.addEventListener("pointerdown", () => { scrolled = false; });
    card.addEventListener("click", e => {
      if (scrolled || e.target.closest("a")) return;
      location.href = card.dataset.href;
    });
  });
  results.filter(r => !r.failed).forEach(r => {
    dailyScrolled.delete(`mtn-${r.key}`); // a fresh chart opens on today again
    dailyLeft.delete(`mtn-${r.key}`);
    summaryChart({ id: `mtn-${r.key}`, rows: r.rows, history: r.hist, series: r.series });
  });
}

// The storm a snow box reports, from day-by-day model snow (Map of "YYYY-MM-DD" -> inches): the
// storm (as the Snow Summary finds them, see stormRuns) that includes `today`, or else the last
// one before it. Null if there is none.
function latestStorm(daily, today) {
  const days = [...daily.keys()].sort();
  let storm = null;
  for (const [from, to] of stormRuns(days.map(d => daily.get(d)), 0.05, SNOW_LULL_IN)) {
    if (days[from] <= today) storm = { from: days[from], to: days[to] };
  }
  return storm;
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
      // Datasets marked `isRain` (rain on the snow summary) are totalled apart from the rest and
      // get their own green label, one line below the main one
      const add = rain => chart.data.datasets.reduce((a, d, di) =>
        a + (chart.isDatasetVisible(di) && !!d.isRain === rain ? d.data[i] || 0 : 0), 0);
      const total = add(false), rain = add(true);
      const showTotal = total >= min, showRain = rain >= 0.01;
      if (!showTotal && !showRain) return;
      const bar = chart.getDatasetMeta(0).data[i];
      const y = chart.scales.y.getPixelForValue(total + rain) - 3;
      // The main total on top, with the rain under it, nearest the bar
      if (showTotal) g.fillText(`${fmt(total)}"`, bar.x, y - (showRain ? 13 : 0));
      if (showRain) {
        g.fillStyle = PRECIP_COLORS.rain;
        g.fillText(`${r2(rain)}"`, bar.x, y);
        g.fillStyle = "#e6edf5";
      }
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
// positions; `split` is the "already fallen" line for a storm that is under way.
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
        let mid = seenRight > seenLeft ? (seenLeft + seenRight) / 2 : (left + right) / 2;
        // Bracket: a line over the bars with a short tick down at each end
        g.strokeStyle = "rgba(139, 155, 176, 0.7)";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(left, y + 5); g.lineTo(left, y); g.lineTo(right, y); g.lineTo(right, y + 5);
        g.stroke();
        g.textBaseline = "bottom";

        // Work out every line's text and width first, so the block can be kept in view
        const big = "600 15px " + family, small = "600 10.5px " + family, splitFont = "600 11.5px " + family;
        const total = `${fmt(s.value)}"`;
        g.font = big;
        const totalWidth = g.measureText(total).width;
        // The total, with the storm's snow water (SWE) small and in a darker blue beside it where
        // the caller gave one, then the storm's rain in the rain green when there is any. Under a
        // narrow bracket the words "SWE" and "rain" are dropped so neighbouring storms do not run
        // into each other.
        let sweText = s.swe == null ? "" : `${r2(s.swe)}" SWE`, sweWidth = 0;
        let rainText = s.rain != null && s.rain >= 0.005 ? `${r2(s.rain)}" rain` : "", rainWidth = 0;
        if (sweText || rainText) {
          g.font = small;
          const extra = t => (t ? 5 + g.measureText(t).width : 0);
          if (totalWidth + extra(sweText) + extra(rainText) > right - left + 24) {
            if (sweText) sweText = `${r2(s.swe)}"`;
            if (rainText) rainText = `${r2(s.rain)}"`;
          }
          sweWidth = extra(sweText);
          rainWidth = extra(rainText);
        }
        const lineWidth = totalWidth + sweWidth + rainWidth;
        g.font = splitFont;
        const splitWidth = s.split ? g.measureText(s.split).width : 0;
        // The name: the longest version that fits within the bracket
        g.font = "10px " + family;
        const name = s.labels.map(l => l.toUpperCase()).find(l => g.measureText(l).width <= right - left);
        const nameWidth = name ? g.measureText(name).width : 0;

        // When only the end of a storm is in view at the left edge (a storm that started before
        // today, with today at the left), the block shifts right as far as it needs to rather
        // than being cut off. Only for a storm that is partly in view, and only at the left edge,
        // so labels of storms out of sight or at the right edge never slide over their neighbours.
        const widest = Math.max(lineWidth, splitWidth, nameWidth);
        const lo = (Number.isFinite(viewLeft) ? viewLeft : 0) + 4;
        if (seenRight > seenLeft && left < lo) mid = Math.max(mid, lo + widest / 2);

        // Bottom line, only for a storm under way: how much has already fallen
        let up = 0;
        if (s.split) {
          g.textAlign = "center";
          g.font = splitFont;
          g.fillStyle = "#e6edf5";
          g.fillText(s.split, mid, y - 3);
          up = 15;
        }
        // Above that the storm's name and dates, and on top the total with its SWE and rain
        g.textAlign = "center";
        if (name) {
          g.font = "10px " + family;
          g.fillStyle = "#8b9bb0";
          g.fillText(name, mid, y - 3 - up);
          up += 13;
        }
        const start = mid - lineWidth / 2;
        g.textAlign = "left";
        g.font = big;
        // Green (the page's rain colour) when more than half of the water is rain
        g.fillStyle = s.rainy ? PRECIP_COLORS.rain : s.past ? "#8b9bb0" : "#9fd8ff";
        g.fillText(total, start, y - 3 - up);
        if (sweText) {
          g.font = small;
          g.fillStyle = "#4f9dff";
          g.fillText(sweText, start + totalWidth + 5, y - 5 - up);
        }
        if (rainText) {
          g.font = small;
          g.fillStyle = PRECIP_COLORS.rain;
          g.fillText(rainText, start + totalWidth + sweWidth + 5, y - 5 - up);
        }
        g.textAlign = "center";
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
// A chart whose card is hidden (another tab is open) cannot measure how wide to be or where today
// is, so it waits here and is drawn the moment its card is shown
// A hidden card also loses its sideways scroll (the browser resets it to the far left, four months
// back), so each chart's position is remembered and put back when its card is shown again.
const dailyPending = new Map(); // id -> the dailyChart() settings it is waiting with
const dailyLeft = new Map();    // id -> how far the chart was scrolled
const dailyWatch = new ResizeObserver(entries => entries.forEach(e => {
  if (!(e.contentRect.width > 0)) return;
  const id = e.target.id.replace(/-scroll$/, "");
  if (dailyPending.has(id)) {
    const o = dailyPending.get(id);
    dailyPending.delete(id);
    dailyChart(o);
  } else if (dailyLeft.has(id)) {
    e.target.scrollLeft = dailyLeft.get(id);
  }
}));

// What is asked of the archive of past forecasts: enough for the snow calculation, plus wind
// speed for the drifting potential, which tracks how past wind used up loose snow
const HISTORY_VARS = ["precipitation", "rain", "showers", "temperature_2m", "wind_speed_10m", "temperature_700hPa",
  "temperature_650hPa", "temperature_600hPa", "temperature_550hPa", "temperature_500hPa"];

// The model's own record of the last few months at the page's forecast point, from Open-Meteo's
// archive of past forecasts. It is what the model estimated fell, not a measurement.
async function loadHistory(loc) {
  snowHistory = hourRows((await apiJson(track(["forecast"], historyUrl(loc)), { cache: "no-store" })).hourly);
  renderSummary();
  renderWater();
  if (allRows.length) renderCharts(allRows.slice(0, activeHours ?? allRows.length)); // the drifting roses use the history
}
function historyUrl(loc) {
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
  return "https://historical-forecast-api.open-meteo.com/v1/forecast?" + p;
}

// A scrolling day-by-day bar chart with storm totals above the bars. Shared by the snow summary
// and the rain & water chart. `o` holds:
//   id        "summary" or "water": the chart is #chart-<id> inside #<id>-scroll > #<id>-inner
//   days      Map of "YYYY-MM-DD" -> that day's numbers, in whatever shape the caller likes
//   today     the key of the current day; hasPast: whether the past days have loaded yet
//   datasets  keys => the Chart.js datasets (stacked bars, one value per key)
//   fallen, toCome   day => how much has already fallen / is still forecast, for the storm totals
//   fallenSwe, toComeSwe   optional: the same for snow water, written small beside each storm total
//   fallenRain, toComeRain optional: the rain on those days, already fallen / still forecast
//   greenWhenRainy         the total is drawn green when more than half of it is rain (water chart)
//   showRain               the storm's rain is written in green after its snow water (snow chart)
//   fmt       number => text without the inch mark; min: the least a day needs to count or be labelled
//   splitBelow optional: a lighter day than this between two snowier stretches splits a storm (stormRuns)
//   yTitle, tooltipLabel, plugins (extra chart plugins), grace (headroom above the bars, default "15%")
// Storms in a list of day totals, as [from, to] positions. A storm is a run of back-to-back days
// with at least `min` each; one drier day ends it. With `splitBelow`, a day under that amount with
// a day of at least that much on both sides, inside the same run, is a lull between two storms: it
// ends the one before and is counted in neither (its own bar still shows what it has).
const SNOW_LULL_IN = 0.4; // the snow charts' `splitBelow`
function stormRuns(values, min, splitBelow = null) {
  const runs = [];
  for (let i = 0; i < values.length;) {
    if (!(values[i] >= min)) { i++; continue; }
    let j = i;
    while (j + 1 < values.length && values[j + 1] >= min) j++;
    let start = null;
    for (let k = i; k <= j; k++) {
      const lull = splitBelow != null && values[k] < splitBelow &&
        values.slice(i, k).some(v => v >= splitBelow) && values.slice(k + 1, j + 1).some(v => v >= splitBelow);
      if (!lull && start == null) start = k;
      if (lull && start != null) { runs.push([start, k - 1]); start = null; }
    }
    if (start != null) runs.push([start, j]);
    i = j + 1;
  }
  return runs;
}

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
  if (!scroller) return;
  dailyWatch.observe(scroller); // watched for being hidden and shown again (once per element)
  if (!scroller.clientWidth) { // hidden: drawn when shown, so it can open on today
    dailyPending.set(o.id, o);
    return;
  }
  dailyPending.delete(o.id);
  // The scale on the right has a fixed width (SUMMARY_AXIS_PX) so the bars can be sized to
  // leave exactly enough room for it beside the last day.
  const room = scroller.clientWidth - SUMMARY_AXIS_PX;
  const visible = Math.min(SUMMARY_VISIBLE_BARS, Math.max(5, Math.floor(room / SUMMARY_MIN_BAR_PX)));
  document.getElementById(`${o.id}-inner`).style.width =
    keys.length <= visible ? "100%" : `${(room / visible) * keys.length + SUMMARY_AXIS_PX}px`;

  // Storm totals, each drawn directly above the bars it adds up (see stormRuns)
  const totalOf = k => o.fallen(o.days.get(k)) + o.toCome(o.days.get(k));
  const md = k => `${dateOf(k).getMonth() + 1}/${dateOf(k).getDate()}`;
  const ti = keys.indexOf(o.today);
  const sections = [];
  for (const [from, to] of stormRuns(keys.map(totalOf), o.min, o.splitBelow)) {
    const range = from === to ? md(keys[from]) : `${md(keys[from])}–${md(keys[to])}`;
    const stormDays = keys.slice(from, to + 1).map(k => o.days.get(k));
    const fallen = sum(stormDays.map(o.fallen)), toCome = sum(stormDays.map(o.toCome));
    // Snow water for the same days, when the caller can supply it (the snow summary does)
    const fallenSwe = o.fallenSwe ? sum(stormDays.map(o.fallenSwe)) : null;
    const toComeSwe = o.toComeSwe ? sum(stormDays.map(o.toComeSwe)) : null;
    // The rain within the same totals, when the caller can supply it (the water chart does)
    const fallenRain = o.fallenRain ? sum(stormDays.map(o.fallenRain)) : 0;
    const toComeRain = o.toComeRain ? sum(stormDays.map(o.toComeRain)) : 0;
    const stormRain = underWay => (underWay ? toComeRain : fallenRain + toComeRain); // matches the number shown
    // A storm that has started but not finished: the big number is only what is still to
    // come, and the line under it gives what has already fallen
    const underWay = fallen >= o.min && toCome >= o.min;
    sections.push({
      from, to,
      labels: [`Storm ${range}`, range], // the longest that fits is used
      value: underWay ? toCome : fallen + toCome,
      swe: toComeSwe == null ? null : underWay ? toComeSwe : fallenSwe + toComeSwe, // matches `value`
      // Water chart: more than half of the number shown is rain
      rainy: !!o.greenWhenRainy && stormRain(underWay) > (underWay ? toCome : fallen + toCome) / 2,
      // Snow chart: the storm's rain, written after its snow water
      rain: o.showRain ? stormRain(underWay) : null,
      past: to < ti, // entirely before today: a model estimate of what fell
      split: underWay ? `${o.fmt(fallen)}" already fallen` : null,
    });
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
        y: { stacked: true, beginAtZero: true, grace: o.grace || "15%", position: "right", title: { display: true, text: o.yTitle },
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
    dailyLeft.set(o.id, scroller.scrollLeft);
    charts[`chart-${o.id}`].draw();
    // The storm totals re-centre themselves in the part of each bracket that is in view,
    // so the chart is redrawn as it scrolls
    let queued = false;
    scroller.addEventListener("scroll", () => {
      if (scroller.clientWidth) dailyLeft.set(o.id, scroller.scrollLeft); // not while hidden
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; charts[`chart-${o.id}`]?.draw(); });
    });
  }
}

// Day-by-day snow at the page's forecast point: the last HISTORY_DAYS days (the model's estimate
// of what fell), today and the next fifteen (the model average), with storm totals above the bars.
function renderSummary() {
  summaryChart({ id: "summary", rows: allRows, history: snowHistory });
}
// The same chart for any resort: `rows` is its GFS forecast from the current hour, `history` the
// model's record, `series` its models (modelSeries); `id` names the chart's elements, as in dailyChart.
// `avg` ({ snow, swe }, one value per row), when given, replaces the usual average of the models.
function summaryChart({ id, rows, history, series, avg: given }) {
  if (!rows.length) return;
  const past = history.filter(r => r.time < rows[0].time); // everything before the current hour
  const avg = given ?? averageSnow(rows, series ?? modelSeries(rows));
  const ahead = avg.snow.map(v => v || 0), aheadSwe = avg.swe.map(v => v || 0);

  // Bucket every hour into its calendar day
  const days = new Map();
  const bucket = t => {
    const key = t.slice(0, 10);
    if (!days.has(key)) days.set(key, { fallen: 0, fallenSwe: 0, fallenRain: 0, rain: 0, day: 0, night: 0, daySwe: 0, nightSwe: 0 });
    return days.get(key);
  };
  past.forEach(r => { const b = bucket(r.time); b.fallen += r.snow || 0; b.fallenSwe += r.swe || 0; b.fallenRain += r.rain || 0; });
  rows.forEach((r, i) => {
    const b = bucket(r.time), part = r.isDay ? "day" : "night";
    b[part] += ahead[i];
    b[part + "Swe"] += aheadSwe[i]; // snow water, so each part's snow-to-water ratio can be worked out
    b.rain += (given?.rain ? given.rain[i] : r.rain) || 0; // the GFS rain, as on the SWE chart, unless `avg` has its own
  });
  // Snow-to-water ratio of the forecast snow in one part of a day: total snow over total snow
  // water, which weights each hour by how much fell. Null if there is no snow.
  const ratioOf = (k, part) => {
    const d = days.get(k);
    return d[part] > 0.005 && d[part + "Swe"] > 0 ? d[part] / d[part + "Swe"] : null;
  };

  dailyChart({
    id,
    days,
    today: rows[0].time.slice(0, 10),
    hasPast: past.length > 0,
    fallen: d => d.fallen,
    toCome: d => d.day + d.night,
    fallenSwe: d => d.fallenSwe,
    toComeSwe: d => d.daySwe + d.nightSwe,
    fallenRain: d => d.fallenRain,
    toComeRain: d => d.rain,
    showRain: true,
    fmt: r1,
    min: 0.05, // any day that shows 0.1" or more
    splitBelow: SNOW_LULL_IN, // a light day between two snowier stretches splits them into two storms
    yTitle: "inches of snow/rain",
    grace: "30%", // room for a rain label above the snow label
    datasets: keys => [
      { label: "Already fallen (model estimate)", data: keys.map(k => days.get(k).fallen), backgroundColor: "#8b9bb0" },
      // Forecast bars are coloured by snow-to-water ratio, the same scale as the snow ratio chart.
      // The night part sits on top with a hairline under it and moons drawn over it (nightMoons).
      { label: "Forecast, daytime", data: keys.map(k => days.get(k).day), ratio: keys.map(k => ratioOf(k, "day")),
        backgroundColor: keys.map(k => ratioColor(ratioOf(k, "day"))) },
      { label: "Forecast, night", data: keys.map(k => days.get(k).night), ratio: keys.map(k => ratioOf(k, "night")),
        backgroundColor: keys.map(k => ratioColor(ratioOf(k, "night"))), isNight: true,
        borderColor: "#16212f", borderWidth: { top: 0, right: 0, bottom: 1, left: 0 }, borderSkipped: false },
      // Rain, in inches of water, stacked on top of the snow in the SWE chart's rain colours.
      // `isRain` keeps it out of the day's snow total (see barTotals).
      { label: "Rain, already fallen (model estimate)", data: keys.map(k => days.get(k).fallenRain),
        backgroundColor: WATER_COLORS.rainPast, isRain: true },
      { label: "Rain, forecast", data: keys.map(k => days.get(k).rain), backgroundColor: WATER_COLORS.rain, isRain: true },
    ],
    tooltipLabel: ctx => {
      if (ctx.dataset.isRain) return `${ctx.dataset.label}: ${r2(ctx.parsed.y)}" of water`;
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
    fallenRain: d => d.rainPast,
    toComeRain: d => d.rain,
    greenWhenRainy: true,
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
  setSource("chart-hourly", HOURLY_SOURCES[dailyParam]);
}

// ---------- "Models:" line in the bottom right corner of each chart ----------
// What each chart's numbers are based on. Keep in step with the charts themselves.
const SNOW_MODELS = "GFS + HRRR, NBM, NAM";
const ALL_MODELS = "GFS + HRRR, NBM, NAM, ECMWF AI";
const STATION_SOURCE = "Source: station measurements, not a model";
const CHART_SOURCES = {
  "chart-summary": `Models: forecast is the average of ${SNOW_MODELS} · already fallen is the GFS + HRRR record`,
  "chart-water": `Models: forecast is the average of ${SNOW_MODELS} · already fallen is the GFS + HRRR record`,
  "chart-temp": `Models: average of ${ALL_MODELS}`,
  "chart-wind": `Models: wind is the average of ${ALL_MODELS} · gusts and direction from GFS + HRRR`,
  "chart-density": "Model: GFS + HRRR temperatures (Kuchera ratio)",
  "chart-snow-level": "Model: GFS + HRRR freezing level",
  "chart-cloud-models": `Models: ${ALL_MODELS}`,
  "chart-temp-models": `Models: ${ALL_MODELS}`,
  "chart-wind-models": `Models: ${ALL_MODELS}`,
  "chart-st-wind": STATION_SOURCE,
  "chart-st-rose": STATION_SOURCE,
  "chart-st-temp": STATION_SOURCE,
};
// The Daily Forecast chart changes with the measure picked
const HOURLY_SOURCES = {
  precip: `Models: chance from NBM (GFS after day 11) · snow or rain from the average of ${SNOW_MODELS}`,
  cloud: `Models: average of ${ALL_MODELS}`,
  temp: `Models: average of ${ALL_MODELS}`,
  feels: "Model: GFS + HRRR",
  wind: `Models: wind is the average of ${ALL_MODELS} · gusts and direction from GFS + HRRR`,
  ratio: `Models: snow from the average of ${SNOW_MODELS} · ratio from GFS + HRRR temperatures (Kuchera)`,
};
// Writes `text` as the small line at the bottom right of the card that holds the chart
function setSource(canvasId, text) {
  const card = document.getElementById(canvasId)?.closest(".card");
  if (!card) return;
  let line = card.querySelector(":scope > .source");
  if (!line) {
    line = document.createElement("p");
    line.className = "source";
    card.appendChild(line);
  }
  line.textContent = text || "";
}
Object.entries(CHART_SOURCES).forEach(([id, text]) => setSource(id, text));

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
function modelSeries(rows, li = 0, data = modelData) {
  if (!data?.[li]) {
    return [{ ...MODELS[0], swe: rows.map(r => r.swe), snow: rows.map(r => r.snow), cloud: rows.map(r => r.cloud),
      pop: rows.map(() => null), temp: rows.map(r => r.tempGfs ?? r.temp), wind: rows.map(r => r.windGfs ?? r.wind) }];
  }
  const h = data[li].hourly;
  const at = new Map(h.time.map((t, i) => [t, i]));
  const pick = (arr, r) => { const i = at.get(r.time); return arr && i != null ? arr[i] : null; };
  const none = rows.map(() => null);
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
      cloud: m.snowOnly ? none : rows.map(r => pick(cloud, r)), // a snow-only model is on no other chart
      pop: m.snowOnly ? none : rows.map(r => pick(h[`precipitation_probability_${m.id}`], r)), // chance of precipitation, %
      // Temperature and wind for the Spaghettis charts; the GFS line uses the page's own values
      temp: isMain ? rows.map(r => r.tempGfs ?? r.temp) : m.snowOnly ? none : rows.map(r => pick(h[`temperature_2m_${m.id}`], r)),
      wind: isMain ? rows.map(r => r.windGfs ?? r.wind) : m.snowOnly ? none : rows.map(r => pick(h[`wind_speed_10m_${m.id}`], r)),
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
// chart and the snow tiles. Models marked cloudOnly are left out, and so are those marked
// notInAverage, which are still returned in `series` so the snowfall charts can draw them.
// The average carries on with whichever models still have data, so past ~11 days it is the GFS alone.
function averageSnow(rows, series = modelSeries(rows)) {
  const drawn = series.filter(s => !s.cloudOnly);
  const snowModels = drawn.filter(s => !s.notInAverage);
  if (snowModels.length < 2) return { series: drawn, snow: rows.map(r => r.snow), swe: rows.map(r => r.swe) };
  return { series: drawn, snow: averageAcross(snowModels, "snow", 1), swe: averageAcross(snowModels, "swe", 1) };
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
          const text = `${d.shortLabel ?? d.label}: ${r1(vals[at])}"` + (roomy && swe?.[at] != null ? ` (${r2(swe[at])}" SWE)` : "");
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

  // Snowfall by model: one chart for each forecast point, lowest first, leaving out the
  // ridge-top point (AREA.ridgePoint). Each model's running total is drawn in that model's own
  // colour (MODELS) and the thick white line is their average. The cards are made here, once.
  const byElevation = locations.map((_, i) => i).sort((a, b) => locations[a].elevation_ft - locations[b].elevation_ft);
  const snowLocs = byElevation.filter(li => locations[li].id !== AREA.ridgePoint);
  const snowHolder = document.getElementById("snow-model-charts");
  if (snowHolder && !snowHolder.children.length) {
    snowHolder.innerHTML = snowLocs.map(li => `<section class="card">
      <h2>Snowfall by model <span class="muted small">(${locations[li].name} · ${locations[li].elevation_ft.toLocaleString()} ft)</span></h2>
      <div class="chart-wrap"><canvas id="chart-snow-models-${li}"></canvas></div>
      <p class="source">Models: ${SNOW_MODELS} · ECMWF IFS is drawn for comparison but is not in the average</p>
    </section>`).join("");
  }
  for (const li of snowLocs) {
    const lr = li === 0 ? rows : fullRows(li);
    if (!snowHolder || !lr.length) continue;
    const avg = averageSnow(lr, li === 0 ? series : modelSeries(lr, li));
    const snowSets = [];
    // Running totals count from now, so the lines begin at the "Now" mark, not at midnight
    if (avg.series.length > 1) {
      avg.series.forEach(s => {
        if (hasData(s.snow)) snowSets.push({ label: s.name, data: cumulative(fromNow(s.snow)), borderColor: s.color,
          backgroundColor: s.color, borderWidth: 1.5, pointRadius: 0, order: 1 });
      });
    }
    // `swe` rides along on the dataset so plateauLabels and the tooltip can show the matching water total
    snowSets.push({ label: "Average (GFS + HRRR, NBM, NAM)", shortLabel: "Average", data: cumulative(fromNow(avg.snow)), swe: cumulative(fromNow(avg.swe)),
      borderColor: "#ffffff", backgroundColor: "#ffffff", borderWidth: 3, pointRadius: 0, order: 0, isAverage: true });
    const snowOptions = compareOptions({ beginAtZero: true, title: { display: true, text: "total snow (in)" } }, v => `${r1(v)}"`);
    snowOptions.plugins.tooltip.callbacks.label = ctx => `${ctx.dataset.label}: ${r1(ctx.parsed.y)}"` +
      (ctx.dataset.isAverage ? ` (${r2(ctx.dataset.swe[ctx.dataIndex])}" SWE)` : "");
    makeChart(`chart-snow-models-${li}`, {
      type: "line",
      data: { labels, datasets: snowSets },
      options: snowOptions,
      plugins: [plateauLabels, ...shade],
    });
  }

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

  // Snow level: the height above which precipitation falls as snow. The model gives the height
  // of the freezing level (0°C); snow usually survives about SNOW_LEVEL_DROP_FT below that
  // before melting to rain, so the snow level is drawn that far under it. The line is bright in
  // the hours when precipitation is forecast, which is when it matters, and dim in dry hours:
  // pale blue when it would fall as snow at the page's forecast point, and the page's rain
  // green when it would fall as rain there (the same test as the Daily Forecast's bars).
  // Flat lines mark the area's forecast points, to show which of them sit above the snow level.
  const SNOW_LEVEL_DROP_FT = 1000;
  const snowLevel = rows.map(r => (r.freezeFt == null ? null : r.freezeFt - SNOW_LEVEL_DROP_FT));
  const wet = rows.map(r => (r.swe || 0) + (r.rain || 0) > 0.001);
  const rainy = rows.map(r => (r.rain || 0) > 0.001 && (r.rain || 0) > (r.swe || 0));
  const LEVEL = PRECIP_COLORS.snow, RAIN = PRECIP_COLORS.rain;
  const feet = v => `${Math.round(v / 10) * 10}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + " ft";
  makeChart("chart-snow-level", {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Snow level", data: snowLevel, borderColor: LEVEL, backgroundColor: LEVEL, borderWidth: 3, pointRadius: 0,
          segment: { borderColor: ctx => (rainy[ctx.p1DataIndex] ? RAIN : wet[ctx.p1DataIndex] ? LEVEL : "rgba(159, 216, 255, 0.3)") } },
        { label: "Freezing level", data: rows.map(r => r.freezeFt), borderColor: "rgba(255, 122, 92, 0.75)",
          backgroundColor: "rgba(255, 122, 92, 0.75)", borderWidth: 1.2, borderDash: [5, 4], pointRadius: 0 },
        ...byElevation.map(li => ({ label: `${locations[li].name} (${locations[li].elevation_ft.toLocaleString()} ft)`,
          data: rows.map(() => locations[li].elevation_ft), borderColor: locations[li].color + "b3",
          backgroundColor: locations[li].color, borderWidth: 1, pointRadius: 0, isGuide: true })),
      ],
    },
    options: (() => {
      const o = alignDays(baseOptions({ y: onRight({ title: { display: true, text: "feet" },
        ticks: { callback: v => v.toLocaleString() } }) }));
      o.plugins.tooltip.filter = item => !item.dataset.isGuide;
      // The legend above the chart lists only the forecast points; the snow level and freezing
      // level are in the key under the chart, which can show their line styles
      o.plugins.legend.labels.filter = (item, data) => data.datasets[item.datasetIndex].isGuide;
      o.plugins.tooltip.callbacks.label = ctx => `${ctx.dataset.label}: ${feet(ctx.parsed.y)}`;
      o.plugins.tooltip.callbacks.afterBody = items => {
        const i = items.length ? items[0].dataIndex : -1;
        if (i < 0 || snowLevel[i] == null) return "";
        const above = byElevation.filter(li => locations[li].elevation_ft >= snowLevel[i]).map(li => locations[li].name);
        return [rainy[i] ? `Rain forecast at ${locations[0].name} this hour` : wet[i] ? `Snow forecast at ${locations[0].name} this hour` : "Dry this hour",
          above.length ? `Above the snow level: ${above.join(", ")}` : "Every forecast point is below the snow level"];
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
  if (!AREA.stations.length) return; // a map point has no stations
  const note = document.getElementById("stations-source");
  const { results, updated } = await fetchStations(AREA);
  if (note && updated) {
    const when = new Date(updated).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
    note.textContent = `${AREA.name}'s stations are collected once an hour, so a reading can be up to an hour or so old. Last collected ${when}.`;
  }
  renderStations(results);
  checkRidgeWind(results).catch(err => console.warn("Station wind check unavailable", err));
}

// Every station of `area` (an entry in AREAS) with its readings. `updated` is when the hourly job
// last collected them, for an area whose stations come from a file (null for the live feed).
async function fetchStations(area) {
  let results, updated = null;
  // Only this page's own resort's stations count toward its Weather Stations tab's refresh button
  const own = url => (area === AREA ? track(["stations"], url) : url);
  if (area.stationFeed === "nws") {
    results = await Promise.all(area.stations.map(async s => {
      try {
        // 500 is the most the feed gives at once: 3.5 days at a reading every 10 minutes, more if less often
        const j = await apiJson(own(`https://api.weather.gov/stations/${s.id}/observations?limit=500`));
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
      file = await apiJson(own(area.stationFeed), { cache: "no-store" });
    } catch { /* every station is then listed as not reporting */ }
    const col = name => file.columns.indexOf(name);
    const from = (row, name, convert = v => v) => {
      const v = row[col(name)];
      return { value: v == null ? null : convert(v) };
    };
    const fToC = f => (f - 32) * 5 / 9, mphToKmh = m => m / 0.621371;
    results = area.stations.map(s => ({
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
    updated = file.updated ?? null;
  }
  return { results, updated };
}

// The cells of a station's row in a station table, from its latest reading `o`: elevation, time
// (marked "old" past three hours), temperature, wind, gust and the direction it comes from
function stationCells(s, o) {
  const val = (key, convert) => (o[key]?.value == null ? null : convert(o[key].value));
  const when = new Date(o.timestamp);
  const old = Date.now() - when > 3 * 3600 * 1000;
  const dir = o.windDirection?.value;
  return `<td>${s.elevation_ft.toLocaleString()} ft</td>
      <td${old ? ' class="muted"' : ""}>${when.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}${old ? " (old)" : ""}</td>
      <td>${r0(val("temperature", cToF))}°F</td>
      <td>${r0(val("windSpeed", kmhToMph))} mph</td>
      <td>${r0(val("windGust", kmhToMph))} mph</td>
      <td>${dir == null ? "–" : `<span class="arrow" style="transform:rotate(${(dir + 180) % 360}deg)">↑</span> ${compass(dir)}`}</td>`;
}

// ---------- Weather Stations (in the Locations menu) ----------
// Every resort's stations on one page: a table per resort, highest station first, each row the
// station's latest reading. Clicking a station opens its charts and readings in a row right under
// it: the same #station-detail block the resort's own Weather Stations tab uses, moved into the
// table while it is open and put back afterwards. Clicking the station again closes it.
let allStationsShown = false;
const allStationResults = {}; // area key -> that resort's stations with their readings
async function renderAllStations() {
  const holder = document.getElementById("all-stations");
  if (!holder || allStationsShown) return;
  allStationsShown = true;
  homeStationDetail(); // the table is about to be redrawn, so take the detail out of it first
  holder.innerHTML = '<p class="muted">Loading every resort…</p>';
  const useful = x => x.temperature?.value != null || x.windSpeed?.value != null;
  const areas = await Promise.all(Object.entries(AREAS).map(async ([key, area]) => {
    try {
      return { key, area, ...(await fetchStations(area)) };
    } catch (err) {
      console.warn(`Weather stations unavailable for ${area.name}`, err);
      return { key, area, results: [], updated: null };
    }
  }));
  holder.innerHTML = areas.map(({ key, area, results, updated }) => {
    allStationResults[key] = results;
    const byHeight = [...results].sort((a, b) => b.elevation_ft - a.elevation_ft);
    const silent = byHeight.filter(s => !s.obs.some(useful)).map(s => s.name);
    const rows = byHeight.filter(s => s.obs.some(useful)).map(s => `<tr class="pick-row" data-id="${s.id}" data-area="${key}"
        tabindex="0" role="button" aria-pressed="false" aria-expanded="false">
      <td>${s.name}</td>
      ${stationCells(s, s.obs.find(useful))}
    </tr>`);
    const collected = updated ? ` · collected hourly, last ${new Date(updated).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "";
    return `<section class="card">
      <h2><a href="?area=${key}#stations">${area.name}</a> <span class="muted small">(latest measurements, highest station first${collected})</span></h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Station</th><th>Elevation</th><th>Measured</th><th>Temp</th><th>Wind</th><th>Gust</th><th>From</th></tr></thead>
          <tbody>${rows.join("") || '<tr><td colspan="7" class="muted">No station is reporting right now.</td></tr>'}</tbody>
        </table>
      </div>
      ${silent.length ? `<p class="muted small station-note">Not reporting right now: ${silent.join(", ")}.</p>` : ""}
    </section>`;
  }).join("") + `<p class="source">${STATION_SOURCE} · click a station to open its charts and readings under it</p>`;
  const pick = e => { const tr = e.target.closest("tr.pick-row"); if (tr) toggleInlineStation(tr); };
  holder.onclick = pick;
  holder.onkeydown = e => { if ((e.key === "Enter" || e.key === " ") && e.target.closest("tr.pick-row")) { e.preventDefault(); pick(e); } };
}

// Opens the picked station's detail in a row just under it, or closes it if it is already open there
function toggleInlineStation(tr) {
  const wasOpen = tr.nextElementSibling?.classList.contains("detail-row");
  homeStationDetail();
  if (wasOpen) return;
  const detail = document.getElementById("station-detail");
  const row = document.createElement("tr");
  row.className = "detail-row";
  row.innerHTML = '<td colspan="7"></td>';
  tr.after(row);
  row.firstElementChild.appendChild(detail);
  tr.setAttribute("aria-expanded", "true");
  fitInlineStation();
  stationResults = allStationResults[tr.dataset.area];
  showStation(tr.dataset.id); // drawn after the move, so the charts measure their new place
}

// The detail is as wide as the visible part of its table, and stays in view if the table scrolls sideways
function fitInlineStation() {
  const row = document.querySelector("#all-stations tr.detail-row");
  if (row) document.getElementById("station-detail").style.width = `${row.closest(".table-wrap").clientWidth}px`;
}
window.addEventListener("resize", fitInlineStation);

// Puts the station detail back on the resort's own Weather Stations tab, showing that resort's
// stations again, and closes any row it had open on the Weather Stations page
function homeStationDetail() {
  const detail = document.getElementById("station-detail");
  const home = document.getElementById("view-stations");
  document.querySelectorAll("#all-stations tr[aria-expanded]").forEach(tr => {
    tr.setAttribute("aria-expanded", "false");
    tr.classList.remove("active");
    tr.setAttribute("aria-pressed", "false");
  });
  if (detail.parentElement === home) return;
  detail.style.width = "";
  home.appendChild(detail);
  document.querySelectorAll("#all-stations tr.detail-row").forEach(r => r.remove());
  stationResults = ownStationResults;
  if (ownStationResults.length && ownActiveStation) showStation(ownActiveStation);
  else detail.hidden = true;
}

function renderStations(results) {
  const rows = [], silent = [];
  // The stations that have reported most in the last 24 hours come first; ties go to the lower one
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const useful = x => x.temperature?.value != null || x.windSpeed?.value != null;
  const lately = s => s.obs.filter(x => useful(x) && new Date(x.timestamp).getTime() >= dayAgo).length;
  // Ahead of that comes how many of those readings carried a wind or a snow measurement. A wind
  // sensor stuck on zero all day counts for nothing; a snow sensor reading zero does count,
  // since no snow is a real answer.
  const windOrSnow = s => {
    const day = s.obs.filter(x => new Date(x.timestamp).getTime() >= dayAgo);
    const windWorks = day.some(x => x.windSpeed?.value > 0 || x.windGust?.value > 0);
    return day.filter(x => (windWorks && x.windSpeed?.value != null) ||
      x.snowBoard?.value != null || x.snowDepth?.value != null).length;
  };
  const ranked = [...results].sort((a, b) =>
    windOrSnow(b) - windOrSnow(a) || lately(b) - lately(a) || a.elevation_ft - b.elevation_ft);
  for (const s of ranked) {
    const o = s.obs.find(useful);
    if (!o) { silent.push(s.name); continue; }
    rows.push(`<tr class="pick-row" data-id="${s.id}" tabindex="0" role="button" aria-pressed="false">
      <td>${s.name}</td>
      ${stationCells(s, o)}
      <td>${lately(s)}</td>
    </tr>`);
  }
  const tbody = document.querySelector("#stations tbody");
  tbody.innerHTML = rows.length ? rows.join("")
    : '<tr><td colspan="8" class="muted">No station is reporting right now.</td></tr>';
  document.getElementById("stations-silent").textContent =
    silent.length ? `Not reporting right now: ${silent.join(", ")}.` : "";

  // Clicking a station (or pressing Enter or Space on it) shows its charts and readings below
  ownStationResults = results;
  const pick = e => { const tr = e.target.closest("tr[data-id]"); if (tr) showStation(tr.dataset.id); };
  tbody.onclick = pick;
  tbody.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e); } };
  const first = tbody.querySelector("tr[data-id]");
  ownActiveStation ??= first?.dataset.id ?? null;
  // While the detail is open on the Weather Stations page it is left there; it comes back later
  if (document.getElementById("station-detail").parentElement.id !== "view-stations") return;
  stationResults = results;
  if (ownActiveStation) showStation(ownActiveStation);
}

let stationResults = []; // the stations the detail is showing one of, with their recent readings, newest first
let activeStation = null; // id of the station whose detail is showing
let ownStationResults = []; // this resort's own stations (its Weather Stations tab)
let ownActiveStation = null; // the station picked on that tab

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
let stationRoseHours = 24;

// The picked station's measured wind over the last `stationRoseHours` hours, hour by hour:
// a bar chart (average speed in blue, with the hour's strongest gust rising above it in red and
// an arrow for the direction), and under it a compass rose of where the wind came from.
// The buttons above the bar chart choose the period for both.
function drawStationWind() {
  const s = stationResults.find(r => r.id === activeStation);
  if (!s || !s.obs.length) return;
  const HOUR = 3600000;
  const hours = stationRoseHours;
  const start = Math.floor(Date.now() / HOUR) * HOUR - (hours - 1) * HOUR; // the last bar is the hour under way

  // Readings gathered into hours: mean speed, strongest gust, and direction weighted by speed
  const bins = Array.from({ length: hours }, (_, i) => ({ t: start + i * HOUR, n: 0, wind: 0, gust: null, x: 0, y: 0, dirs: 0 }));
  let used = 0;
  for (const o of s.obs) {
    const b = bins[Math.floor((new Date(o.timestamp).getTime() - start) / HOUR)];
    if (!b) continue;
    if (o.windSpeed?.value != null) {
      const mph = kmhToMph(o.windSpeed.value);
      b.n += 1; b.wind += mph; used += 1;
      if (o.windDirection?.value != null) {
        const rad = o.windDirection.value * Math.PI / 180;
        b.x += Math.sin(rad) * (mph || 0.1); b.y += Math.cos(rad) * (mph || 0.1); b.dirs += 1;
      }
    }
    if (o.windGust?.value != null) b.gust = Math.max(b.gust ?? 0, kmhToMph(o.windGust.value));
  }
  const avg = bins.map(b => (b.n ? b.wind / b.n : null));
  const gust = bins.map((b, i) => (b.gust == null ? null : Math.max(b.gust, avg[i] ?? 0)));
  // A calm hour has no direction worth drawing (stations report 0° when the vane is still)
  const dir = bins.map((b, i) => (b.dirs && avg[i] >= 0.5 ? (Math.atan2(b.x, b.y) * 180 / Math.PI + 360) % 360 : null));
  const labels = bins.map(b => localKey(new Date(b.t)));

  const bar = document.getElementById("st-rose-range");
  bar.innerHTML = '<span class="muted small">Wind charts cover the last</span>' +
    ROSE_SPANS.map(p => `<button type="button" class="range-btn${p.hours === hours ? " active" : ""}"
      data-span="${p.hours}" aria-pressed="${p.hours === hours}">${p.label}</button>`).join("");
  bar.onclick = e => {
    const btn = e.target.closest("[data-span]");
    if (!btn) return;
    stationRoseHours = Number(btn.dataset.span);
    drawStationWind();
  };

  // Bars touch, like a histogram. The red part is stacked on the blue, so its top is the gust.
  const every = Math.max(1, Math.ceil(hours / 40)); // an arrow on every bar until they would overlap
  const options = stationOptions(labels, { beginAtZero: true, stacked: true, title: { display: true, text: "mph" } },
    hours <= 12 ? 1 : hours <= 24 ? 3 : 6);
  options.scales.x.stacked = true;
  options.plugins.tooltip.callbacks.label = ctx => {
    const i = ctx.dataIndex;
    if (ctx.dataset.label === "Direction") return `From ${compass(dir[i])} (${r0(dir[i])}°)`;
    return ctx.dataset.label === "Gusts" ? `Gusts: ${r0(gust[i])} mph` : `Ave.: ${r0(avg[i])} mph`;
  };
  options.plugins.legend.labels.filter = item => item.text !== "Direction";
  options.scales.y.grace = "12%"; // headroom for the letters over the top arrows
  // The compass point the wind came from, written over each arrow
  const dirLetters = {
    id: "dirLetters",
    afterDatasetsDraw(chart) {
      const g = chart.ctx;
      g.save();
      g.font = "600 10px " + Chart.defaults.font.family;
      g.textAlign = "center";
      g.textBaseline = "bottom";
      g.fillStyle = "#c9d4e2";
      chart.getDatasetMeta(2).data.forEach((pt, i) => {
        if (chart.data.datasets[2].data[i] != null) g.fillText(compass(dir[i]), pt.x, pt.y - 10);
      });
      g.restore();
    },
  };
  makeChart("chart-st-wind", {
    type: "bar",
    plugins: [dirLetters],
    data: {
      labels,
      datasets: [
        { label: "Ave.", data: avg, backgroundColor: "#5aa0e6", categoryPercentage: 1, barPercentage: 1 },
        { label: "Gusts", data: gust.map((g, i) => (g == null ? null : g - (avg[i] ?? 0))), backgroundColor: "#f08c8c",
          categoryPercentage: 1, barPercentage: 1 },
        // Arrows point where the wind is blowing toward. Their own "stack" keeps them out of the bars' sum.
        { type: "line", label: "Direction", stack: "arrows", showLine: false,
          data: bins.map((_, i) => (i % every === 0 && dir[i] != null ? (gust[i] ?? avg[i] ?? 0) + 3 : null)),
          pointStyle: arrowImage(), pointRadius: 9, rotation: ctx => ((dir[ctx.dataIndex] ?? 0) + 180) % 360 },
      ],
    },
    options,
  });

  // Miles of wind: an hour at 10 mph is 10 miles of air going past. Split by where it came from.
  const sectors = DIRS.map(() => 0);
  let miles = 0;
  bins.forEach((b, i) => {
    if (avg[i] == null) return;
    miles += avg[i];
    if (dir[i] != null) sectors[sectorOf(dir[i])] += avg[i];
  });
  makeArrowRose("chart-st-rose", sectors);

  const span = hours === 1 ? "hour" : `${hours} hrs`;
  const top = sectors.map((m, i) => ({ m, name: DIRS[i] })).filter(x => x.m >= 0.5).sort((a, b) => b.m - a.m).slice(0, 3);
  const when = ms => new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const oldest = new Date(s.obs[s.obs.length - 1].timestamp).getTime();
  document.getElementById("st-rose-note").innerHTML = !used
    ? "No wind readings in this period."
    : `<b>${r0(miles)} miles of wind in ${span}.</b> ` +
      (top.length ? `Mostly from ${top.map(x => `${x.name} (${r0(x.m)} mi)`).join(", ")}. ` : "") +
      `${used} readings.` +
      (oldest > start + HOUR ? ` This station's available readings only go back to ${when(oldest)}.` : "");

  drawStationDrift(); // the wind loading rose, when it is on the page, covers the same period
}

// A compass rose in the style of Alta's own wind page: an arrow sits on the rim at each direction
// the wind came from and points inward, the way the wind blew. Its length is that direction's
// share of the miles of wind, with the busiest direction reaching the centre. `sectors` holds the
// miles from each of the sixteen directions in DIRS. Drawn by hand, since Chart.js has no such chart.
function makeArrowRose(id, sectors) {
  if (charts[id]) charts[id].destroy();
  const canvas = document.getElementById(id);
  const draw = () => {
    const box = canvas.parentElement.getBoundingClientRect();
    if (!box.width || !box.height) return; // hidden tab: drawn when it is shown again
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    canvas.style.width = `${box.width}px`;
    canvas.style.height = `${box.height}px`;
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, box.width, box.height);
    const cx = box.width / 2, cy = box.height / 2;
    const R = Math.max(40, Math.min(box.width, box.height) / 2 - 34);

    // Rings: grey rim, green and orange inside it, a red dot at the centre
    const ring = (r, color, width) => { g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.strokeStyle = color; g.lineWidth = width; g.stroke(); };
    ring(R, "#8b9bb0", 2);
    ring(R * 0.62, "#4caf6a", 2);
    ring(R * 0.3, "#e08a3c", 2);
    ring(2.5, "#ff5c5c", 2);

    // Compass letters: the four main points large, the four between them small
    g.fillStyle = "#e6edf5";
    g.textAlign = "center";
    g.textBaseline = "middle";
    DIRS.forEach((name, i) => {
      if (i % 2) return;
      const a = i * 22.5 * Math.PI / 180, main = i % 4 === 0;
      g.font = `${main ? "600 17px" : "11px"} ${Chart.defaults.font.family}`;
      const d = R + (main ? 17 : 15);
      g.fillText(name, cx + Math.sin(a) * d, cy - Math.cos(a) * d);
    });

    const total = sectors.reduce((a, b) => a + b, 0), most = Math.max(...sectors);
    if (!(most > 0)) return;
    g.strokeStyle = g.fillStyle = "#6c8cff";
    g.lineWidth = 2.5;
    g.lineCap = "round";
    sectors.forEach((m, i) => {
      if (m < total * 0.02) return; // leave out directions with next to no wind
      const a = i * 22.5 * Math.PI / 180, ux = Math.sin(a), uy = -Math.cos(a);
      const len = Math.max(11, R * m / most);
      const tx = cx + ux * R, ty = cy + uy * R;                   // tail on the rim
      const hx = cx + ux * (R - len), hy = cy + uy * (R - len);   // head toward the centre
      g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx + ux * 6, hy + uy * 6); g.stroke();
      // Arrowhead with a notched back, pointing inward
      const px = -uy, py = ux;
      g.beginPath();
      g.moveTo(hx, hy);
      g.lineTo(hx + ux * 11 + px * 6, hy + uy * 11 + py * 6);
      g.lineTo(hx + ux * 7, hy + uy * 7);
      g.lineTo(hx + ux * 11 - px * 6, hy + uy * 11 - py * 6);
      g.closePath();
      g.fill();
    });
  };
  draw();
  window.addEventListener("resize", draw);
  // Stands in for a Chart.js chart, so the page's "refit every chart" and "replace this chart" code works on it
  charts[id] = { resize: draw, draw, destroy() { window.removeEventListener("resize", draw); } };
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
    stationHistory[s.id] = apiJson("https://historical-forecast-api.open-meteo.com/v1/forecast?" + p, { cache: "no-store" })
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
  // Off the page for now: nothing is fetched or drawn until its canvas is put back in index.html
  if (!document.getElementById("chart-st-drift") || !note) return;
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
  if (stationResults === ownStationResults) ownActiveStation = id;
  // Rows on the resort's own tab and on the Weather Stations page; ids are unique across resorts
  document.querySelectorAll("tr.pick-row[data-id]").forEach(tr => {
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
  const temp = obs.map(o => get(o, "temperature", cToF));

  drawStationWind(); // hourly wind bars and the wind rose, over the period picked above them

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
      <p class="source">${STATION_SOURCE}</p>
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
  const h = (await apiJson("https://api.open-meteo.com/v1/forecast?" + p, { cache: "no-store" })).hourly;
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

// ---------- Refresh button to the left of the resort tabs ----------
// Refreshes only the tab that is open. Forecast gathers its forecast, model averages, model
// record, measured snow and NWS text again; Spaghettis the model comparison; Weather Stations the
// station readings; Cams reloads its pictures. apiJson() only really downloads what is over three
// minutes old, so if none of the open tab's downloads is that old yet the button just says so.
const TAB_REFRESH = {
  forecast: () => {
    const loc = locations[0];
    loadNws(loc);
    loadModels(locations);
    loadHistory(loc).catch(err => console.warn("Snow history unavailable", err));
    loadMeasured().catch(err => console.warn("Measured snow unavailable", err));
    return loadForecast();
  },
  models: () => loadModels(locations),
  stations: () => loadStations(),
  "machine-learning": () => { mlData = null; mlPrecip = null; mlEnsemble = null; return showMachineLearning(); },
};
document.getElementById("refresh").addEventListener("click", () => {
  const note = document.getElementById("refresh-note");
  const say = text => {
    note.textContent = text;
    clearTimeout(note.timer);
    note.timer = setTimeout(() => { note.textContent = ""; }, 5000);
  };
  const view = ["forecast", "machine-learning", "metrics", "models", "stations", "cams", "guide", "info"]
    .find(v => !document.getElementById(`view-${v}`).hidden);
  if (view === "cams") { drawMountainCams(); say("Pictures reloaded."); return; }
  if (!TAB_REFRESH[view]) { say("Nothing on this tab to refresh."); return; }
  const times = [...tabDownloads[view]].map(u => apiFetchedAt.get(u)).filter(t => t != null);
  const wait = times.length ? API_FRESH_MS - (Date.now() - Math.min(...times)) : 0;
  if (wait > 0) {
    const mins = Math.ceil(wait / 60000);
    say(`Up to date. New data can be fetched in ${mins} minute${mins === 1 ? "" : "s"}.`);
    return;
  }
  Promise.resolve(TAB_REFRESH[view]()).then(() => say("Refreshed."))
    .catch(err => { console.warn("Refresh failed", err); say("Couldn't refresh right now."); });
});

// ---------- Refresh button beside "Storm Results" / "Weather Cameras" ----------
// Storm Results downloads every resort's measured snow and model record again, but, like the
// button beside a resort's name, only once three minutes have passed since the last download;
// before that it just says so. Weather Cameras reloads its pictures straight away (UDOT updates
// them about once a minute and they count against no limit).
document.getElementById("global-refresh").addEventListener("click", () => {
  const note = document.getElementById("global-refresh-note");
  const say = text => {
    note.textContent = text;
    clearTimeout(note.timer);
    note.timer = setTimeout(() => { note.textContent = ""; }, 5000);
  };
  if (!document.getElementById("view-cameras").hidden) {
    drawCameras();
    say("Pictures reloaded.");
    return;
  }
  // The Map has nothing to refresh: a spot's forecast is fetched fresh each time it is clicked
  if (!document.getElementById("view-map").hidden) {
    say("Click a spot on the map for its latest forecast.");
    return;
  }
  // Weather Stations redraws straight away; readings under three minutes old come from the saved copy
  if (!document.getElementById("view-allstations").hidden) {
    allStationsShown = false;
    renderAllStations().then(() => say("Refreshed.")).catch(err => console.warn("Refresh failed", err));
    return;
  }
  const mountains = !document.getElementById("view-mountains").hidden;
  const urls = mountains ? mountainUrls : stormUrls;
  const times = urls.map(u => apiFetchedAt.get(u)).filter(t => t != null);
  const wait = times.length ? API_FRESH_MS - (Date.now() - Math.min(...times)) : 0;
  if (wait > 0) {
    const mins = Math.ceil(wait / 60000);
    say(`Up to date. New data can be fetched in ${mins} minute${mins === 1 ? "" : "s"}.`);
    return;
  }
  const redraw = mountains ? () => { mountainsShown = false; return renderMountainForecasts(); }
    : () => { stormResultsShown = false; return renderStormResults(); };
  redraw().then(() => say("Refreshed.")).catch(err => console.warn("Refresh failed", err));
});

// ---------- Forecast / Info tabs ----------
// The drop-down menus (Switch resort, Guide & Info) also close on a click anywhere else, or on Escape
const infoMenu = document.getElementById("info-menu");
const menus = [...document.querySelectorAll("details.menu")];
document.addEventListener("click", e => menus.forEach(m => { if (!m.contains(e.target)) m.open = false; }));
document.addEventListener("keydown", e => { if (e.key === "Escape") menus.forEach(m => { m.open = false; }); });
document.querySelectorAll(".tab[data-view]").forEach(btn => btn.addEventListener("click", () => {
  const view = btn.dataset.view;
  for (const v of ["forecast", "machine-learning", "metrics", "models", "stations", "cams", "guide", "info", "storms", "mountains", "cameras", "allstations", "map"]) document.getElementById(`view-${v}`).hidden = v !== view;
  document.querySelectorAll(".tab[data-view]").forEach(b => {
    b.classList.toggle("active", b === btn);
    b.setAttribute("aria-pressed", b === btn);
  });
  // The Guide & Info menu closes after a pick, and its button lights up while one of its pages is showing
  menus.forEach(m => { m.open = false; });
  infoMenu.querySelector("summary").classList.toggle("active", view === "guide" || view === "info");
  // Storm Results and Weather Cameras cover every resort, so the header shows their name instead
  const global = { storms: "Storm Results", mountains: "Forecast Summaries", cameras: "Weather Cameras", allstations: "Weather Stations", map: "Map" }[view];
  document.body.classList.toggle("global-mode", !!global);
  document.getElementById("global-title").textContent = global || "";
  document.querySelector("#area-menu summary").classList.toggle("active", !!global);
  // "Resort Forecasts" in that menu is ticked while a resort's own page is showing
  document.getElementById("resort-forecasts").classList.toggle("active", !global && !POINT);
  if (view === "storms") renderStormResults().catch(err => console.warn("Storm results unavailable", err));
  if (view === "mountains") renderMountainForecasts().catch(err => console.warn("Mountain forecasts unavailable", err));
  if (view === "allstations") renderAllStations().catch(err => console.warn("Weather stations unavailable", err));
  if (view === "stations") homeStationDetail(); // back from the Weather Stations page, if it was open there
  if (view === "machine-learning") showMachineLearning();
  showCameras(view === "cameras");
  showMountainCams(view === "cams");
  showMap(view === "map");
  // Keep the tab in the address, so a reload or a switch of resort comes back to it. Picking a
  // tab is a step in the browser's history, so Back returns to the tab before; a tab opened by
  // the address itself or by Back/Forward only rewrites the current step.
  const url = location.pathname + location.search + (view === "forecast" ? "" : `#${view}`);
  if (restoringView || url === location.pathname + location.search + location.hash) {
    history.replaceState(history.state, "", url);
  } else {
    history.pushState({ backOk: true }, "", url); // the step before this one is on this site
  }
  updateBack();
  // Charts can't measure themselves while hidden, so refit them when their tab comes back
  Object.values(charts).forEach(c => c.resize());
}));
// The Cams tab is only there for a resort with cams listed in AREAS, and Weather Stations for one with stations
if (!AREA.cams) document.querySelector('.tab[data-view="cams"]').remove();
if (!AREA.stations.length) document.querySelector('.tabs[data-area-pages] .tab[data-view="stations"]').remove();
// The Machine Learning tab is on Alta's page only, for now
if (POINT || AREA_KEY !== "alta") document.querySelector('.tab[data-view="machine-learning"]').remove();

// ---------- Back button ----------
// The ← at the left of the header, on every page. Each step in the browser's history records in
// `backOk` whether the step before it is part of this site: a tab picked here always is, and a
// page opened from a link is when the link was on this site (its referrer). The button goes back
// when that is so; when going back would leave the site it opens Alta's Forecast tab instead, and
// it is greyed out only when that is already what is showing.
let restoringView = false; // true while a tab is opened from the address, not by a click
if (!history.state || history.state.backOk === undefined) {
  let fromHere = false;
  try { fromHere = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch { /* no referrer */ }
  history.replaceState({ ...(history.state || {}), backOk: fromHere }, "");
}
// Alta's Forecast tab is showing: the Alta page (the default when no resort is named) with no tab in the address
const onAltaForecast = () => !POINT && AREA_KEY === "alta" && !location.hash;
function updateBack() {
  const stuck = !history.state?.backOk && onAltaForecast();
  document.querySelectorAll("button.back").forEach(b => {
    b.disabled = stuck;
    b.title = history.state?.backOk || stuck ? "Back" : "Back to the Alta forecast";
  });
}
document.querySelectorAll("button.back").forEach(b => b.addEventListener("click", () => {
  if (history.state?.backOk) history.back();
  else if (onAltaForecast()) return;
  // Already on Alta's page, on another tab: switch to its Forecast tab without reloading
  else if (!POINT && AREA_KEY === "alta") document.querySelector('.tab[data-view="forecast"]').click();
  else location.href = location.pathname + "?area=alta";
}));
// Opens the tab the address names (#models, #map …, or the Forecast tab with none), without
// adding a history step. #cams on a resort without cams stays on the Forecast tab.
function openViewFromAddress() {
  const btn = (location.hash.length > 1 && document.querySelector(`.tab[data-view="${CSS.escape(location.hash.slice(1))}"]`))
    || document.querySelector('.tab[data-view="forecast"]');
  restoringView = true;
  try { btn.click(); } finally { restoringView = false; }
}
// Back and Forward between tabs of this page
window.addEventListener("popstate", () => { openViewFromAddress(); updateBack(); });
if (location.hash) openViewFromAddress();
updateBack();

// ---------- National Weather Service ----------
async function loadNws(loc) {
  const box = document.getElementById("nws");
  try {
    const point = await apiJson(track(["forecast"], `https://api.weather.gov/points/${loc.lat},${loc.lon}`));
    const fc = await apiJson(track(["forecast"], point.properties.forecast));

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

// ---------- Start ----------
main();
