---
tags: [ppe, codebase, data]
---

# Nutrition Database

> `@ppe/nutrition-etl` — the build step that turns USDA FoodData Central CSVs into a single on‑device SQLite bundle carrying per‑100 g nutrients and a derived density per food. This is the pipeline's final "RESOLVE" stage. Code: `nutrition/`. Spec: [[MODELS]] §5, [[Math 4 - Volume Mass and Nutrients]] §5–6.

## What it builds and why

The `COMPOSE` step of the pipeline needs two things per food: its **density** (to turn measured volume into grams) and its **per‑100 g nutrients** (to turn grams into calories/macros/micros). Both come from a **single SQLite file** built offline from public USDA data and shipped as an app asset. It's an **ETL** ([[CS Foundations]] §8): Extract the CSVs → Transform → Load into SQLite. Zero dependencies — it uses **Node's built‑in `node:sqlite`** (hence the repo's Node ≥ 22.5 requirement) and a hand‑rolled CSV parser, so nothing needs installing.

## The inputs

USDA [FoodData Central](https://fdc.nal.usda.gov/) CSV exports (CC0 — public domain), restricted to the three **generic** datasets: `foundation_food`, `sr_legacy_food`, `survey_fndds_food`. Branded foods are deliberately excluded. Five files are read: `food.csv` (names + type), `food_nutrient.csv` (the values), `food_portion.csv` + `measure_unit.csv` (for densities). (`nutrient.csv` is *not* read — the nutrient‑id→column mapping is hardcoded.)

## The transform, step by step (`etl/build-bundle.mjs`)

1. **Filter foods** to the three generic data types; keep their `fdc_id`s.
2. **Assemble per‑100 g nutrients.** FDC already stores amounts per 100 g, so each tracked `nutrient_id` maps straight into a column via the constant `NUTRIENT_COLUMNS`: energy (1008), protein/carbs/fat (1003/1005/1004), and the 7 micros (fiber, sugar, sat‑fat, sodium, cholesterol, potassium, calcium, iron). Untracked nutrients and negatives are dropped.
3. **Derive densities** (below).
4. **Write SQLite** in one transaction.

### Density derivation — the "1 cup rice = 158 g → 0.67 g/mL" logic

This is the FDC/FNDDS secondary density source of [[Math 4 - Volume Mass and Nutrients]] §5. For each food portion whose unit is **volumetric** (cup, tablespoon, teaspoon, fl oz, liter, mL — via a `MEASURE_ML` lookup):

$$\rho = \frac{\text{gram\_weight}}{\text{mlPerUnit}\times\text{amount}}$$

Worked from the fixtures: rice, 1 cup → 158 g → $158 / (236.588\times1) =$ **0.668 g/mL** — the exact MATH.md example. Non‑volumetric portions (a "medium" banana) yield no density and are skipped. Values are clamped to a plausible **[0.05, 2.0] g/mL** (parse‑error guard), and a food with several volumetric portions takes the **median** ([[CS Foundations]] §5). Each derived density is tagged `density_source = "fdc_portion"` for auditability — the column exists so a future FAO/INFOODS merge can carry a different source tag.

## The SQLite schema (what actually ships)

Four tables. **`foods`** (PRIMARY KEY `fdc_id`): `description`, `data_type`, the `*100` nutrient columns (`kcal100`, `protein100`, …, `iron100`), plus `density_g_per_ml` and `density_source` (both nullable). **`shape_priors`** (`class, kind, kappa, phi, h_bar_m, samples, source`): κ/φ/h̄ per class ([[Math 4 - Volume Mass and Nutrients]]), seeded from `priors.json` when built with `--priors`, else a single mound `_global` default (the Nutrition5k fit: κ=0.1687, φ=0.446, h̄=0.098 m). **`meta`** records `generated_at`, `data_types`, `fts`, `source`. And a **full‑text search** index `foods_fts` (SQLite FTS5, external‑content over `description`) — wrapped in a try/catch so builds without fts5 fall back to `LIKE`. `openBundle()` is the low‑level reader (`get`, `getByDescription`, `search`, `shapePrior`, `count`).

## The CLI

```
node etl/cli.mjs --fdc-dir <dir-with-the-5-csvs> [--out nutrient-bundle.sqlite] [--priors priors.json]
```
(or `npm run etl:bundle -- --fdc-dir <dir>`). It prints `N foods, M with portion-derived density, K shape priors, fts=<bool>`.

## How it connects to the pipeline

The pipeline's `NutrientStore.lookup(label)` returns a `FoodRecord { label, per100, densityGPerMl, shape }` ([[The Pipeline]]). The bundle's columns line up one‑to‑one: `kcal100`→`per100.kcal`, `density_g_per_ml`→`densityGPerMl`, `description`→`label`, the micro columns→`per100.micros`, and the `_global` `shape_priors` row→`shape`. **`openNutrientStore(path, { aliases })`** (`etl/nutrient-store.mjs`) is the concrete `NutrientStore` doing exactly this — resolving a label (alias map → exact description → full‑text best hit) to a `FoodRecord`, or `null` on a miss. The estimator then uses two things downstream: `massG(volumeMl, densityGPerMl)` and `nutrientsForMassG(per100, mass)` — the bundle feeds precisely the [[Math 4 - Volume Mass and Nutrients]] §5–6 math.

## What's done, what's left

- ✅ **Schema + reference store shipped.** The `shape_priors` table and a concrete Node `NutrientStore` (`openNutrientStore`) now exist, tested for resolution, density→mass→nutrition, and the null‑on‑miss rule. `nutrition/README.md` is reconciled with the shipped schema.
- ✅ **On‑device adapter shipped.** `ExpoSqliteNutrientStore` (`apps/demo/src/nutrient-store.ts`) mirrors the Node store over **expo‑sqlite** and is wired into the demo, reading a bundled SQLite DB — real USDA nutrition, not the old single mock. A 12‑food **starter** bundle ships (`nutrition/starter/build-starter.mjs`); the full FDC bundle is `npm run etl:bundle`. Guide: `docs/REAL_ADAPTERS.md`.
- ⬜ **Per‑food shape class.** Every food currently uses the `_global` prior; a per‑food *class* map (plus the fitted per‑class κ/φ/h̄ from [[Shape Priors and Nutrition5k]]) will refine it.
- ⬜ **Label → FDC‑row map.** The store accepts a curated `aliases` map (the "quality‑critical artifact"); building the real one is pending.

The "never invent nutrition" contract holds throughout — `lookup` returns `null` on a miss and the estimator emits null nutrients rather than fabricating them.

## Related
- [[The Pipeline]] · [[Math 4 - Volume Mass and Nutrients]] · [[Shape Priors and Nutrition5k]] · [[Testing]] · [[MODELS]] · [[Roadmap and Next Steps]]
