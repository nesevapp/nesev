import { Hono } from "hono";
import { z } from "zod";
import {
  clientCreateSchema,
  clientListQuerySchema,
  clientPickerQuerySchema,
  clientUpdateSchema,
} from "../../shared/schemas/client";
import { db } from "../db";
import { validate } from "../lib/validate";
import {
  createClient,
  deleteClient,
  listClients,
  nextClientNumber,
  requireClient,
  setClientArchived,
  updateClient,
} from "../services/clients";

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));

const app = new Hono()
  .get("/", validate("query", clientListQuerySchema), (c) => c.json(listClients(db, c.req.valid("query"))))
  /** Lightweight search for the ClientPicker: active clients only, limited. */
  .get("/picker", validate("query", clientPickerQuerySchema), (c) => {
    const { q, limit } = c.req.valid("query");
    return c.json(listClients(db, { q, limit, archived: "active" }));
  })
  .get("/next-number", (c) => c.json({ number: nextClientNumber(db) }))
  .get("/:id", idParam, (c) => c.json(requireClient(db, c.req.valid("param").id)))
  .post("/", validate("json", clientCreateSchema), (c) => c.json(createClient(db, c.req.valid("json")), 201))
  .put("/:id", idParam, validate("json", clientUpdateSchema), (c) =>
    c.json(updateClient(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .post("/:id/archive", idParam, (c) => c.json(setClientArchived(db, c.req.valid("param").id, true)))
  .post("/:id/unarchive", idParam, (c) => c.json(setClientArchived(db, c.req.valid("param").id, false)))
  .delete("/:id", idParam, (c) => {
    deleteClient(db, c.req.valid("param").id);
    return c.json({ ok: true });
  });

export default app;
