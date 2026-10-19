import { join, resolve } from "node:path";

// Files that ship with nesev (migrations, fonts, the built SPA, helper sources), as opposed to the user's data
// (lib/paths.ts). Run from source, they live in the checkout. Side-effect free and independent of the data dir, so the
// first-start setup (server/setup.ts) can use it before a data dir is chosen.
// The release binary embeds these files and extracts them to a cache dir on start (src/cli/embedded.ts); it sets
// NESEV_APP_ROOT to that dir before any server module loads.

export const APP_ROOT = process.env.NESEV_APP_ROOT ? resolve(process.env.NESEV_APP_ROOT) : resolve(import.meta.dir, "../../..");
export const MIGRATIONS_DIR = join(APP_ROOT, "src/server/db/migrations");
export const WEB_DIST_DIR = join(APP_ROOT, "dist/web");
export const FONTS_DIR = join(APP_ROOT, "src/server/assets/fonts");
export const OCR_HELPER_SOURCE = join(APP_ROOT, "src/server/lib/ocr/nesev-ocr.swift");
/** Prebuilt OCR helpers shipped with the macOS release binaries (bin/nesev-ocr-<source hash>, see lib/ocr/helper.ts). */
export const PREBUILT_BIN_DIR = join(APP_ROOT, "bin");

/** Default port of the server (API + built SPA), also what the MCP server and the service installer expect. */
export const DEFAULT_PORT = 3998;
