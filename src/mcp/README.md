# nesev MCP server

A local [MCP](https://modelcontextprotocol.io) server that lets an AI client (Claude Code, Claude Desktop, …) read nesev's
data: search, dashboard, documents, clients, articles, expenses, fixed costs, forecast, tax reports and assets.
It runs over **stdio** as a child process of the client. There's no network listener and no auth.

## Setup

```bash
bun run mcp                                   # = bun src/mcp/server.ts, speaks MCP on stdin/stdout
NESEV_DATA_DIR=/tmp/nesev-mcp bun run mcp     # against another data dir
```

| Env | Default | |
|---|---|---|
| `NESEV_DATA_DIR` | `<repo>/data` | same as the app (`src/server/lib/paths.ts`) |
| `NESEV_WEB_URL` | `http://localhost:5174` | base for the web links in tool results |

**Claude Code:**
```bash
claude mcp add nesev -- bun /path/to/nesev/src/mcp/server.ts
```
**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`). Desktop doesn't use your shell's
PATH, so give the absolute path to bun (`which bun`):
```json
{ "mcpServers": { "nesev": { "command": "/opt/homebrew/bin/bun", "args": ["/path/to/nesev/src/mcp/server.ts"] } } }
```
The entry resolves all paths from its own location, so the working directory doesn't matter.

**Try it by hand** against demo data. Never point these at `data/`:
```bash
NESEV_DATA_DIR=/tmp/nesev-mcp bun src/mcp/test/seed.ts            # demo clients, invoices, expenses, … (refuses data/)
NESEV_DATA_DIR=/tmp/nesev-mcp bun src/mcp/test/client.ts           # list tools
NESEV_DATA_DIR=/tmp/nesev-mcp bun src/mcp/test/client.ts get_document '{"id":1}' [--modern]
```

## Protocol

- SDK v2 (`@modelcontextprotocol/server`, pinned). `serveStdio(buildServer)` with the default `legacy: 'serve'`.
  2025-era clients (`initialize` handshake) and 2026-07-28 clients (`server/discover`) are both served from the same
  factory. Tests cover both.
- **stdout is the protocol.** `stdout-guard.ts` is imported first and sends `console.log/info/debug` to stderr,
  because some server modules log. Diagnostics go to stderr.
- The process exits when the client closes stdin. It doesn't start the app's background work (backup/recurring
  schedulers, receipt OCR queue, llama-server). That lives in `src/server/index.ts`, which the MCP never imports.

## Tools

All tools are read-only (`readOnlyHint: true`, `openWorldHint: false`). Each returns a short text summary plus
`structuredContent` matching its `outputSchema`. `tools/list` order is the registration order in `server.ts`.

| Tool | What |
|---|---|
| `search` | global search (names, numbers in any spelling, amounts) → ids + links. Start here. |
| `get_dashboard` | year KPIs, monthly revenue/expenses/result, overdue invoices |
| `list_documents` | offers/invoices/credit notes. Filters: type, status (incl. `open`, `overdue`), client, dates, query, limit |
| `get_document` | one document: items, tax groups, payment state, credit notes, PDF path, links |
| `list_reminders_due` | overdue invoices with dunning state and suggested level + fee |
| `list_clients` / `get_client` | clients; detail with open invoices |
| `list_articles` | article catalog |
| `list_expenses` / `get_expense` | expenses (period, query/supplier, open/paid/incomplete, category, receipt); detail with lines, bank payments, receipt path |
| `list_fixed_costs` | Fixkosten with interval, next payment, monthly equivalent |
| `get_forecast` | cash-flow forecast: KPIs, per-month in/out/balance, largest entries |
| `get_tax_report` | `uva` / `zm` / `ear` with Kennzahlen, warnings, disclaimer (a helper, not tax advice) |
| `list_assets` | Anlagenverzeichnis of a year: AfA, book values |

Output conventions (`format.ts`):
- Money is `{ cents, formatted }` (`"€ 1.234,56"`, de-AT).
- Dates are `YYYY-MM-DD`; text summaries use `dd.mm.yyyy`.
- Quantities are plain numbers and rates are percent numbers.
- Status labels are the German UI labels, including "Überfällig" and "(teilbezahlt)".
- Links point into the web UI (`NESEV_WEB_URL`). File paths are absolute.

Money **input** for write tools goes through `euroAmount` (zod: euro number or `"1.234,56"` / `"1234.56"` /
`"1,234.56"` → cents) or `eurosToCents()`.

## Layout

```
server.ts         entry: stdout guard, SERVER_INFO + instructions, TOOL_MODULES (order!), buildServer(), serveStdio
stdout-guard.ts   console.log/info/debug → stderr (first import)
api.ts            in-process typed hc clients (fetch = app.fetch, no HTTP), call() → typed body or ApiError
tool.ts           ToolContext (api, webUrl, dataPath), defineTool(), READ_ONLY annotations
format.ts         Money/money(), euroAmount/eurosToCents, qty/percent, dates, German status labels, text helpers
tools/<area>.ts   register<Area>Tools(server, ctx): overview, documents, clients, articles, expenses, finance
test/seed.ts      demo data through the API (refuses the default data dir)
test/client.ts    SDK client over stdio for tests and manual calls (legacy or --modern era)
mcp.test.ts       end-to-end: real entry as subprocess, both eras, every tool, errors, stdout purity
```

## Adding tools

1. Find or add the endpoint in `src/server/routes/<x>.ts`. Business logic stays in routes and services, and the MCP
   layer only calls and formats. If the route module has no client in `api.ts` yet, add one (`hc<typeof xApp>`).
2. In `tools/<area>.ts` (or a new module), call `defineTool(server, "snake_case_name", spec, handler)`:
   - `description` is written for an LLM: when to use the tool, what it returns, units.
   - `input` is a zod object. Use `euroAmount` for money, `isoDate` for dates, and plain numbers for quantities
     (`toMilli()` converts them).
   - `output` is a zod object that the handler's `data` must match exactly. The SDK and the client validate it.
     Use `Money` for amounts.
   - `annotations`: `READ_ONLY` for reads. For writes, use something like
     `{ readOnlyHint: false, destructiveHint: <bool>, idempotentHint: <bool>, openWorldHint: false }`.
   - The handler returns `{ text, data }`. Call the API with `await call(ctx.api.x...$post({ json }))`. A non-2xx
     response throws `ApiError`, and `defineTool` turns it into `isError: true` with the API's German message
     (`"Fehler: Beleg nicht gefunden"`). Don't catch it yourself.
3. A new module needs a `register<Area>Tools(server, ctx)` export and an entry in `TOOL_MODULES` in `server.ts`.
   Append it to keep the order stable.
4. Extend `mcp.test.ts`: add the tool name to `TOOLS` and the per-tool call list, and assert the interesting fields.
   Write tools should also verify the effect via a read tool.

## Safety model

- Local only: stdio child process of the user's client, single user, no network listener, no auth.
- Same data and rules as the web UI. Every call goes through nesev's Hono routes, which do validation, finalized
  documents' immutability, gapless numbering and the German error messages. There's no raw SQL in the MCP layer.
- The MCP process and the dev server may run at the same time on the same DB. SQLite runs in WAL mode with
  `busy_timeout`, so writes wait for the lock. Migrations run on import, as for the server.
- Read tools can't change anything. Write tools (added separately) must set honest annotations so clients can ask
  for confirmation. Destructive operations (delete, finalize, …) need `destructiveHint: true`.
- Tax output (UVA/ZM/EAR, AfA) is a helper, not tax advice. The tools say so in their descriptions and results.
