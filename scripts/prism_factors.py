"""Work out the PRISM downscaling factors behind the Beta Snow Summary.

The method is Lewis & Steenburgh's (2017) and the University of Utah Snow Ensemble's: a model's
precipitation is the average over its grid box, so it is multiplied by how much wetter (or drier)
the forecast point is than that box in PRISM's 30-year normals:

    factor = PRISM at the point / mean of the PRISM cells inside a box one model grid wide, centred on the point

The box depends on the model's grid, so every model gets its own factor, for every month. "At the
point" is the 800 m PRISM cell the point's exact latitude and longitude fall in, and the box is
centred on those exact coordinates (not on that cell's centre). Factors are kept between 0.5 and 3.0.

It writes two things:
  data/prism-factors.json   the factors for every forecast point in locations.json, and the
                            settings the page needs to work them out itself (GRIDS, CLAMP, REGION)
  data/prism/ppt-MM.bin     each month's PRISM normals over REGION (the Wasatch and around it), so
                            the page can work out the factors for any spot picked on the Map in
                            exactly the same way. Unsigned 16-bit, little-endian, row by row from
                            the north-west corner, in tenths of a millimetre; 65535 = no data.

The normals are PRISM's 1991-2020 800 m monthly precipitation (Oregon State University). Its old
web service (services.nacse.org/prism/data/public/normals/...) was switched off on 30 Sept 2025
and the new one does not serve normals, so they come from data.prism.oregonstate.edu. Each month's
zip is downloaded once into prism_cache/ (not committed) and reused: PRISM blocks a file that is
downloaded twice in 24 hours. Run it again only when locations.json, GRIDS or REGION changes:

    pip install rasterio numpy
    python scripts/prism_factors.py
    python scripts/prism_factors.py --at 40.5763 -111.6383   # just print one spot's factors
"""
import datetime as dt
import json
import math
import pathlib
import sys
import urllib.request
import zipfile

import numpy as np
import rasterio

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "prism-factors.json"
GRID_DIR = ROOT / "data" / "prism"
CACHE = ROOT / "prism_cache"
URL = "https://data.prism.oregonstate.edu/normals/us/800m/ppt/monthly/prism_ppt_us_30s_2020{mm}_avg_30y.zip"
CLAMP = (0.5, 3.0)
KM_PER_DEG = 111.32
NODATA = 65535
SCALE = 10  # stored in tenths of a millimetre

# Each model's grid spacing as Open-Meteo serves it, checked against the grid cell the API snaps
# Alta to (Oct 2026). `km` grids are Lambert grids in km; `deg` grids are latitude/longitude.
GRIDS = {
    "hrrr": {"km": 3, "name": "HRRR", "api": "ncep_hrrr_conus"},
    "nam": {"km": 3, "name": "NAM", "api": "ncep_nam_conus"},  # the 3 km CONUS nest, on the HRRR's grid
    "nbm": {"km": 2.5, "name": "NBM", "api": "ncep_nbm_conus"},
    # Open-Meteo's docs call it 0.11°; the cells it returns are 360/3072 = 0.1171875° apart in longitude
    "gfs": {"deg": 0.1171875, "name": "GFS", "api": "ncep_gfs013"},
    "gefs025": {"deg": 0.25, "name": "GEFS 0.25°", "api": "ncep_gefs025"},  # the ensemble's first ~10.5 days
    "gefs05": {"deg": 0.5, "name": "GEFS 0.5°", "api": "ncep_gefs05"},      # the rest of its 16 days
    "ecmwf_ens": {"deg": 0.25, "name": "ECMWF ENS", "api": "ecmwf_ifs025"},
}
# Spots on the Map get factors anywhere inside this box: Provo and Timpanogos to Ogden and Ben
# Lomond, the Great Salt Lake's east shore to Kamas. The grids saved for the page reach half the
# widest model box (0.25°) further, plus a cell, so every box fits.
REGION = {"south": 39.75, "north": 41.65, "west": -112.25, "east": -110.75}


def normals(month):
    """Path of one month's normals zip, downloading it the first time."""
    CACHE.mkdir(exist_ok=True)
    mm = f"{month:02d}"
    path = CACHE / f"prism_ppt_us_30s_2020{mm}_avg_30y.zip"
    if not path.exists():
        print(f"Downloading {path.name}")
        tmp = path.with_suffix(".part")
        urllib.request.urlretrieve(URL.format(mm=mm), tmp)
        tmp.replace(path)
    return path


def raster_in(zip_path):
    """rasterio's address for the grid inside a normals zip (a GeoTIFF now; .bil in older packages)."""
    with zipfile.ZipFile(zip_path) as z:
        name = next(n for n in z.namelist() if n.lower().endswith((".tif", ".bil")))
    return f"zip://{zip_path.as_posix()}!{name}"


def half_widths(grid, lat):
    """Half the box's height and width in degrees."""
    if "deg" in grid:
        return grid["deg"] / 2, grid["deg"] / 2
    km = grid["km"] / 2
    return km / KM_PER_DEG, km / (KM_PER_DEG * math.cos(math.radians(lat)))


def factors_at(src, lat, lon):
    """PRISM at the exact point (mm), the factors before clamping, and the number of cells in each box."""
    t = src.transform  # north-up: x = t.c + col * t.a, y = t.f + row * t.e (t.e < 0)
    row, col = src.index(lon, lat)
    at = float(src.read(1, window=rasterio.windows.Window(col, row, 1, 1), masked=True)[0, 0])
    raw, cells = {}, {}
    for key, grid in GRIDS.items():
        half_lat, half_lon = half_widths(grid, lat)
        # The cells whose centres lie inside the box
        c0 = math.ceil((lon - half_lon - t.c) / t.a - 0.5)
        c1 = math.floor((lon + half_lon - t.c) / t.a - 0.5)
        r0 = math.ceil((lat + half_lat - t.f) / t.e - 0.5)
        r1 = math.floor((lat - half_lat - t.f) / t.e - 0.5)
        box = src.read(1, window=rasterio.windows.Window(c0, r0, c1 - c0 + 1, r1 - r0 + 1), masked=True)
        mean = float(box.mean())
        raw[key] = at / mean if mean > 0 else 1.0
        cells[key] = int(box.count())
    return at, raw, cells


def clamp(v):
    return min(max(v, CLAMP[0]), CLAMP[1])


def save_region(src, month):
    """This month's normals over REGION and its margin, for the page; returns where the grid sits."""
    t = src.transform
    margin = 0.25 + abs(t.a)
    c0 = math.floor((REGION["west"] - margin - t.c) / t.a)
    c1 = math.ceil((REGION["east"] + margin - t.c) / t.a)
    r0 = math.floor((REGION["north"] + margin - t.f) / t.e)
    r1 = math.ceil((REGION["south"] - margin - t.f) / t.e)
    cells = src.read(1, window=rasterio.windows.Window(c0, r0, c1 - c0, r1 - r0), masked=True)
    out = np.where(cells.mask, NODATA, np.round(cells.filled(0) * SCALE)).astype("<u2")
    GRID_DIR.mkdir(exist_ok=True)
    (GRID_DIR / f"ppt-{month:02d}.bin").write_bytes(out.tobytes())
    # The north-west corner of the first cell, and the cell size, as the page reads them
    return {"west": t.c + c0 * t.a, "north": t.f + r0 * t.e, "res": t.a, "rows": int(out.shape[0]),
            "cols": int(out.shape[1]), "scale": SCALE, "nodata": NODATA}


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "--at":
        lat, lon = float(sys.argv[2]), float(sys.argv[3])
        for month in range(1, 13):
            with rasterio.open(raster_in(normals(month))) as src:
                at, raw, _ = factors_at(src, lat, lon)
            print(f"{month:2d}  PRISM {at:6.1f} mm  " + "  ".join(f"{k} {clamp(v):.3f}" for k, v in raw.items()))
        return

    locs = json.loads((ROOT / "locations.json").read_text(encoding="utf-8"))
    points = {l["id"]: {"name": l["name"], "area": l["area"], "lat": l["lat"], "lon": l["lon"], "prism_mm": [], "cells": {},
                        "factors": {k: [] for k in GRIDS}, "unclamped": {k: [] for k in GRIDS}} for l in locs}
    region = None
    for month in range(1, 13):
        with rasterio.open(raster_in(normals(month))) as src:
            region = save_region(src, month)
            for l in locs:
                p = points[l["id"]]
                at, raw, cells = factors_at(src, l["lat"], l["lon"])
                p["prism_mm"].append(round(at, 1))
                p["cells"] = cells
                for key, v in raw.items():
                    p["unclamped"][key].append(round(v, 3))
                    p["factors"][key].append(round(clamp(v), 3))
    OUT.write_text(json.dumps({
        "source": "PRISM 1991-2020 800 m monthly precipitation normals, PRISM Group, Oregon State University",
        "made": dt.date.today().isoformat(),
        "method": "PRISM at the point / mean PRISM in a box one model grid wide centred on the point (Lewis & Steenburgh 2017)",
        "clamp": list(CLAMP),
        "km_per_deg": KM_PER_DEG,
        "grids": GRIDS,
        "region": {**REGION, "grid": region, "files": "data/prism/ppt-MM.bin"},
        "points": points,
    }, indent=1) + "\n", encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)} for {len(points)} points, and {region['rows']} x {region['cols']} grids in {GRID_DIR.relative_to(ROOT)}")
    for pid, p in points.items():
        if p["area"] != "Alta":
            continue
        print(f"\n{p['name']} ({pid})  PRISM mm/month: {p['prism_mm']}")
        for key in GRIDS:
            print(f"  {key:10s} cells={p['cells'][key]:5d}  " + " ".join(f"{v:5.2f}" for v in p["unclamped"][key]))


if __name__ == "__main__":
    main()
