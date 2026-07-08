import { type Micros, atwaterDeviation, massG, nutrientsForMassG } from "@ppe/geometry";
import {
  type EstimateItem,
  type EstimateResult,
  estimateResultSchema,
} from "./contracts";
import type { FoodRecord } from "./adapters";

/**
 * Post-estimate edit helpers for the propose→confirm UX (docs/ARCHITECTURE.md
 * §2). The pipeline *proposes* an EstimateResult; the user corrects a portion or
 * a label before it's logged. These are pure functions — no models, no capture —
 * so an edited item is as testable as the original estimate.
 *
 * Nutrition is linear in mass (MATH.md §6), so a portion edit is an exact
 * rescale; a label change re-derives mass and nutrition from a new FoodRecord
 * applied to the *measured* volume (renaming a food changes its density and
 * nutrition, not the volume on the plate).
 */

const ATWATER_TOLERANCE = 0.15; // keep in sync with estimate.ts

const round = (x: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(x * f) / f;
};

const addFlag = (flags: string[], flag: string): string[] =>
  flags.includes(flag) ? flags : [...flags, flag];

const withoutFlags = (flags: string[], drop: string[]): string[] =>
  flags.filter((f) => !drop.includes(f));

// Micros are milligrams (…Mg) → 0 decimals, grams → 1 — matching estimate.ts.
const microPlaces = (key: string): number => (key.endsWith("Mg") ? 0 : 1);

const mapMicros = (
  micros: Micros | null | undefined,
  fn: (value: number, key: string) => number,
): Micros | null => {
  if (!micros) return micros ?? null;
  const out: Micros = {};
  for (const [key, value] of Object.entries(micros)) {
    if (typeof value === "number") out[key as keyof Micros] = fn(value, key);
  }
  return out;
};

/**
 * User overrides the portion mass (the grams slider). Nutrition rescales
 * linearly from the item's current values; the measured geometry is kept (the
 * volume was measured — the user is correcting the mass, not the measurement).
 * An item with no database match has no nutrition to scale, so only its mass is
 * set. Adds a `portion_edited` flag.
 */
export function rescaleItemToMass(item: EstimateItem, newMassG: number): EstimateItem {
  if (!(newMassG >= 0)) throw new Error("mass must be a non-negative number");
  const flags = addFlag(item.flags, "portion_edited");
  const mass = round(newMassG, 1);
  // Nothing to scale when the food never matched (mass/nutrition are null).
  if (item.mass_g == null || item.mass_g <= 0 || item.kcal == null) {
    return { ...item, mass_g: mass, flags };
  }
  const ratio = newMassG / item.mass_g;
  const scale = (v: number | null, places: number) => (v == null ? v : round(v * ratio, places));
  return {
    ...item,
    mass_g: mass,
    kcal: scale(item.kcal, 0),
    protein_g: scale(item.protein_g, 1),
    carbs_g: scale(item.carbs_g, 1),
    fat_g: scale(item.fat_g, 1),
    micros: mapMicros(item.micros, (v, k) => round(v * ratio, microPlaces(k))),
    flags,
  };
}

/**
 * User swaps the food label. Re-derives mass and nutrition from the new `record`
 * (looked up in a NutrientStore) applied to the item's *measured* volume.
 * `record: null` means the chosen label had no database match — nutrition
 * becomes null (never invented) and `no_db_match` is set. Confidence becomes 1
 * (the user chose it). Adds `label_edited`; clears the stale `no_db_match` /
 * `low_confidence` / `atwater_mismatch` flags. The measured geometry is kept.
 */
export function relabelItem(
  item: EstimateItem,
  record: FoodRecord | null,
  label?: string,
): EstimateItem {
  let flags = withoutFlags(item.flags, ["no_db_match", "low_confidence", "atwater_mismatch"]);
  flags = addFlag(flags, "label_edited");

  if (!record) {
    return {
      ...item,
      label: label ?? item.label,
      confidence: 1,
      mass_g: null,
      kcal: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      micros: null,
      flags: addFlag(flags, "no_db_match"),
    };
  }

  const mass = massG(item.geometry.volume_ml, record.densityGPerMl);
  const n = nutrientsForMassG(record.per100, mass);
  const deviation = atwaterDeviation(
    record.per100.kcal,
    record.per100.proteinG,
    record.per100.carbsG,
    record.per100.fatG,
  );
  if (deviation !== null && deviation > ATWATER_TOLERANCE) flags = addFlag(flags, "atwater_mismatch");

  return {
    ...item,
    label: label ?? record.label,
    confidence: 1,
    mass_g: round(mass, 1),
    kcal: round(n.kcal, 0),
    protein_g: round(n.proteinG, 1),
    carbs_g: round(n.carbsG, 1),
    fat_g: round(n.fatG, 1),
    micros: mapMicros(n.micros, (v, k) => round(v, microPlaces(k))),
    flags,
  };
}

/** Sum per-item nutrition into meal totals (matches estimate.ts's rounding). */
export function recomputeTotals(items: EstimateItem[]): EstimateResult["totals"] {
  const micros: Micros = {};
  let kcal = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  for (const item of items) {
    kcal += item.kcal ?? 0;
    protein += item.protein_g ?? 0;
    carbs += item.carbs_g ?? 0;
    fat += item.fat_g ?? 0;
    for (const [key, value] of Object.entries(item.micros ?? {})) {
      if (typeof value !== "number") continue;
      const mk = key as keyof Micros;
      micros[mk] = (micros[mk] ?? 0) + value;
    }
  }
  for (const [key, value] of Object.entries(micros)) {
    micros[key as keyof Micros] = Math.round((value as number) * 10) / 10;
  }
  return {
    kcal: Math.round(kcal),
    protein_g: Math.round(protein * 10) / 10,
    carbs_g: Math.round(carbs * 10) / 10,
    fat_g: Math.round(fat * 10) / 10,
    micros,
  };
}

/**
 * Replace one item in a result, recompute the meal totals, and re-validate the
 * whole result against the output contract — so an edit can never yield an
 * invalid EstimateResult. Compose with the item helpers, e.g.
 *   withEditedItem(result, i, rescaleItemToMass(result.items[i], grams))
 */
export function withEditedItem(
  result: EstimateResult,
  index: number,
  item: EstimateItem,
): EstimateResult {
  if (index < 0 || index >= result.items.length) throw new Error("item index out of range");
  const items = result.items.map((it, i) => (i === index ? item : it));
  return estimateResultSchema.parse({ ...result, items, totals: recomputeTotals(items) });
}
