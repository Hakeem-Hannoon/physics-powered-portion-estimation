import { ZodError } from "zod";
import { describe, expect, it } from "vitest";
import {
  type EstimateItem,
  type EstimateResult,
  type FoodRecord,
  recomputeTotals,
  relabelItem,
  rescaleItemToMass,
  withEditedItem,
} from "../src/index";

const rice = (): EstimateItem => ({
  label: "white rice, cooked",
  confidence: 0.86,
  geometry: { area_cm2: 100, height_cm: null, volume_ml: 240, method: "shape_prior" },
  mass_g: 160,
  kcal: 208,
  protein_g: 4.3,
  carbs_g: 45,
  fat_g: 0.5,
  micros: { potassiumMg: 55, fiberG: 0.6 },
  flags: [],
});

const broccoli = (): EstimateItem => ({
  ...rice(),
  label: "broccoli, cooked",
  mass_g: 90,
  kcal: 50,
  protein_g: 4,
  carbs_g: 10,
  fat_g: 0.5,
  micros: { potassiumMg: 300, fiberG: 2.4 },
});

const chicken: FoodRecord = {
  label: "chicken breast, cooked",
  per100: { kcal: 165, proteinG: 31, carbsG: 0, fatG: 3.6, micros: { potassiumMg: 256 } },
  densityGPerMl: 1.05,
  shape: { kind: "mound", kappa: 0.55 },
};

describe("rescaleItemToMass", () => {
  it("scales nutrition linearly with the new mass and keeps the measured geometry", () => {
    const edited = rescaleItemToMass(rice(), 320); // ×2
    expect(edited.mass_g).toBe(320);
    expect(edited.kcal).toBe(416);
    expect(edited.protein_g).toBe(8.6);
    expect(edited.carbs_g).toBe(90);
    expect(edited.fat_g).toBe(1);
    expect(edited.micros!.potassiumMg).toBe(110);
    expect(edited.micros!.fiberG).toBeCloseTo(1.2, 5);
    // the measurement is untouched — only the mass was corrected
    expect(edited.geometry.volume_ml).toBe(240);
    expect(edited.flags).toContain("portion_edited");
  });

  it("only sets the mass on an item with no database match (nutrition stays null)", () => {
    const unknown: EstimateItem = {
      ...rice(),
      mass_g: null,
      kcal: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      micros: null,
      flags: ["no_db_match"],
    };
    const edited = rescaleItemToMass(unknown, 200);
    expect(edited.mass_g).toBe(200);
    expect(edited.kcal).toBeNull();
    expect(edited.flags).toEqual(["no_db_match", "portion_edited"]);
  });

  it("rejects a negative mass", () => {
    expect(() => rescaleItemToMass(rice(), -5)).toThrow();
  });
});

describe("relabelItem", () => {
  it("re-derives mass and nutrition from the new food on the measured volume", () => {
    const edited = relabelItem(rice(), chicken); // 240 mL × 1.05 = 252 g
    expect(edited.label).toBe("chicken breast, cooked");
    expect(edited.confidence).toBe(1); // user chose it
    expect(edited.mass_g).toBe(252);
    expect(edited.kcal).toBe(416); // 165 × 2.52
    expect(edited.protein_g).toBe(78.1);
    expect(edited.micros!.potassiumMg).toBe(645);
    // measured geometry preserved (renaming doesn't change the volume on the plate)
    expect(edited.geometry.volume_ml).toBe(240);
    expect(edited.geometry.method).toBe("shape_prior");
    expect(edited.flags).toContain("label_edited");
    expect(edited.flags).not.toContain("atwater_mismatch");
  });

  it("clears a stale no_db_match when a previously-unknown item is relabeled", () => {
    const unknown: EstimateItem = { ...rice(), flags: ["no_db_match", "low_confidence"] };
    const edited = relabelItem(unknown, chicken);
    expect(edited.flags).not.toContain("no_db_match");
    expect(edited.flags).not.toContain("low_confidence");
    expect(edited.flags).toContain("label_edited");
  });

  it("flags an Atwater mismatch when the new food's numbers are inconsistent", () => {
    const bad: FoodRecord = {
      label: "mislabeled thing",
      per100: { kcal: 500, proteinG: 2.7, carbsG: 28, fatG: 0.3 }, // 4·2.7+4·28+9·0.3 ≈ 125 ≠ 500
      densityGPerMl: 0.67,
      shape: { kind: "mound" },
    };
    expect(relabelItem(rice(), bad).flags).toContain("atwater_mismatch");
  });

  it("never invents nutrition when the new label has no match", () => {
    const edited = relabelItem(rice(), null, "grandma's mystery stew");
    expect(edited.label).toBe("grandma's mystery stew");
    expect(edited.confidence).toBe(1);
    expect(edited.mass_g).toBeNull();
    expect(edited.kcal).toBeNull();
    expect(edited.micros).toBeNull();
    expect(edited.flags).toEqual(expect.arrayContaining(["label_edited", "no_db_match"]));
  });
});

describe("recomputeTotals", () => {
  it("sums per-item nutrition, treating null (unmatched) items as zero", () => {
    const unmatched: EstimateItem = {
      ...rice(),
      mass_g: null,
      kcal: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
      micros: null,
    };
    const totals = recomputeTotals([rice(), broccoli(), unmatched]);
    expect(totals.kcal).toBe(258); // 208 + 50
    expect(totals.protein_g).toBe(8.3);
    expect(totals.carbs_g).toBe(55);
    expect(totals.fat_g).toBe(1);
    expect(totals.micros.potassiumMg).toBe(355); // 55 + 300
    expect(totals.micros.fiberG).toBe(3); // 0.6 + 2.4
  });
});

describe("withEditedItem", () => {
  const result = (): EstimateResult => ({
    items: [rice(), broccoli()],
    totals: recomputeTotals([rice(), broccoli()]),
    quality: {
      scale_source: "ruler",
      ruler_residual_mm: 2.1,
      est_relative_error: 0.207,
      camera_height_m: 0.45,
    },
  });

  it("replaces an item and recomputes the meal totals", () => {
    const r = result();
    const edited = withEditedItem(r, 0, rescaleItemToMass(r.items[0]!, 320));
    expect(edited.items[0]!.kcal).toBe(416);
    expect(edited.items[1]!.kcal).toBe(50); // untouched
    expect(edited.totals.kcal).toBe(466); // 416 + 50
    // quality is carried through unchanged
    expect(edited.quality.est_relative_error).toBe(0.207);
  });

  it("re-validates the output contract, so a bad edit throws", () => {
    const r = result();
    const invalid: EstimateItem = { ...rice(), confidence: 2 }; // > 1 violates the schema
    expect(() => withEditedItem(r, 0, invalid)).toThrow(ZodError);
  });

  it("throws on an out-of-range index", () => {
    expect(() => withEditedItem(result(), 9, rice())).toThrow();
  });
});
