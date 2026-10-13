import { Hono } from "hono";
import { ASSETS_DIR, PDFS_DIR } from "../lib/paths";
import { serveFile } from "../lib/static";

/** Serves data/assets/* and data/pdfs/* at /api/files/assets/* and /api/files/pdfs/*. */
const app = new Hono()
  .get("/assets/:path{.+}", async (c) => (await serveFile(ASSETS_DIR, c.req.param("path"))) ?? c.notFound())
  .get("/pdfs/:path{.+}", async (c) => (await serveFile(PDFS_DIR, c.req.param("path"))) ?? c.notFound());

export default app;
