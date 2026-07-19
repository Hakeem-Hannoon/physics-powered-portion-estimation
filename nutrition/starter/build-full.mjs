/**
 * Builds the PRODUCTION nutrient bundle: every generic food in the USDA
 * FoodData Central per-type CSV exports (Foundation + SR Legacy + FNDDS,
 * ~14k foods) PLUS the curated starter set (./foods.mjs) overlaid on top.
 *
 * Why the overlay: the classifier vocabulary and label→FDC map resolve to the
 * curated descriptions ("Chicken breast, cooked, roasted"), which are not
 * verbatim USDA strings — real FDC says "Chicken, broilers or fryers, breast,
 * meat only, cooked, roasted". Overlaying the curated rows keeps the demo's
 * exact-match/alias resolution byte-for-byte identical to the starter bundle,
 * while the full export adds real rows for search and future vocab growth.
 * (Re-pointing the label map at verbatim USDA rows is the roadmap's "class
 * taxonomy" item — a curation pass, not a build step.)
 *
 * Input: --fdc-dir pointing at a directory that contains the UNZIPPED
 * per-type CSV exports (any nesting — every subdirectory holding a food.csv
 * is ingested). Download from https://fdc.nal.usda.gov/download-datasets/:
 * "Foundation Foods", "SR Legacy", "FNDDS (Survey)" CSV zips. Do NOT use the
 * all-types download — its branded-food CSVs are gigabytes and add nothing
 * (branded rows are filtered out anyway).
 *
 *   npm run build:nutrients:full -- --fdc-dir ~/Downloads/fdc
 *
 * The per-type exports encode portion measures three different ways; the ETL
 * parses all three (see portionMl in ../etl/build-bundle.mjs), so densities
 * come out of the real data, not just the curated rows.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { buildBundle } from "../etl/build-bundle.mjs";
import { csvRecords } from "../etl/csv.mjs";
import { tryEnableFts } from "../etl/fts.mjs";
import { FOODS } from "./foods.mjs";
import { starterFoodClasses, writeStarterFixtures } from "./fixture-csv.mjs";

const { values } = parseArgs({
  options: {
    "fdc-dir": { type: "string" },
    out: { type: "string", default: "apps/demo/assets/nutrients.sqlite" },
    priors: { type: "string" },
  },
});
if (!values["fdc-dir"]) {
  console.error("Usage: node nutrition/starter/build-full.mjs --fdc-dir <dir with the unzipped per-type FDC CSV exports> [--out bundle.sqlite] [--priors priors.json]");
  process.exit(1);
}

// Every directory under --fdc-dir that holds a food.csv is one export.
const sourceDirs = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    try {
      statSync(join(p, "food.csv"));
      sourceDirs.push(p);
    } catch {
      walk(p);
    }
  }
})(values["fdc-dir"]);
if (sourceDirs.length === 0) {
  console.error(`no food.csv found anywhere under ${values["fdc-dir"]} — unzip the per-type exports there first`);
  process.exit(1);
}

// The curated starter set rides along as one more FDC-shaped source dir.
const starterDir = mkdtempSync(join(tmpdir(), "ppe-starter-overlay-"));
writeStarterFixtures(starterDir);

// Merge into one --fdc-dir for buildBundle. Re-emitting ONLY the columns the
// ETL reads makes schema drift between export vintages (2018 vs 2026) a
// non-issue; measure_unit dedupes by id with the REAL exports winning (the
// starter's synthetic ids either match — 1000 = "cup" — or go unreferenced).
const TABLES = {
  "food.csv": ["fdc_id", "data_type", "description"],
  "food_nutrient.csv": ["fdc_id", "nutrient_id", "amount"],
  "food_portion.csv": ["fdc_id", "measure_unit_id", "amount", "gram_weight", "modifier", "portion_description"],
  "measure_unit.csv": ["id", "name"],
};
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const mergedDir = mkdtempSync(join(tmpdir(), "ppe-fdc-merged-"));
const realFoodIds = new Set();
for (const [file, cols] of Object.entries(TABLES)) {
  const seenUnits = new Set();
  const lines = [cols.map(q).join(",")];
  for (const dir of [...sourceDirs, starterDir]) {
    for (const r of csvRecords(readFileSync(join(dir, file), "utf8"))) {
      if (file === "measure_unit.csv") {
        if (seenUnits.has(r.id)) continue;
        seenUnits.add(r.id);
      }
      if (file === "food.csv") {
        if (dir === starterDir && realFoodIds.has(r.fdc_id)) {
          throw new Error(`starter overlay id ${r.fdc_id} collides with a real FDC id`);
        }
        realFoodIds.add(r.fdc_id);
      }
      lines.push(cols.map((c) => q(r[c])).join(","));
    }
  }
  writeFileSync(join(mergedDir, file), lines.join("\n") + "\n");
}

const priors = values.priors ? JSON.parse(readFileSync(values.priors, "utf8")) : null;
const stats = buildBundle({
  fdcDir: mergedDir,
  out: values.out,
  priors,
  foodClasses: starterFoodClasses(),
});
const fts = stats.fts || tryEnableFts(values.out);
// The shipped asset is ONE file; drop any WAL sidecars the build left behind.
rmSync(`${values.out}-wal`, { force: true });
rmSync(`${values.out}-shm`, { force: true });

// Ship the canonical label→FDC map next to the DB so the demo bundles a local copy.
copyFileSync(new URL("../label-map.json", import.meta.url), join(dirname(values.out), "label-map.json"));

console.log(
  `full bundle → ${values.out}: ${stats.foods} foods (${sourceDirs.length} FDC exports + ${FOODS.length} curated), ` +
    `${stats.withDensity} with portion-derived density, ${stats.shapePriors} shape priors, fts=${fts}; label-map copied`,
);
