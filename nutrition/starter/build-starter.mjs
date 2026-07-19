/**
 * Builds a small *starter* nutrient bundle of common foods for the demo app, so
 * `apps/demo` shows REAL USDA nutrition (not the single hard-coded mock) without
 * the FoodData Central download. Values are standard USDA reference per-100 g
 * figures (SR Legacy / FNDDS, CC0) for widely-eaten foods — a curated subset,
 * NOT invented: the production bundle overlays this same set onto the full FDC
 * export (./build-full.mjs, `npm run build:nutrients:full`).
 *
 *   node nutrition/starter/build-starter.mjs --out apps/demo/assets/nutrients.sqlite
 *
 * The food set lives in ./foods.mjs (shared with the classifier vocabulary and
 * the label→FDC map); ./fixture-csv.mjs writes it out in FDC CSV shape to a
 * temp dir and this script runs the SAME buildBundle() the real ETL uses, so
 * the on-device schema is identical. Density is portion-derived where a
 * volumetric measure is given (MATH.md §5); omitted nutrients stay null.
 */
import { mkdtempSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { buildBundle } from "../etl/build-bundle.mjs";
import { tryEnableFts } from "../etl/fts.mjs";
import { starterFoodClasses, writeStarterFixtures } from "./fixture-csv.mjs";

const { values } = parseArgs({ options: { out: { type: "string", default: "apps/demo/assets/nutrients.sqlite" }, priors: { type: "string" } } });
const dir = mkdtempSync(join(tmpdir(), "ppe-starter-"));
writeStarterFixtures(dir);
const priors = values.priors ? JSON.parse(readFileSync(values.priors, "utf8")) : null;
const stats = buildBundle({ fdcDir: dir, out: values.out, priors, foodClasses: starterFoodClasses() });
const fts = stats.fts || tryEnableFts(values.out);
// The shipped asset is ONE file; drop any WAL sidecars the build left behind.
rmSync(`${values.out}-wal`, { force: true });
rmSync(`${values.out}-shm`, { force: true });

// Ship the canonical label→FDC map next to the DB so the demo bundles a local copy.
copyFileSync(new URL("../label-map.json", import.meta.url), join(dirname(values.out), "label-map.json"));

console.log(`starter bundle → ${values.out}: ${stats.foods} foods, ${stats.withDensity} with density, ${stats.shapePriors} shape priors, fts=${fts}; label-map copied`);
