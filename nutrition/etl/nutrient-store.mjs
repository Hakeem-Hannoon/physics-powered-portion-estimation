import { openBundle } from "./build-bundle.mjs";

/**
 * A concrete `NutrientStore` (packages/pipeline/src/adapters.ts) backed by the
 * SQLite bundle, on Node's built-in sqlite. This is the reference the on-device
 * expo-sqlite adapter mirrors: `lookup(label)` resolves a food and returns a
 * `FoodRecord { label, per100, densityGPerMl, shape }`, or `null` on no match —
 * the pipeline's "never invent nutrition" rule (estimate.ts).
 *
 * Resolution order (label → food row):
 *   1. a caller-supplied alias map — the curated classifier-label → FDC-row
 *      mapping (STATUS.md's "quality-critical data artifact"); value is an
 *      fdc_id (number) or an alternate search term (string);
 *   2. a case-insensitive exact `description` match;
 *   3. a full-text best hit over `description`.
 */

/** foods column → NutrientsPer100g.micros key (MATH.md §6, energy.ts). */
const MICRO_COLUMNS = {
  fiber100: "fiberG",
  sugar100: "sugarG",
  satfat100: "satFatG",
  sodium100: "sodiumMg",
  cholesterol100: "cholesterolMg",
  potassium100: "potassiumMg",
  calcium100: "calciumMg",
  iron100: "ironMg",
};

/** Used only if the bundle has no shape_priors table (a pre-priors bundle);
 *  the Nutrition5k global fit, matching the pipeline's DEFAULT_KAPPA. */
const FALLBACK_SHAPE = { kind: "mound", kappa: 0.1687, phi: 0.446, hBarM: 0.0979 };
/** Water; used only when FDC lists no volumetric portion, so mass = ρV still works. */
const FALLBACK_DENSITY_G_PER_ML = 1.0;

const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
/** FTS5 MATCH chokes on punctuation — reduce a label to bare word tokens. */
const ftsQuery = (s) => normalize(s).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function shapeFromPrior(row) {
  if (!row) return { ...FALLBACK_SHAPE };
  const shape = { kind: row.kind ?? "mound" };
  if (row.kappa != null) shape.kappa = row.kappa;
  if (row.phi != null) shape.phi = row.phi;
  if (row.h_bar_m != null) shape.hBarM = row.h_bar_m;
  return shape;
}

function toFoodRecord(row, shape) {
  const micros = {};
  for (const [col, key] of Object.entries(MICRO_COLUMNS)) {
    if (row[col] != null) micros[key] = row[col];
  }
  return {
    label: row.description,
    per100: {
      kcal: row.kcal100 ?? 0,
      proteinG: row.protein100 ?? 0,
      carbsG: row.carbs100 ?? 0,
      fatG: row.fat100 ?? 0,
      micros,
    },
    densityGPerMl: row.density_g_per_ml ?? FALLBACK_DENSITY_G_PER_ML,
    shape,
  };
}

export function openNutrientStore(path, { aliases = {} } = {}) {
  const bundle = openBundle(path);
  // Per-food shape class (MATH.md §4): each food row carries a `shape_class`;
  // resolve it to that class's prior, falling back to `_global` when the food has
  // no class or the class has no row. Cached — the priors table is tiny.
  const globalShape = shapeFromPrior(bundle.shapePrior?.("_global"));
  const shapeCache = new Map();
  const shapeForClass = (cls) => {
    if (!cls) return globalShape;
    if (shapeCache.has(cls)) return shapeCache.get(cls);
    const row = bundle.shapePrior?.(cls) ?? null;
    const resolved = row ? shapeFromPrior(row) : globalShape;
    shapeCache.set(cls, resolved);
    return resolved;
  };

  return {
    async lookup(label) {
      if (!label) return null;
      const alias = aliases[normalize(label)];
      const term = typeof alias === "string" ? alias : label;

      let row = typeof alias === "number" ? bundle.get(alias) : null;
      if (!row) row = bundle.getByDescription(term); // exact (case-insensitive)
      if (!row) {
        const q = ftsQuery(term);
        row = q ? (bundle.search(q, 1)[0] ?? null) : null; // full-text best hit
      }
      return row ? toFoodRecord(row, { ...shapeForClass(row.shape_class) }) : null;
    },
    close: () => bundle.close(),
  };
}
