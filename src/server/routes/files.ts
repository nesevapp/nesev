import { Hono } from "hono";
import { ASSETS_DIR, PDFS_DIR, RECEIPTS_DIR } from "../lib/paths";
import { serveFile } from "../lib/static";

/** Serves data/assets/*, data/pdfs/* and data/receipts/* at /api/files/{assets,pdfs,receipts}/*. */
const app = new Hono()
  .get("/assets/:path{.+}", async (c) => (await serveFile(ASSETS_DIR, c.req.param("path"))) ?? c.notFound())
  .get("/pdfs/:path{.+}", async (c) => (await serveFile(PDFS_DIR, c.req.param("path"))) ?? c.notFound())
  .get("/receipts/:path{.+}", async (c) => (await serveFile(RECEIPTS_DIR, c.req.param("path"))) ?? c.notFound());

export default app;
