import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBundle } from "../etl/build-bundle.mjs";
import { openNutrientStore } from "../etl/nutrient-store.mjs";

const fixtures = fileURLToPath(new URL("../fixtures", import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "ppe-store-"));
const bundlePath = join(workDir, "bundle.sqlite");

beforeAll(() => buildBundle({ fdcDir: fixtures, out: bundlePath }));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("SqliteNutrientStore", () => {
  it("resolves an exact food name to a full FoodRecord", async () => {
    const store = openNutrientStore(bundlePath);
    const rec = await store.lookup("Rice, white, cooked");
    expect(rec).not.toBeNull();
    expect(rec!.label).toBe("Rice, white, cooked");
    // per-100 g nutrients, renamed to the pipeline's field names (energy.ts)
    expect(rec!.per100.kcal).toBe(130);
    expect(rec!.per100.proteinG).toBeCloseTo(2.69, 2);
    expect(rec!.per100.micros!.potassiumMg).toBe(35);
    // density derived from the cup portion (MATH.md §5)
    expect(rec!.densityGPerMl).toBeCloseTo(0.668, 2);
    // shape = the default _global mound prior (the Nutrition5k fit, n=3484)
    expect(rec!.shape.kind).toBe("mound");
    expect(rec!.shape.kappa).toBe(0.1687);
    expect(rec!.shape.phi).toBe(0.446);
    expect(rec!.shape.hBarM).toBe(0.0979);
    store.close();
  });

  it("resolves by full-text search and is case-insensitive", async () => {
    const store = openNutrientStore(bundlePath);
    expect((await store.lookup("rice"))!.label).toBe("Rice, white, cooked"); // FTS/LIKE
    expect((await store.lookup("RICE, WHITE, COOKED"))!.label).toBe("Rice, white, cooked"); // exact, nocase
    store.close();
  });

  it("uses a caller alias map (the label → FDC-row artifact)", async () => {
    const store = openNutrientStore(bundlePath, { aliases: { "leftover rice": 1001 } });
    expect((await store.lookup("leftover rice"))!.label).toBe("Rice, white, cooked");
    store.close();
  });

  it("falls back to water density when FDC has no volumetric portion", async () => {
    const store = openNutrientStore(bundlePath);
    const banana = await store.lookup("Banana, raw");
    expect(banana!.densityGPerMl).toBe(1.0); // banana's "medium" portion has no volume
    expect(banana!.per100.micros!.potassiumMg).toBe(358);
    store.close();
  });

  it("returns null for an unknown food — never invents nutrition", async () => {
    const store = openNutrientStore(bundlePath);
    expect(await store.lookup("unobtanium soufflé")).toBeNull();
    expect(await store.lookup("")).toBeNull();
    store.close();
  });

  it("feeds the pipeline's mass→nutrition math end to end (MATH.md §5–6)", async () => {
    const store = openNutrientStore(bundlePath);
    const rec = (await store.lookup("rice"))!;
    // Exactly what estimate.ts does with a FoodRecord:
    //   mass_g = volume_ml * densityGPerMl     (geometry massG, MATH.md §5)
    //   kcal   = per100.kcal * mass_g / 100    (geometry nutrientsForMassG, §6)
    const volumeMl = 200;
    const massG = volumeMl * rec.densityGPerMl;
    expect(massG).toBeCloseTo(133.6, 1); // 200 mL × 0.668 g/mL
    expect((rec.per100.kcal * massG) / 100).toBeCloseTo(173.6, 1);
    expect((rec.per100.micros!.potassiumMg! * massG) / 100).toBeCloseTo(46.7, 1);
    store.close();
  });
});

describe("per-food shape class", () => {
  const classWorkDir = mkdtempSync(join(tmpdir(), "ppe-class-"));
  const classedPath = join(classWorkDir, "classed.sqlite");
  // Assign one fixture food a class; the other stays unmapped (→ _global).
  beforeAll(() =>
    buildBundle({ fdcDir: fixtures, out: classedPath, foodClasses: { "Banana, raw": "flat" } }),
  );
  afterAll(() => rmSync(classWorkDir, { recursive: true, force: true }));

  it("resolves a food to its assigned class prior, not _global", async () => {
    const store = openNutrientStore(classedPath);
    const banana = (await store.lookup("Banana, raw"))!;
    expect(banana.shape.kind).toBe("flat"); // the flat class prior, not the mound global
    expect(banana.shape.phi).toBe(1); // flat slab fills its footprint
    expect(banana.shape.hBarM).toBe(0.015); // flat thickness default (MATH.md §4)
    // An unmapped food still falls back to the _global mound prior.
    const rice = (await store.lookup("Rice, white, cooked"))!;
    expect(rice.shape.kind).toBe("mound");
    expect(rice.shape.kappa).toBe(0.1687);
    store.close();
  });
});
