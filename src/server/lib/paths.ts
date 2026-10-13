import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");

export const PROJECT_ROOT = ROOT;
export const DATA_DIR = resolve(process.env.NESEV_DATA_DIR ?? join(ROOT, "data"));
export const ASSETS_DIR = join(DATA_DIR, "assets");
export const PDFS_DIR = join(DATA_DIR, "pdfs");
export const DB_PATH = process.env.NESEV_DB ?? join(DATA_DIR, "nesev.db");
export const MIGRATIONS_DIR = join(ROOT, "src/server/db/migrations");
export const WEB_DIST_DIR = join(ROOT, "dist/web");

export function ensureDataDirs() {
  for (const d of [DATA_DIR, ASSETS_DIR, PDFS_DIR]) mkdirSync(d, { recursive: true });
}
