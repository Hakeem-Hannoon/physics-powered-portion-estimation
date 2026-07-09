/**
 * Builds a small *starter* nutrient bundle of common foods for the demo app, so
 * `apps/demo` shows REAL USDA nutrition (not the single hard-coded mock) without
 * the 181 GB FoodData Central download. Values here are standard USDA reference
 * per-100 g figures (SR Legacy / FNDDS, CC0) for widely-eaten foods — a curated
 * subset, NOT invented: the production bundle is built from the full FDC export
 * (see nutrition/README.md and `npm run etl:bundle`).
 *
 *   node nutrition/starter/build-starter.mjs --out apps/demo/assets/nutrients.sqlite
 *
 * The foods are defined below as plain objects; this script writes them out in
 * FDC CSV shape to a temp dir and runs the SAME buildBundle() the real ETL uses,
 * so the on-device schema is identical. Density is portion-derived where a
 * volumetric measure is given (MATH.md §5); omitted nutrients stay null.
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildBundle } from "../etl/build-bundle.mjs";

// nutrient_id → USDA definition (only the ones the bundle stores).
const NUTRIENTS = [
  [1008, "Energy", "KCAL"],
  [1003, "Protein", "G"],
  [1005, "Carbohydrate, by difference", "G"],
  [1004, "Total lipid (fat)", "G"],
  [1079, "Fiber, total dietary", "G"],
  [2000, "Sugars, total", "G"],
  [1258, "Fatty acids, total saturated", "G"],
  [1093, "Sodium, Na", "MG"],
  [1253, "Cholesterol", "MG"],
  [1092, "Potassium, K", "MG"],
  [1087, "Calcium, Ca", "MG"],
  [1089, "Iron, Fe", "MG"],
];

const MEASURE_UNITS = [
  [1000, "cup"],
  [1001, "medium"],
];

// Per-100 g values keyed by nutrient_id; `cupG` = grams in one US cup (density).
// Standard USDA SR Legacy / FNDDS reference values for common cooked/raw foods.
const FOODS = [
  { id: 1001, type: "survey_fndds_food", desc: "Rice, white, cooked",
    n: { 1008: 130, 1003: 2.69, 1005: 28.17, 1004: 0.28, 1092: 35 }, cupG: 158 },
  { id: 1002, type: "sr_legacy_food", desc: "Banana, raw",
    n: { 1008: 89, 1003: 1.09, 1005: 22.84, 1004: 0.33, 1079: 2.6, 2000: 12.23, 1092: 358 } },
  { id: 1003, type: "sr_legacy_food", desc: "Chicken breast, cooked, roasted",
    n: { 1008: 165, 1003: 31.02, 1005: 0, 1004: 3.57, 1093: 74, 1253: 85, 1092: 256 } },
  { id: 1004, type: "sr_legacy_food", desc: "Broccoli, cooked, boiled",
    n: { 1008: 35, 1003: 2.38, 1005: 7.18, 1004: 0.41, 1079: 3.3, 2000: 1.39, 1093: 41, 1092: 293, 1087: 40 }, cupG: 156 },
  { id: 1005, type: "sr_legacy_food", desc: "Egg, whole, cooked, hard-boiled",
    n: { 1008: 155, 1003: 12.58, 1005: 1.12, 1004: 10.61, 1093: 124, 1253: 373, 1092: 126, 1087: 50, 1089: 1.19 } },
  { id: 1006, type: "sr_legacy_food", desc: "Apple, raw, with skin",
    n: { 1008: 52, 1003: 0.26, 1005: 13.81, 1004: 0.17, 1079: 2.4, 2000: 10.39, 1092: 107 }, cupG: 109 },
  { id: 1007, type: "sr_legacy_food", desc: "Salmon, Atlantic, cooked",
    n: { 1008: 206, 1003: 22.1, 1005: 0, 1004: 12.35, 1093: 61, 1253: 63, 1092: 384 } },
  { id: 1008, type: "sr_legacy_food", desc: "Pasta, cooked, enriched",
    n: { 1008: 158, 1003: 5.8, 1005: 30.86, 1004: 0.93, 1093: 1, 1092: 44, 1089: 1.28 }, cupG: 140 },
  { id: 1009, type: "sr_legacy_food", desc: "Potato, baked, flesh and skin",
    n: { 1008: 93, 1003: 2.5, 1005: 21.15, 1004: 0.13, 1079: 2.2, 1093: 10, 1092: 535, 1087: 15, 1089: 1.08 } },
  { id: 1010, type: "sr_legacy_food", desc: "Ground beef, 85% lean, cooked",
    n: { 1008: 250, 1003: 26.0, 1005: 0, 1004: 15.0, 1258: 5.85, 1093: 72, 1253: 86, 1092: 318, 1089: 2.66 } },
  { id: 1011, type: "sr_legacy_food", desc: "Almonds, raw",
    n: { 1008: 579, 1003: 21.15, 1005: 21.55, 1004: 49.93, 1079: 12.5, 2000: 4.35, 1258: 3.8, 1092: 733, 1087: 269, 1089: 3.71 }, cupG: 143 },
  { id: 1012, type: "sr_legacy_food", desc: "Bread, white, commercial",
    n: { 1008: 267, 1003: 7.64, 1005: 49.2, 1004: 3.29, 1079: 2.4, 2000: 5.34, 1258: 0.72, 1093: 490, 1092: 115, 1087: 151, 1089: 3.74 } },
];

const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
const csv = (header, rows) =>
  [header.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\n") + "\n";

function writeFixtures(dir) {
  writeFileSync(join(dir, "measure_unit.csv"), csv(["id", "name"], MEASURE_UNITS));
  writeFileSync(
    join(dir, "nutrient.csv"),
    csv(["id", "name", "unit_name", "nutrient_nbr", "rank"], NUTRIENTS.map(([id, name, unit]) => [id, name, unit, "", ""])),
  );
  writeFileSync(
    join(dir, "food.csv"),
    csv(["fdc_id", "data_type", "description", "food_category_id", "publication_date"],
      FOODS.map((f) => [f.id, f.type, f.desc, "", "2024-10-31"])),
  );
  let fnId = 1;
  const fnRows = [];
  for (const f of FOODS) {
    for (const [nid, amount] of Object.entries(f.n)) {
      fnRows.push([fnId++, f.id, nid, amount, "", "", "", "", "", "", ""]);
    }
  }
  writeFileSync(
    join(dir, "food_nutrient.csv"),
    csv(["id", "fdc_id", "nutrient_id", "amount", "data_points", "derivation_id", "min", "max", "median", "footnote", "min_year_acquired"], fnRows),
  );
  let pId = 1;
  const portionRows = [];
  for (const f of FOODS) {
    if (f.cupG) portionRows.push([pId++, f.id, "1", "1", "1000", "", "", f.cupG, "", "", ""]);
  }
  writeFileSync(
    join(dir, "food_portion.csv"),
    csv(["id", "fdc_id", "seq_num", "amount", "measure_unit_id", "portion_description", "modifier", "gram_weight", "data_points", "footnote", "min_year_acquired"], portionRows),
  );
}

const { values } = parseArgs({ options: { out: { type: "string", default: "apps/demo/assets/nutrients.sqlite" }, priors: { type: "string" } } });
const dir = mkdtempSync(join(tmpdir(), "ppe-starter-"));
writeFixtures(dir);
const priors = values.priors ? JSON.parse(readFileSync(values.priors, "utf8")) : null;
const stats = buildBundle({ fdcDir: dir, out: values.out, priors });
console.log(`starter bundle → ${values.out}: ${stats.foods} foods, ${stats.withDensity} with density, ${stats.shapePriors} shape priors, fts=${stats.fts}`);
