import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT, MIGRATIONS_DIR, WEB_DIST_DIR } from "./app-files";
import { appDataDir, resolveDataDir } from "./data-location";

export const PROJECT_ROOT = APP_ROOT;
export { MIGRATIONS_DIR, WEB_DIST_DIR };

/**
 * The user's data dir, resolved once on import (see lib/data-location.ts). The server only imports this after the
 * first-start setup chose one. Without one (tests, an MCP server before the setup) DATA_DIR is just the suggested
 * app-data dir as a placeholder: db/index.ts refuses to open a DB there, so nothing is ever written to it.
 */
export const DATA_DIR_SOURCE = resolveDataDir();
export const DATA_DIR = DATA_DIR_SOURCE?.dir ?? appDataDir();
export const ASSETS_DIR = join(DATA_DIR, "assets");
export const PDFS_DIR = join(DATA_DIR, "pdfs");
/** expense receipts, stored as "receipts/<year>/<file>" */
export const RECEIPTS_DIR = join(DATA_DIR, "receipts");
export const DB_PATH = process.env.NESEV_DB ?? join(DATA_DIR, "nesev.db");

export function ensureDataDirs() {
  for (const d of [DATA_DIR, ASSETS_DIR, PDFS_DIR, RECEIPTS_DIR]) mkdirSync(d, { recursive: true });
}
