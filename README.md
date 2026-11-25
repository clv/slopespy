# Ski Resort Scale Compare

Compare two ski resorts side by side as scale-correct 3D terrain models (three.js).
Both halves share one camera, so a kilometre on the left is exactly a kilometre on the right.
Terrain can be vertically exaggerated (1–5×, default 3×); trees and buildings always stay at true height.

The site is static and lives in `docs/` (served by GitHub Pages).

## Data

| What | Source | Licence |
|---|---|---|
| Ski areas, runs, lifts (names, type, seats) | OpenStreetMap via [OpenSkiMap](https://openskimap.org) exports | ODbL |
| Terrain | [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium), fetched live in the browser | see tilezen attribution |
| Trees / land cover | [ESA WorldCover 2021](https://esa-worldcover.org) 10 m, baked per resort | CC BY 4.0 |
| Buildings, roads, parking | [Overture Maps](https://overturemaps.org) (OSM-based), baked per resort | ODbL |

`docs/data/`:
- `index.json` – the resort list (4,000+ named ski areas with mapped downhill runs).
- `resorts/<id>.json` – runs, lifts, boundary and the terrain window for one resort.
- `landcover/<id>.png` – WorldCover class per pixel over the terrain window.
- `features/<id>.json` – buildings, roads and parking (largest ~1,000 resorts).

## Rebuilding

```sh
pip install numpy pillow rasterio pyarrow shapely
mkdir -p data/raw && cd data/raw
for f in ski_areas runs lifts; do curl -O https://tiles.openskimap.org/geojson/$f.geojson; done
cd ../..
TOP_N=100000 python3 scripts/build_data.py data/raw docs/data   # resorts + index
python3 scripts/enrich_index.py                                # continent, run count for search/sort
python3 scripts/bake_landcover.py                              # ~10 min
TOP_FEATURES=1000 python3 scripts/fetch_features.py            # hours; resumable
python3 -m http.server -d docs 8000
```

Resorts are ranked by total mapped downhill run length (a proxy for size that depends on OSM mapping quality).
Linked areas (e.g. Les Trois Vallées) and their member resorts (Courchevel, Méribel…) are both listed.
