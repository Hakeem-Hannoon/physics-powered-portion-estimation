/**
 * Emits the curated food set (./foods.mjs) as FDC-shaped CSV files, so the
 * SAME buildBundle() the real ETL uses can ingest it — the starter bundle
 * (build-starter.mjs) builds from these files alone, and the production
 * bundle (build-full.mjs) overlays them onto the full FDC export so the
 * demo's exact-description/alias resolution keeps working unchanged.
 *
 * The synthetic fdc_ids (1001…) sit far below real FDC ids (≥ ~167k), so the
 * overlay can never collide; measure id 1000 = "cup" matches the real FDC
 * measure_unit table, so the rows read identically either way.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FOODS } from "./foods.mjs";

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

const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
const csv = (header, rows) =>
  [header.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\n") + "\n";

/** Write the curated set as food/food_nutrient/food_portion/measure_unit/nutrient CSVs. */
export function writeStarterFixtures(dir) {
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

/**
 * Per-food shape class (MATH.md §4): most foods pile into a mound; slices and
 * fillets lie flat. Each food declares its class in foods.mjs; the store
 * resolves each food to its own prior.
 */
export const starterFoodClasses = () =>
  Object.fromEntries(FOODS.map((f) => [f.desc, f.shape]));
