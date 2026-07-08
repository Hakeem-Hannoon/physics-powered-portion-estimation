---
tags: [ppe, reference, testing]
---

# Testing

> How the project is verified — the 27 automated tests (which lock the deterministic physics and contracts to synthetic ground truth), and the physical P0–P4 drills (which validate real hardware and real food). Spec: [[ARCHITECTURE]] §4, [[STATUS]] §7.

Two distinct tiers, and it's important to keep them separate: **(A) automated tests** in CI, and **(B) manual/benchmark milestones** run on a phone and against datasets.

## Tier A — the automated suite

**Framework:** [Vitest](https://vitest.dev) (v3), TypeScript consumed directly — *no build step* (every package is `noEmit`; `main`/`types` point at raw `src/index.ts`). The config scopes the run to `packages/*/test` and `nutrition/test`.

**Commands:**
```
npm test          # vitest run — all 27 tests, one pass
npm run test:watch
npm run typecheck  # tsc --noEmit across @ppe/geometry and @ppe/pipeline
```

**CI** (`.github/workflows/ci.yml`): on every push to `main` and every pull request → Node 22 → `npm ci` → `npm run typecheck` → `npm test`. There is **no** native (Android/iOS) build in CI yet (it's backlog). Node ≥ 22.5 is required because the ETL uses built‑in `node:sqlite`.

**46 tests, five suites, all green:**

### geometry — 20 synthetic‑scene tests (`packages/geometry/test/geometry.test.ts`)
The crown jewel: it treats [[MATH]] as executable spec. It builds synthetic cameras + a table plane with **known ground truth** and asserts the geometry recovers it to ~**1e‑9**. Every group cites its MATH.md section:
- **camera model** — project→unproject round‑trips to a plane; the **intrinsics‑rescale** pitfall (§9.1); the **ARKit→CV y‑flip** conversion (§9.3); camera height.
- **homography** — recovers a known 10×10 cm square's area as **0.01 m² to 1e‑9**; the ruler residual is ~0 for a perfect capture; the **off‑plane inflation** is exactly $Z/(Z-h)$ and the correction undoes it (§3.2).
- **area & volume** — all three volume routes: shape prior scales as $A^{3/2}$ (route c), area×height with fill factor (route b), height‑field integration of a slab (route a); mass = ρV (the rice example).
- **energy** — per‑100 g scaling; the Atwater guard accepts a good record and rejects a broken one.
- **error budget** — reproduces the documented **0.306 (v0)** / **0.207 (v1)** numbers and verifies the scale term enters **doubled**.

*(Note: the [[Math 2 - The Ruler]] §2.4 stabilization stack is NOT unit‑tested here — it lives in the native module and is validated on‑device via P0/P1.)*

### pipeline — 4 end‑to‑end tests (`packages/pipeline/test/estimate.test.ts`)
Runs `estimateMeal` over a synthetic nadir capture with **mocked models but real geometry**:
1. **Happy path** — ruler capture, no height → `shape_prior` route; off‑plane correction shrinks the footprint; mass/energy/macros co‑scale; `est_relative_error ≈ 0.306`; residual ~0.
2. **Vertical stroke** — adds a height stroke → flips to the `area_height` route and tightens the budget to `≈ 0.207`.
3. **Unknown food** — classifier returns a food with no DB match → `no_db_match` + `low_confidence` flags, `mass_g`/`kcal` **null**, totals 0, but **volume still reported** (the never‑invent rule).
4. **Malformed payload** — `version: 2` → rejected at the input edge with a `ZodError` (contract enforcement).

Both contract edges are covered: input by test 4, output by `estimateResultSchema.parse` running under tests 1–3.

### pipeline — 11 edit‑helper tests (`packages/pipeline/test/edit.test.ts`)
The propose→confirm helpers ([[The Pipeline]] → "Editing an estimate"): `rescaleItemToMass` scales nutrition linearly and keeps the geometry (only sets the mass on an unmatched item); `relabelItem` re‑derives mass+nutrition from a new `FoodRecord` on the measured volume, sets confidence to 1, clears stale flags, re‑runs Atwater, and yields null nutrition on `record: null`; `recomputeTotals` sums (null items as zero); `withEditedItem` recomputes totals and **re‑validates against the output schema** (a bad edit throws `ZodError`).

### nutrition — 5 ETL tests (`nutrition/test/etl.test.ts`)
Builds a bundle from CSV fixtures and checks: branded foods are filtered out (2 of 3 kept); rice's density derives to **0.668 g/mL** from its cup portion, tagged `fdc_portion` (banana's "medium" portion yields null); full‑text search finds rice by name; and the `shape_priors` table is seeded with a default `_global` mound (matching the pipeline placeholder) or ingested from a `priors.json`.

### nutrition — 6 store tests (`nutrition/test/nutrient-store.test.ts`)
The reference `NutrientStore` ([[Nutrition Database]]): resolves a label to a `FoodRecord` by exact / full‑text / alias, falls back to water density when FDC has no volumetric portion, returns `null` on a miss (never invents), and — the data‑path proof — feeds the store's rice record through the pipeline's exact mass→nutrition arithmetic (200 mL → 133.6 g → 173.6 kcal).

### The monorepo (context for the suite)
npm workspaces `packages/*` + `nutrition`; ESM throughout. `@ppe/pipeline` → `@ppe/geometry` resolves **straight to TypeScript source** (no `dist`). Config is plain tsconfig **inheritance** (a strict `tsconfig.base.json`), *not* TS project references. `@ppe/nutrition-etl` is plain `.mjs` (not typechecked).

## Tier B — physical & benchmark milestones (NOT in CI)

These validate what synthetic tests can't: that real VIO delivers the metric scale, that stabilization works in a real hand, and that the models hit their numbers. From [[STATUS]] §7:

| Milestone | Type | Proves | Pass bar |
|---|---|---|---|
| **P0 — ruler accuracy** | manual device drill (phone vs. tape measure, multiple angles/lighting) | the physics on real hardware | median ≤ **5 mm** on 20 cm spans |
| **P1 — geometry‑only mass** | manual drill (~30 home meals vs. kitchen scale, placeholder segmentation) | the metric pipeline on real food, before any model is trusted | median mass error ≤ **25%** |
| **P2 — models in** | integration | on‑device segmentation + classification wired | — |
| **P3 — the regressor** | dataset benchmark (Nutrition5k) | scale‑conditioned regression, A/B vs. geometry | calorie MAPE vs. 26.1% / 16.5% |
| **P4 — benchmark + integrate** | dataset + ship | Nutrition5k/NutriBench numbers; live in Spotter | — |

**The connection between the tiers:** P1's ≤ 25% bar and the automated `est_relative_error` assertions (0.306 v0 / 0.207 v1) are the *same* [[Math 4 - Volume Mass and Nutrients]] §8 budget — the unit tests lock the *propagation formula*; P1 is the field check that reality lands inside it. Design reason geometry can be unit‑tested to 1e‑9 at all: it's [[ARCHITECTURE]]'s "not a model" decision ([[Geometry Library]]).

## How to run everything locally
```
npm ci
npm run typecheck && npm test     # tier A
# tier B: build the demo (apps/demo) and run the P0/P1 drills on a real device
```

## Related
- [[Geometry Library]] · [[The Pipeline]] · [[Nutrition Database]] · [[Math 4 - Volume Mass and Nutrients]] · [[The Capture App]] · [[Roadmap and Next Steps]] · [[ARCHITECTURE]] · [[STATUS]]
