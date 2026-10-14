# nesev MCP server

A local [MCP](https://modelcontextprotocol.io) server that lets an AI client (Claude Code, Claude Desktop, …) work
with nesev. Read tools cover search, the dashboard, documents, clients, articles, expenses, fixed costs, the
forecast, tax reports and assets. Write tools create clients, articles, drafts and expenses, finalize documents,
mark them sent or paid, create credit notes and reminders, and queue receipt analysis.

It runs over **stdio** as a child process of the client. There's no network listener and no auth.

## Setup

```bash
bun run mcp                                   # = bun src/mcp/server.ts, speaks MCP on stdin/stdout
NESEV_DATA_DIR=/tmp/nesev-mcp bun run mcp     # against another data dir
```

| Env | Default | Purpose |
|---|---|---|
| `NESEV_DATA_DIR` | `<repo>/data` | same data dir as the app (`src/server/lib/paths.ts`) |
| `NESEV_WEB_URL` | `http://localhost:5174` | base for the web links in tool results |
| `NESEV_API_URL` | `http://localhost:3998` | the running nesev server, used only by `queue_receipt_analysis` |

**Claude Code**, registered only for a dedicated folder (local scope), so other sessions don't see the tools.
The user's setup uses `/path/to/nesev-ai`:
```bash
cd /path/to/nesev-ai
claude mcp add --scope local nesev -- /opt/homebrew/bin/bun /path/to/nesev/src/mcp/server.ts
```
(`--scope user` would make it available in every project.)

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`). Desktop doesn't use your
shell's PATH, so give the absolute path to bun:
```json
{
  "mcpServers": {
    "nesev": {
      "command": "/opt/homebrew/bin/bun",
      "args": ["/path/to/nesev/src/mcp/server.ts"]
    }
  }
}
```

The entry resolves all paths from its own location, so the working directory doesn't matter.

**Try it by hand** against demo data. Never point these at `data/`, and set `NESEV_API_URL` to a port where nothing
listens, so nothing reaches your running server:
```bash
export NESEV_DATA_DIR=/tmp/nesev-mcp NESEV_API_URL=http://127.0.0.1:9
bun src/mcp/test/seed.ts                                           # demo data (refuses data/)
bun src/mcp/test/client.ts                                         # list tools
bun src/mcp/test/client.ts get_document '{"id":1}' [--modern]
bun src/mcp/test/client.ts create_invoice_draft '{"clientName":"Alpen","items":[{"title":"Beratung","quantity":2,"unit":"Std.","unitPrice":"95,00"}]}'
```

## Protocol

- SDK v2 (`@modelcontextprotocol/server`, pinned). `serveStdio(buildServer)` with the default `legacy: 'serve'`.
  2025-era clients (`initialize` handshake) and 2026-07-28 clients (`server/discover`) are both served from the same
  factory. Tests cover both.
- **stdout is the protocol.** `stdout-guard.ts` is imported first and sends `console.log/info/debug` to stderr,
  because some server modules log. Diagnostics go to stderr.
- The process exits when the client closes stdin.
- It doesn't start the app's background work: backup and recurring schedulers, the receipt OCR worker, llama-server.
  That work lives in `src/server/index.ts`, which the MCP never imports.
- `api.ts` refuses every non-GET request to `/api/receipts` in-process (403), because `POST /analyze` would start
  the OCR worker inside the MCP process.

## Tools

Each tool returns a short text summary plus `structuredContent` that matches its `outputSchema`. `tools/list`
returns the tools in registration order (`TOOL_MODULES` in `server.ts`): the read tools first, then the write tools.

### Read (`readOnlyHint: true`)

| Tool | What |
|---|---|
| `search` | global search (names, numbers in any spelling, amounts) → ids and links. Start here. |
| `get_dashboard` | year KPIs, monthly revenue/expenses/result, overdue invoices |
| `list_documents` | offers, invoices and credit notes. Filters: type, status (incl. `open` and `overdue`), client, dates, query, limit |
| `get_document` | one document: items, tax groups, payment state, credit notes, PDF path, links |
| `list_reminders_due` | overdue invoices with their dunning state and the suggested level and fee |
| `list_clients` / `get_client` | clients; the detail includes open invoices |
| `list_articles` | article catalog |
| `list_expenses` / `get_expense` | expenses. Filters: period, query/supplier, status (`open` = unpaid and complete, `paid`, `incomplete`), category, receipt. The detail has lines, bank payments and the receipt path |
| `list_fixed_costs` | Fixkosten with interval, next payment and monthly equivalent |
| `get_forecast` | cash-flow forecast: KPIs, in/out and balance per month, largest entries |
| `get_tax_report` | `uva` / `zm` / `ear` with Kennzahlen, warnings and a disclaimer (a helper, not tax advice) |
| `list_assets` | Anlagenverzeichnis of a year: AfA and book values |
| `get_receipt_analysis` | latest OCR result of an expense: suggested fields with confidence. Nothing is applied. |

### Create (`readOnlyHint: false`, `destructiveHint: false`)

| Tool | What |
|---|---|
| `create_client` | Refuses likely duplicates (same name without legal form, same UID or email) unless `allowDuplicate: true` |
| `create_article` | Unit must be one of the configured units; net price in euros; rate 20/13/10/0 % |
| `create_invoice_draft` / `create_offer_draft` | Client by `clientId` or `clientName` (must match exactly one client; otherwise the error lists the candidates). Each item has a `title` (required in the schema, so grammar-constrained local models can't drop it; `""` takes the article's title), quantity, a configured unit (the error lists them), a net `unitPrice` in euros, a rate and optionally an `articleId` for defaults. Tax mode, texts and dates default like in the UI. Returns the draft with totals. |
| `update_document_draft` | Drafts only. Changes the given fields; `items` replaces all lines |
| `create_expense` | Lines with net or gross, rate and deductible %; the VAT treatment defaults from country and UID. Optional: `receiptPath` (a local file, checked like the UI: PDF/JPG/PNG/WebP, ≤ 20 MB, plus the file content) and `fixedCostId` + `fixedCostSlot` |
| `queue_receipt_analysis` | Queues OCR on the running nesev server over HTTP (`NESEV_API_URL`). It first checks that the server uses the same data (each expense must match on number, supplier and receipt). Fails clearly when the server isn't running. |

### Change state (`destructiveHint: true`)

| Tool | What |
|---|---|
| `finalize_document` | **Irreversible.** Gapless number, frozen snapshots, locked document, PDF. Returns the number and the PDF path |
| `mark_document_sent` | Status Versendet (it doesn't send anything) |
| `mark_invoice_paid` | Manual payment on a date. `expectedAmount` must equal the open amount; partial payments go through the bank import |
| `convert_offer_to_invoice` | Creates an invoice draft and marks the offer accepted |
| `create_credit_note` | Credit note draft for a finalized invoice: the whole invoice, or selected positions with quantity and price overrides |
| `create_reminder` | Next dunning level for an overdue invoice. By default it is finalized at once (**irreversible**: MA number and PDF); with `finalize: false` it stays a draft |

The server's `instructions` tell the model that documents start as drafts and that it should show a draft and get
the user's confirmation before `finalize_document`.

There are no delete, settings, bank import or email tools.

### Conventions

Output (`format.ts`):
- Money is `{ cents, formatted }` (`"€ 1.234,56"`, de-AT).
- Dates are `YYYY-MM-DD`; text summaries use `dd.mm.yyyy`.
- Quantities are plain numbers and rates are percent numbers.
- Status labels are the German UI labels, including "Überfällig" and "(teilbezahlt)".
- Links point into the web UI. File paths are absolute.

Input:
- Money goes through `euroAmount`: a euro number or `"1.234,56"` / `"1234.56"` / `"1,234.56"`, converted to cents.
- Quantities are plain numbers (`toMilli`). Rates are percent numbers (`taxRateBp` accepts only 20/13/10/0).
- Units are checked case-insensitively against the configured units (`checkUnit`).

## Layout

```
server.ts         stdio entry: stdout guard, serveStdio(buildServer)
build.ts          SERVER_INFO + instructions, TOOL_MODULES (order!), buildServer(); importable without the guard (the
                  nesev server uses it in-process for the assistant, services/chat-tools.ts)
stdout-guard.ts   console.log/info/debug → stderr (first import)
api.ts            createApi(): in-process typed hc clients (fetch = app.fetch; non-GET /api/receipts refused unless inServer), call() → body or
                  ApiError; remoteApi(url) for the running server
tool.ts           ToolContext (api, webUrl, dataPath, apiUrl, inServer), createContext() (stdio) / createServerContext()
                  (inside the nesev server: app-path links, receipts in-process), defineTool(), ToolError, annotations
format.ts         Money/money(), euroAmount/eurosToCents, qty/toMilli/percent, dates, German status labels, text helpers
inputs.ts         write-tool inputs: resolveClientId (clientName), configured units, tax rates, itemInput/buildItems
tools/            read: overview, documents, clients, articles, expenses, finance
                  write: write-masterdata, write-documents, write-expenses, receipts (read + queue)
                  documentDetail/clientDetail/expenseDetail/articleRow are shared by the read and write tools
test/seed.ts      demo data through the API (refuses the default data dir)
test/client.ts    SDK client over stdio for tests and manual calls (legacy or --modern era)
test/fixtures/    small receipt.png / receipt.pdf / not-a-pdf.pdf for the upload tests
mcp.test.ts       end-to-end: the real entry as a subprocess in both eras; every tool, annotations, errors,
                  numbering, receipt upload, fake nesev server for queueing, stdout purity
```

## Adding tools

1. Find or add the endpoint in `src/server/routes/<x>.ts`. Business logic stays in routes and services; the MCP
   layer only calls and formats. If the route module has no client in `api.ts` yet, add one (`hc<typeof xApp>`).
2. In `tools/<area>.ts` (or a new module), call `defineTool(server, "snake_case_name", spec, handler)`:
   - `description` is written for an LLM: when to use the tool, what it returns, units. Start it with
     "IRREVERSIBLE:" when that applies.
   - `input` is a zod object. Use `euroAmount` for money, `isoDate` for dates, and plain numbers for quantities. Use
     `itemInput` / `buildItems` for document lines and `clientRefInput` / `resolveClientId` for clients.
   - `output` is a zod object that the handler's `data` must match exactly; the SDK and the client both validate it.
     Use `Money` for amounts. A tool that changes a document returns `DocumentDetail` via `documentDetail(ctx, id)`.
   - `annotations`: `READ_ONLY`, `CREATES` (new records, draft edits) or `CHANGES_STATE` (`destructiveHint: true`:
     finalize, status changes, anything irreversible). Override `idempotentHint` where it's true.
   - The handler returns `{ text, data }`. Call the API with `await call(ctx.api.x...$post({ json }))`. A non-2xx
     response throws `ApiError`; your own checks throw `ToolError`. `defineTool` turns both into `isError: true`
     with the German message (`"Fehler: …"`). Validate everything before the first write, so a failed call leaves
     nothing half-created.
3. A new module needs a `register<Area>Tools(server, ctx)` export and an entry at the end of `TOOL_MODULES` in
   `server.ts`, to keep the order stable.
4. Extend `mcp.test.ts`: add the tool name to `TOOLS` or `WRITE_TOOLS` (and to `STATE_CHANGING` if it's
   destructive), test the happy path and the errors, and check the effect with a read tool.

## Safety model

- Local only: a stdio child process of the user's client. Single user, no network listener, no auth.
- Same data and rules as the web UI. Every call goes through nesev's Hono routes, which handle validation, the
  immutability of finalized documents, gapless numbering, credit notes as the only correction and the German error
  messages. There's no raw SQL in the MCP layer.
- The MCP process and the dev server can run at the same time on the same DB. SQLite runs in WAL mode with
  `busy_timeout`, so writes wait for the lock. Migrations run on import, as they do for the server.
- No deletes, no settings, no bank import, no email. Receipt OCR is only *queued*, on the user's own running
  server, and its suggestions are never applied automatically.
- **What to allow permanently vs. confirm** (Claude Code: `/permissions`, or `permissions.allow` in
  `~/.claude/settings.json`):
  - **Allow:** all read tools. Rules name tools exactly (`mcp__nesev__search`); the snippet below allows the read
    tools.
  - **Usually fine to allow:** `create_client`, `create_article`, `create_invoice_draft`, `create_offer_draft`,
    `update_document_draft` and `queue_receipt_analysis`. These only add records or edit drafts, and any of it can
    be fixed or deleted in the web app.
  - `create_expense` is in the same category, but it copies a local file into `data/receipts`. Allow it if that's
    fine.
  - **Always confirm:** `finalize_document`, `create_reminder` (finalizes by default), `mark_invoice_paid`,
    `mark_document_sent`, `convert_offer_to_invoice` and `create_credit_note`. They change legal or bookkeeping
    state; finalized numbers and PDFs can't be undone.
- Tax output (UVA/ZM/EAR, AfA) is a helper, not tax advice. The tools say so in their descriptions and results.

```json
{
  "permissions": {
    "allow": [
      "mcp__nesev__search", "mcp__nesev__get_dashboard", "mcp__nesev__list_documents", "mcp__nesev__get_document",
      "mcp__nesev__list_reminders_due", "mcp__nesev__list_clients", "mcp__nesev__get_client", "mcp__nesev__list_articles",
      "mcp__nesev__list_expenses", "mcp__nesev__get_expense", "mcp__nesev__list_fixed_costs", "mcp__nesev__get_forecast",
      "mcp__nesev__get_tax_report", "mcp__nesev__list_assets", "mcp__nesev__get_receipt_analysis"
    ]
  }
}
```
