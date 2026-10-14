import { Hono } from "hono";
import { z } from "zod";
import { todayIso } from "../../shared/dates";
import { assetCreateSchema, assetDisposalSchema, assetListQuerySchema, assetUpdateSchema } from "../../shared/schemas/asset";
import { db } from "../db";
import { validate } from "../lib/validate";
import {
  assetFileNames,
  assetLinks,
  assetPrefillFromExpense,
  assetRegister,
  assetsCsv,
  createAsset,
  deleteAsset,
  disposeAsset,
  getAssetDetail,
  nextAssetNumber,
  undoDisposal,
  updateAsset,
} from "../services/assets";

// Anlagenverzeichnis / AfA. GET / is the register of a year (default: current year).

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));
const currentYear = () => Number(todayIso().slice(0, 4));

const app = new Hono()
  .get("/", validate("query", assetListQuerySchema), (c) => c.json(assetRegister(db, c.req.valid("query").year ?? currentYear())))
  .get("/register.csv", validate("query", assetListQuerySchema), (c) => {
    const year = c.req.valid("query").year ?? currentYear();
    return new Response(assetsCsv(assetRegister(db, year)), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${assetFileNames.register(year)}"`,
        "Cache-Control": "no-store",
      },
    });
  })
  /** Assets linked to an expense: hints in the expense editor and list. */
  .get("/links", (c) => c.json(assetLinks(db)))
  .get("/next-number", (c) => c.json({ number: nextAssetNumber(db) }))
  /** Prefill for creating an asset from an expense's "anlagen" lines. */
  .get("/from-expense/:id", idParam, (c) => c.json(assetPrefillFromExpense(db, c.req.valid("param").id)))
  .get("/:id", idParam, (c) => c.json(getAssetDetail(db, c.req.valid("param").id)))
  .post("/", validate("json", assetCreateSchema), (c) => c.json(createAsset(db, c.req.valid("json")), 201))
  .put("/:id", idParam, validate("json", assetUpdateSchema), (c) =>
    c.json(updateAsset(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .post("/:id/disposal", idParam, validate("json", assetDisposalSchema), (c) =>
    c.json(disposeAsset(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .delete("/:id/disposal", idParam, (c) => c.json(undoDisposal(db, c.req.valid("param").id)))
  .delete("/:id", idParam, (c) => {
    deleteAsset(db, c.req.valid("param").id);
    return c.json({ ok: true });
  });

export default app;
