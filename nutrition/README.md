# nutrition/

Data ETL: the on-device nutrient + density bundle, and the pipeline adapter that reads it. Zero dependencies — Node's built-in `node:sqlite` and a hand-rolled CSV parser.

Sources (all storable — licenses checked):

- **USDA FoodData Central** (CC0) — per-100 g energy/macros/micros. Generic foods only for the bundle: SR Legacy + Foundation + FNDDS ≈ 15–17k rows.
- **FNDDS `food_portion`** — 35k+ household-measure gram weights; volumetric measures ("1 cup = 158 g") double as **density** (ρ = g / 236.59 mL, MATH.md §5).
- **FAO/INFOODS Density Database** — direct density values where FNDDS is silent. *(Planned — the `density_source` column already distinguishes provenance; only `fdc_portion` is emitted today.)*

## Output — the SQLite bundle

A versioned SQLite file (~2.3 MB for the full generic-food set) built by `etl/build-bundle.mjs` and shipped as an app asset:

- **`foods`** — one denormalized row per FDC food: `fdc_id, description, data_type, {kcal,protein,carbs,fat}100, {fiber,sugar,satfat,sodium,cholesterol,potassium,calcium,iron}100, density_g_per_ml, density_source`. Density is **inline** (derived from volumetric FNDDS portions) and tagged with its source for auditability.
- **`foods_fts`** — FTS5 full-text index over `description` (falls back to `LIKE` where fts5 is unavailable).
- **`shape_priors`** — `class, kind, kappa, phi, h_bar_m, samples, source` (κ/φ/h̄ per class, MATH.md §4). Seeded from `priors.json` (`model/priors/fit_priors.py`) when built with `--priors`, else a single mound default (`_global`) matching the pipeline's `DEFAULT_KAPPA`/`DEFAULT_MOUND_PHI` placeholder.
- **`meta`** — build provenance (`generated_at`, `data_types`, `fts`, `source`).

Build it (the production path — full FDC export + the curated starter set overlaid, FTS index, label-map copy):

```
node starter/build-full.mjs --fdc-dir <dir with the unzipped per-type FDC CSV exports> \
  --out apps/demo/assets/nutrients.sqlite --priors model/priors/priors.json
```

Download the **per-type** CSV zips (Foundation, SR Legacy, FNDDS) from the FDC
site — not the all-types zip, whose branded-food CSVs are gigabytes the build
filters out anyway. Density derivation parses all three portion encodings the
real exports use (Foundation `measure_unit_id`, SR Legacy `modifier` text,
FNDDS `portion_description`). The generic single-dir CLI is still there:

```
node etl/cli.mjs --fdc-dir <dir> [--out bundle.sqlite] [--priors priors.json] [--classes classes.json]
```

## Reading it

- `openBundle(path)` — the low-level reader: `get` / `getByDescription` / `search` / `shapePrior` / `count` / `close`.
- **`openNutrientStore(path, { aliases })`** (`etl/nutrient-store.mjs`) — the **pipeline adapter**. It implements `@ppe/pipeline`'s `NutrientStore`: `lookup(label)` resolves a food (caller alias map → exact `description` → full-text best hit) and returns a `FoodRecord` (per-100 g nutrients, density, shape), or `null` on no match — the pipeline's "never invent nutrition" rule. This is the Node reference implementation the on-device expo-sqlite adapter mirrors.

## Tasks

- [x] Download + parse FDC CSVs (Foundation, SR Legacy, FNDDS incl. `food_portion`)
- [x] Derive densities from volumetric portions (MATH.md §5); tag each with `density_source`
- [x] Emit `shape_priors` (κ/φ/h̄); ingest fitted `priors.json`
- [x] Reference `NutrientStore` over the bundle + tests (exact / FTS / alias resolution, null-on-miss, density→mass→nutrition)
- [x] Ship the built bundle as an app asset + implement the on-device expo-sqlite `NutrientStore` — the **full** bundle ships (13.7k foods + curated overlay, `starter/build-full.mjs`)
- [ ] Merge FAO/INFOODS densities; manual review of the top ~200 classes
- [ ] **Class taxonomy**: map classifier labels → food classes → FDC rows (the label↔row join table is the quality-critical artifact; the store already accepts it as `aliases`) — until then the curated overlay rows carry the vocabulary
