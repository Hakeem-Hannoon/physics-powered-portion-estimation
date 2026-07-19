import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system";
import * as SQLite from "expo-sqlite";
import type { FoodRecord, FoodShape, NutrientStore } from "@ppe/pipeline";

/**
 * On-device `NutrientStore` (packages/pipeline/src/adapters.ts) backed by the
 * bundled SQLite nutrient database via expo-sqlite. It's the real counterpart to
 * the Node reference store (nutrition/etl/nutrient-store.mjs) — SAME schema, same
 * resolution order — so the demo shows REAL USDA nutrition instead of the single
 * hard-coded mock. `lookup` returns a FoodRecord or null (the pipeline's "never
 * invent nutrition" rule).
 *
 * The DB ships as an app asset (apps/demo/assets/nutrients.sqlite, built by
 * nutrition/starter/build-starter.mjs). expo-sqlite opens files from its own
 * directory, so on first launch we copy the read-only asset there once.
 */

const DB_NAME = "nutrients.sqlite";

/** foods column → NutrientsPer100g.micros key (matches the Node store). */
const MICRO_COLUMNS: Record<string, string> = {
  fiber100: "fiberG",
  sugar100: "sugarG",
  satfat100: "satFatG",
  sodium100: "sodiumMg",
  cholesterol100: "cholesterolMg",
  potassium100: "potassiumMg",
  calcium100: "calciumMg",
  iron100: "ironMg",
};

const FALLBACK_SHAPE: FoodShape = { kind: "mound", kappa: 0.1687, phi: 0.446, hBarM: 0.0979 };
const FALLBACK_DENSITY_G_PER_ML = 1.0;

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const ftsQuery = (s: string) =>
  normalize(s).replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

interface FoodRow {
  description: string;
  kcal100: number | null;
  protein100: number | null;
  carbs100: number | null;
  fat100: number | null;
  density_g_per_ml: number | null;
  [col: string]: unknown;
}
interface ShapeRow {
  kind: string;
  kappa: number | null;
  phi: number | null;
  h_bar_m: number | null;
}

function shapeFromPrior(row: ShapeRow | null): FoodShape {
  if (!row) return { ...FALLBACK_SHAPE };
  const shape: FoodShape = { kind: (row.kind as FoodShape["kind"]) ?? "mound" };
  if (row.kappa != null) shape.kappa = row.kappa;
  if (row.phi != null) shape.phi = row.phi;
  if (row.h_bar_m != null) shape.hBarM = row.h_bar_m;
  return shape;
}

function toFoodRecord(row: FoodRow, shape: FoodShape): FoodRecord {
  const micros: Record<string, number> = {};
  for (const [col, key] of Object.entries(MICRO_COLUMNS)) {
    const v = row[col];
    if (typeof v === "number") micros[key] = v;
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

/** Copy the bundled read-only DB into expo-sqlite's directory once. */
async function ensureDbCopied(): Promise<void> {
  const dir = `${FileSystem.documentDirectory}SQLite`;
  const dest = `${dir}/${DB_NAME}`;
  if ((await FileSystem.getInfoAsync(dest)).exists) return;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const asset = Asset.fromModule(require("../assets/nutrients.sqlite"));
  await asset.downloadAsync();
  await FileSystem.copyAsync({ from: asset.localUri ?? asset.uri, to: dest });
}

export class ExpoSqliteNutrientStore implements NutrientStore {
  private db: SQLite.SQLiteDatabase | null = null;
  private globalShape: FoodShape = { ...FALLBACK_SHAPE };
  private readonly shapeByClass = new Map<string, FoodShape>();
  private hasFts = false;
  /** Curated classifier-label → FDC description/id map ("the quality-critical
   *  data artifact", STATUS.md). A real classifier's terse labels resolve here. */
  constructor(private readonly aliases: Record<string, string | number> = {}) {}

  private async ready(): Promise<SQLite.SQLiteDatabase> {
    if (this.db) return this.db;
    await ensureDbCopied();
    const db = await SQLite.openDatabaseAsync(DB_NAME);
    const fts = await db.getFirstAsync<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'fts'",
    );
    this.hasFts = fts?.value === "1";
    if (this.hasFts) {
      // meta.fts says the index is in the FILE; whether this build of SQLite
      // can read it is this runtime's business. Probe once — if the fts5
      // module is missing, every later query would throw, so degrade to LIKE
      // now instead of failing lookups at estimate time.
      try {
        await db.getFirstAsync("SELECT rowid FROM foods_fts LIMIT 1");
      } catch {
        this.hasFts = false;
      }
    }
    const shape = await db.getFirstAsync<ShapeRow>(
      "SELECT * FROM shape_priors WHERE class = ?",
      "_global",
    );
    this.globalShape = shapeFromPrior(shape ?? null);
    this.db = db;
    return db;
  }

  /** Per-food shape class (MATH.md §4): resolve a food's class to its own prior,
   *  falling back to `_global` when the food has no class or the class has no row. */
  private async shapeForClass(db: SQLite.SQLiteDatabase, cls: string | null): Promise<FoodShape> {
    if (!cls) return this.globalShape;
    const cached = this.shapeByClass.get(cls);
    if (cached) return cached;
    const row = await db.getFirstAsync<ShapeRow>(
      "SELECT * FROM shape_priors WHERE class = ?",
      cls,
    );
    const resolved = row ? shapeFromPrior(row) : this.globalShape;
    this.shapeByClass.set(cls, resolved);
    return resolved;
  }

  async lookup(label: string): Promise<FoodRecord | null> {
    if (!label) return null;
    const db = await this.ready();
    const alias = this.aliases[normalize(label)];
    const term = typeof alias === "string" ? alias : label;

    let row: FoodRow | null = null;
    if (typeof alias === "number") {
      row = await db.getFirstAsync<FoodRow>("SELECT * FROM foods WHERE fdc_id = ?", alias);
    }
    if (!row) {
      row = await db.getFirstAsync<FoodRow>(
        "SELECT * FROM foods WHERE description = ? COLLATE NOCASE LIMIT 1",
        term,
      );
    }
    if (!row) {
      // Full-text best hit when bundle AND runtime both have FTS5; else a
      // LIKE fallback (fine even for the ~14k-food full bundle — milliseconds
      // on device). Mirrors the Node openBundle.
      const q = ftsQuery(term);
      if (q && this.hasFts) {
        row = await db.getFirstAsync<FoodRow>(
          "SELECT f.* FROM foods_fts JOIN foods f ON f.fdc_id = foods_fts.rowid WHERE foods_fts MATCH ? ORDER BY rank LIMIT 1",
          q,
        );
      } else if (q) {
        row = await db.getFirstAsync<FoodRow>(
          "SELECT * FROM foods WHERE description LIKE ? ORDER BY length(description) LIMIT 1",
          `%${term}%`,
        );
      }
    }
    if (!row) return null;
    const shape = await this.shapeForClass(db, (row.shape_class as string | null) ?? null);
    return toFoodRecord(row, { ...shape });
  }
}
