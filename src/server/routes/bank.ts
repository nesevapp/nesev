import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  AUTO_MATCH_MODES,
  bankAccountSchema,
  csvMappingSchema,
  matchSchema,
  transactionListQuerySchema,
} from "../../shared/bank";
import { db } from "../db";
import { CSV_PRESETS } from "../lib/bank-parsers";
import { validate } from "../lib/validate";
import {
  accountSuggestion,
  createAccount,
  deleteAccount,
  documentPayments,
  expensePayments,
  getTransaction,
  listAccounts,
  listImports,
  listTransactions,
  requireAccount,
  setAccountArchived,
  setIgnored,
  transactionSummary,
  updateAccount,
} from "../services/bank";
import { commitImport, previewImport, undoImport } from "../services/bank-import";
import { applyMatch, autoMatch, searchCandidates, unmatch, withSuggestions } from "../services/bank-matching";

const idParam = validate("param", z.object({ id: z.coerce.number().int().positive() }));

/** multipart/form-data: "file" plus optional "mapping" (JSON CsvMapping from the mapping dialog) or "preset". */
const importForm = validate(
  "form",
  z.object({
    file: z.instanceof(File, { message: "Keine Datei hochgeladen" }),
    mapping: z.string().optional(),
    preset: z.string().max(40).optional(),
  }),
);

function mappingFrom(raw: string | undefined) {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new HTTPException(400, { message: "Ungültige Spaltenzuordnung" });
  }
  const parsed = csvMappingSchema.safeParse(json);
  if (!parsed.success) throw new HTTPException(400, { message: "Ungültige Spaltenzuordnung" });
  return parsed.data;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;

async function fileBytes(file: File): Promise<Uint8Array> {
  if (file.size > MAX_FILE_BYTES) throw new HTTPException(413, { message: "Die Datei ist zu groß (max. 20 MB)" });
  return new Uint8Array(await file.arrayBuffer());
}

const app = new Hono()
  // ── Accounts
  .get("/accounts", (c) => c.json(listAccounts(db)))
  /** Prefill for a new account from the company settings (IBAN, bank). */
  .get("/accounts/suggestion", (c) => c.json(accountSuggestion(db)))
  .post("/accounts", validate("json", bankAccountSchema), (c) => c.json(createAccount(db, c.req.valid("json")), 201))
  .put("/accounts/:id", idParam, validate("json", bankAccountSchema), (c) =>
    c.json(updateAccount(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  .post("/accounts/:id/archive", idParam, (c) => c.json(setAccountArchived(db, c.req.valid("param").id, true)))
  .post("/accounts/:id/unarchive", idParam, (c) => c.json(setAccountArchived(db, c.req.valid("param").id, false)))
  .delete("/accounts/:id", idParam, (c) => {
    deleteAccount(db, c.req.valid("param").id);
    return c.json({ ok: true });
  })
  // ── Import
  .get("/presets", (c) => c.json(CSV_PRESETS))
  /** Parse without saving: detected format/mapping, rows with duplicate flags. */
  .post("/accounts/:id/import/preview", idParam, importForm, async (c) => {
    const { file, mapping, preset } = c.req.valid("form");
    const opts = { mapping: mappingFrom(mapping), preset };
    return c.json(previewImport(db, c.req.valid("param").id, await fileBytes(file), file.name, opts));
  })
  /** Import new rows, remember the CSV mapping, auto-match per the account's mode. */
  .post("/accounts/:id/import", idParam, importForm, async (c) => {
    const { file, mapping, preset } = c.req.valid("form");
    const opts = { mapping: mappingFrom(mapping), preset };
    return c.json(commitImport(db, c.req.valid("param").id, await fileBytes(file), file.name, opts), 201);
  })
  .get("/imports", validate("query", z.object({ accountId: z.coerce.number().int().positive().optional() })), (c) =>
    c.json(listImports(db, c.req.valid("query").accountId)),
  )
  /** Undo: deletes the import's unmatched transactions. */
  .delete("/imports/:id", idParam, (c) => c.json(undoImport(db, c.req.valid("param").id)))
  // ── Transactions
  .get("/transactions", validate("query", transactionListQuerySchema), (c) =>
    c.json(withSuggestions(db, listTransactions(db, c.req.valid("query")))),
  )
  .get("/summary", validate("query", transactionListQuerySchema), (c) => c.json(transactionSummary(db, c.req.valid("query"))))
  .get("/transactions/:id", idParam, (c) => c.json(withSuggestions(db, [getTransaction(db, c.req.valid("param").id)])[0]!))
  /** Allocate the transaction (split: several allocations). */
  .post("/transactions/:id/match", idParam, validate("json", matchSchema), (c) =>
    c.json(applyMatch(db, c.req.valid("param").id, c.req.valid("json"))),
  )
  /** Remove all allocations of the transaction. */
  .delete("/transactions/:id/match", idParam, (c) => c.json(unmatch(db, { transactionId: c.req.valid("param").id })))
  .delete("/matches/:id", idParam, (c) => c.json(unmatch(db, { matchId: c.req.valid("param").id })))
  .post("/transactions/:id/ignore", idParam, (c) => c.json(setIgnored(db, c.req.valid("param").id, true)))
  .post("/transactions/:id/unignore", idParam, (c) => c.json(setIgnored(db, c.req.valid("param").id, false)))
  /** Run auto-matching over open transactions (of one account). */
  .post(
    "/auto-match",
    validate("json", z.object({ accountId: z.number().int().positive().optional(), mode: z.enum(AUTO_MATCH_MODES).optional() })),
    (c) => {
      const { accountId, mode } = c.req.valid("json");
      const effective = mode ?? (accountId ? requireAccount(db, accountId).autoMatch : "safe");
      return c.json({ matched: autoMatch(db, { mode: effective, accountId }) });
    },
  )
  /** Open invoices (direction=in) or expenses (out) for the manual matching dialog, scored against a transaction. */
  .get(
    "/candidates",
    validate(
      "query",
      z.object({
        direction: z.enum(["in", "out"]),
        q: z.string().max(200).optional(),
        transactionId: z.coerce.number().int().positive().optional(),
      }),
    ),
    (c) => c.json(searchCandidates(db, c.req.valid("query"))),
  )
  // ── Payments of a document / expense
  .get("/documents/:id/payments", idParam, (c) => c.json(documentPayments(db, c.req.valid("param").id)))
  .get("/expenses/:id/payments", idParam, (c) => c.json(expensePayments(db, c.req.valid("param").id)));

export default app;
