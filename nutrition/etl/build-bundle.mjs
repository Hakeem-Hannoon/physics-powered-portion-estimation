import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { csvRecords } from "./csv.mjs";

/**
 * Builds the on-device nutrient bundle from USDA FoodData Central CSV
 * exports (https://fdc.nal.usda.gov/download-datasets/ — CC0).
 *
 * Inputs (in `fdcDir`): food.csv, nutrient.csv, food_nutrient.csv,
 * food_portion.csv, measure_unit.csv.
 *
 * Output: one SQLite file with per-100 g energy/macros/micros and a density
 * (g/mL) derived from volumetric FNDDS portion weights where available
 * (MATH.md §5). FDC documentation flags portion-derived densities as
 * approximate, so each carries a `density_source` for auditability.
 *
 * Also emits a `shape_priors` table (κ/φ/h̄ per food class, MATH.md §4): seeded
 * from priors.json (model/priors/fit_priors.py) when passed, else a single
 * mound default that matches the pipeline's placeholder. Consumed by
 * openNutrientStore in ./nutrient-store.mjs.
 */

/** FDC nutrient.id → bundle column. */
const NUTRIENT_COLUMNS = {
  1008: "kcal100",
  1003: "protein100",
  1005: "carbs100",
  1004: "fat100",
  1079: "fiber100",
  2000: "sugar100",
  1258: "satfat100",
  1093: "sodium100",
  1253: "cholesterol100",
  1092: "potassium100",
  1087: "calcium100",
  1089: "iron100",
};

/** Volumetric household measures and their milliliters (US customary). */
const MEASURE_ML = {
  cup: 236.588,
  tablespoon: 14.787,
  teaspoon: 4.929,
  "fl oz": 29.574,
  liter: 1000,
  milliliter: 1,
};

const DENSITY_MIN = 0.05;
const DENSITY_MAX = 2.0;

const DEFAULT_DATA_TYPES = ["foundation_food", "sr_legacy_food", "survey_fndds_food"];

/**
 * Default global shape prior when no priors.json is passed — fit from Nutrition5k
 * (model/priors/fit_priors.py, n=3484). Matches the pipeline's DEFAULT_KAPPA /
 * DEFAULT_MOUND_PHI (packages/pipeline/src/estimate.ts). Pass --priors to
 * override, per class (MATH.md §4b/§4c).
 */
const DEFAULT_GLOBAL_PRIOR = { kind: "mound", kappa: 0.1687, phi: 0.446, h_bar_m: 0.0979, samples: 3484 };

/**
 * Per-*class* shape priors seeded when the Nutrition5k per-class fit isn't
 * available yet (fit_priors.py needs per-class labels — a roadmap item). Values
 * follow MATH.md §4: `mound` = the global fit; `flat` foods (bread, pizza) fill
 * their footprint as a thin slab (φ≈1) with a fixed thickness h̄; `container`
 * (bowls, cups) is flagged and handled by the solid-of-revolution route. A
 * per-class entry passed in `priors` (from fit_priors.py) overrides these.
 */
const DEFAULT_CLASS_PRIORS = {
  mound: { kind: "mound", kappa: 0.1687, phi: 0.446, h_bar_m: 0.0979 },
  flat: { kind: "flat", kappa: 0.05, phi: 1.0, h_bar_m: 0.015 },
  container: { kind: "container", kappa: 0.25, phi: 0.5, h_bar_m: 0.05 },
};

const normalizeDesc = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

export function buildBundle({ fdcDir, out, dataTypes = DEFAULT_DATA_TYPES, priors = null, foodClasses = {} }) {
  // Normalize the food → shape-class map keys once for case-insensitive lookup.
  const classByDesc = new Map(
    Object.entries(foodClasses).map(([desc, cls]) => [normalizeDesc(desc), cls]),
  );
  const read = (name) => csvRecords(readFileSync(join(fdcDir, name), "utf8"));

  const foods = read("food.csv").filter((f) => dataTypes.includes(f.data_type));
  const keep = new Set(foods.map((f) => f.fdc_id));

  const nutrientRows = read("food_nutrient.csv").filter((r) => keep.has(r.fdc_id));
  const measureUnits = new Map(read("measure_unit.csv").map((m) => [m.id, m.name]));
  const portionRows = read("food_portion.csv").filter((r) => keep.has(r.fdc_id));

  // fdc_id → column → per-100 g amount
  const nutrientsByFood = new Map();
  for (const row of nutrientRows) {
    const column = NUTRIENT_COLUMNS[Number(row.nutrient_id)];
    if (!column) continue;
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount < 0) continue;
    let cols = nutrientsByFood.get(row.fdc_id);
    if (!cols) nutrientsByFood.set(row.fdc_id, (cols = {}));
    cols[column] = amount;
  }

  // fdc_id → densities derived from volumetric portions
  const densitiesByFood = new Map();
  for (const row of portionRows) {
    const unit = (measureUnits.get(row.measure_unit_id) ?? "").toLowerCase();
    const mlPerUnit = MEASURE_ML[unit];
    if (!mlPerUnit) continue;
    const amount = Number(row.amount);
    const gramWeight = Number(row.gram_weight);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    if (!Number.isFinite(gramWeight) || gramWeight <= 0) continue;
    const rho = gramWeight / (mlPerUnit * amount);
    if (rho < DENSITY_MIN || rho > DENSITY_MAX) continue;
    const list = densitiesByFood.get(row.fdc_id) ?? [];
    list.push(rho);
    densitiesByFood.set(row.fdc_id, list);
  }

  // A bundle build fully REPLACES its output; drop any stale file (+ WAL
  // sidecars) so a schema change isn't silently blocked by CREATE TABLE IF NOT
  // EXISTS keeping the old columns.
  rmSync(out, { force: true });
  rmSync(`${out}-wal`, { force: true });
  rmSync(`${out}-shm`, { force: true });

  const db = new DatabaseSync(out);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS foods (
      fdc_id INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      data_type TEXT NOT NULL,
      kcal100 REAL, protein100 REAL, carbs100 REAL, fat100 REAL,
      fiber100 REAL, sugar100 REAL, satfat100 REAL,
      sodium100 REAL, cholesterol100 REAL, potassium100 REAL,
      calcium100 REAL, iron100 REAL,
      density_g_per_ml REAL,
      density_source TEXT,
      shape_class TEXT
    );
    CREATE TABLE IF NOT EXISTS shape_priors (
      class TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      kappa REAL,
      phi REAL,
      h_bar_m REAL,
      samples INTEGER,
      source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  let fts = true;
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS foods_fts USING fts5(description, content='foods', content_rowid='fdc_id')",
    );
  } catch {
    fts = false;
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO foods (
      fdc_id, description, data_type,
      kcal100, protein100, carbs100, fat100,
      fiber100, sugar100, satfat100,
      sodium100, cholesterol100, potassium100, calcium100, iron100,
      density_g_per_ml, density_source, shape_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = fts
    ? db.prepare("INSERT INTO foods_fts (rowid, description) VALUES (?, ?)")
    : null;

  let withDensity = 0;
  db.exec("BEGIN");
  for (const food of foods) {
    const cols = nutrientsByFood.get(food.fdc_id) ?? {};
    const densities = (densitiesByFood.get(food.fdc_id) ?? []).sort((a, b) => a - b);
    const median = densities.length
      ? densities[Math.floor(densities.length / 2)]
      : null;
    if (median !== null) withDensity++;
    insert.run(
      Number(food.fdc_id),
      food.description,
      food.data_type,
      cols.kcal100 ?? null,
      cols.protein100 ?? null,
      cols.carbs100 ?? null,
      cols.fat100 ?? null,
      cols.fiber100 ?? null,
      cols.sugar100 ?? null,
      cols.satfat100 ?? null,
      cols.sodium100 ?? null,
      cols.cholesterol100 ?? null,
      cols.potassium100 ?? null,
      cols.calcium100 ?? null,
      cols.iron100 ?? null,
      median,
      median !== null ? "fdc_portion" : null,
      classByDesc.get(normalizeDesc(food.description)) ?? null,
    );
    insertFts?.run(Number(food.fdc_id), food.description);
  }

  // Shape priors (κ/φ/h̄ per class, MATH.md §4). From priors.json when supplied,
  // else a single mound default matching the pipeline placeholder. Foods map to
  // the `_global` prior until a per-food class table exists (roadmap).
  const insertShape = db.prepare(
    "INSERT OR REPLACE INTO shape_priors (class, kind, kappa, phi, h_bar_m, samples, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const writtenClasses = new Set();
  let shapePriors = 0;
  for (const [cls, p] of Object.entries(priors ?? {})) {
    insertShape.run(
      cls,
      p.kind ?? "mound",
      p.kappa ?? null,
      p.phi ?? null,
      p.h_bar_m ?? null,
      p.samples ?? null,
      "nutrition5k_fit",
    );
    writtenClasses.add(cls);
    shapePriors++;
  }
  // Seed the per-class defaults (mound/flat/container) the fit didn't provide —
  // but only when foods actually carry classes, so a classless bundle keeps just
  // `_global` (the store falls back to it anyway). MATH.md §4.
  if (classByDesc.size > 0) {
    for (const [cls, p] of Object.entries(DEFAULT_CLASS_PRIORS)) {
      if (writtenClasses.has(cls)) continue;
      insertShape.run(cls, p.kind, p.kappa ?? null, p.phi ?? null, p.h_bar_m ?? null, null, "default");
      writtenClasses.add(cls);
      shapePriors++;
    }
  }
  if (!writtenClasses.has("_global")) {
    const g = DEFAULT_GLOBAL_PRIOR;
    insertShape.run("_global", g.kind, g.kappa, g.phi, g.h_bar_m, g.samples, "default");
    shapePriors++;
  }

  const setMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
  setMeta.run("generated_at", new Date().toISOString());
  setMeta.run("data_types", dataTypes.join(","));
  setMeta.run("fts", fts ? "1" : "0");
  setMeta.run("source", "USDA FoodData Central (CC0)");
  db.exec("COMMIT");
  db.close();

  return { foods: foods.length, withDensity, shapePriors, fts };
}

/** Read access to a built bundle — mirrors what the app queries on device. */
export function openBundle(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const hasFts = db.prepare("SELECT value FROM meta WHERE key = 'fts'").get()?.value === "1";
  // Older bundles predate shape_priors; degrade gracefully rather than throw.
  let hasShape = true;
  try {
    db.prepare("SELECT 1 FROM shape_priors LIMIT 1").get();
  } catch {
    hasShape = false;
  }
  const byId = db.prepare("SELECT * FROM foods WHERE fdc_id = ?");
  const byDesc = db.prepare("SELECT * FROM foods WHERE description = ? COLLATE NOCASE LIMIT 1");
  const byFts = hasFts
    ? db.prepare(
        "SELECT f.* FROM foods_fts JOIN foods f ON f.fdc_id = foods_fts.rowid WHERE foods_fts MATCH ? ORDER BY rank LIMIT ?",
      )
    : null;
  const byLike = db.prepare(
    "SELECT * FROM foods WHERE description LIKE ? ORDER BY length(description) LIMIT ?",
  );
  const byShape = hasShape ? db.prepare("SELECT * FROM shape_priors WHERE class = ?") : null;
  return {
    count: () => db.prepare("SELECT COUNT(*) AS n FROM foods").get().n,
    get: (fdcId) => byId.get(fdcId) ?? null,
    getByDescription: (description) => byDesc.get(String(description)) ?? null,
    search: (term, limit = 10) =>
      byFts ? byFts.all(term, limit) : byLike.all(`%${term}%`, limit),
    shapePrior: (className) => byShape?.get(className) ?? null,
    close: () => db.close(),
  };
}
