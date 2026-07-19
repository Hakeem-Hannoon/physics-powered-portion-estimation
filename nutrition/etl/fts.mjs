import { execFileSync } from "node:child_process";

/**
 * Some `node:sqlite` builds ship without FTS5 — buildBundle() then writes
 * `meta.fts = 0` and every store falls back to LIKE search (correct, slower,
 * worse ranking). Where a system `sqlite3` binary WITH fts5 exists (macOS and
 * most Linux distros), build the index after the fact and flip the flag; the
 * 'rebuild' command repopulates the content-linked table from `foods`.
 *
 * Also checkpoints WAL and switches the journal back to DELETE so the shipped
 * asset is a single self-contained file. Best-effort: any failure (no binary,
 * no fts5) leaves the LIKE-fallback bundle untouched and returns false.
 */
export function tryEnableFts(bundlePath) {
  const sql = `
    CREATE VIRTUAL TABLE IF NOT EXISTS foods_fts USING fts5(description, content='foods', content_rowid='fdc_id');
    INSERT INTO foods_fts(foods_fts) VALUES('rebuild');
    INSERT OR REPLACE INTO meta (key, value) VALUES ('fts', '1');
    PRAGMA wal_checkpoint(TRUNCATE);
    PRAGMA journal_mode=DELETE;
  `;
  try {
    execFileSync("sqlite3", [bundlePath, sql], { stdio: ["ignore", "ignore", "pipe"] });
    return true;
  } catch {
    return false;
  }
}
