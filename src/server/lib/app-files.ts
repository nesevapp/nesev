import { join, resolve } from "node:path";

// Files that ship with nesev (migrations, fonts, the built SPA, helper sources), as opposed to the user's data
// (lib/paths.ts). Run from source, they live in the checkout. Side-effect free and independent of the data dir, so the
// first-start setup (server/setup.ts) can use it before a data dir is chosen.

export const APP_ROOT = resolve(import.meta.dir, "../../..");
export const MIGRATIONS_DIR = join(APP_ROOT, "src/server/db/migrations");
export const WEB_DIST_DIR = join(APP_ROOT, "dist/web");
export const FONTS_DIR = join(APP_ROOT, "src/server/assets/fonts");

/** Default port of the server (API + built SPA), also what the MCP server and the service installer expect. */
export const DEFAULT_PORT = 3998;
