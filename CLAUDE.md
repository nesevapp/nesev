# nesev

Local, single-user invoicing and bookkeeping app for an Austrian sole trader (a slim sevdesk clone). No auth, no cloud: it runs on localhost and all data lives in `data/`.

- **PLAN.md** – what exists, how each feature works, open decisions, and the ordered roadmap. Update it when a feature lands or a decision changes.
- **CONVENTIONS.md** – detailed code reference: layout, API/route patterns, forms, units. Read it before writing code.

## Commands
```bash
PORT=3998 bun run dev     # API :3998 (bun --hot) + Vite (5173, or the next free port, e.g. 5174) proxying /api
bun run typecheck         # tsc over everything – must be clean
bun test                  # all *.test.ts (in-memory DBs via createTestDb)
bun run build && bun start  # production: Hono serves SPA + API on PORT
bun run db:generate       # after editing src/server/db/schema.ts → new migration file (commit it)
```
Ports 3001/5173 are used by other projects on this machine, so always set `PORT`. The user's own instance runs on API 3998 / Vite 5174 with the real `data/`. Never touch it and never use `data/` for experiments.
Isolated test runs: `NESEV_DATA_DIR=/tmp/nesev-x PORT=39xx bun run dev:api` plus `bunx vite --port 51xx --strictPort` (with `PORT` set the same). **Stop only processes you started, by PID.** Never `pkill`/`kill` by name, pattern or port range: that has killed the user's server before.

## Stack
Bun · Hono (typed RPC via `hc`, `AppType`) · SQLite (`bun:sqlite`) + Drizzle · React + Vite + Tailwind v4 + shadcn/ui · TanStack Router (code-based) / Query / Table v9 · react-hook-form + zod 4 · pdfme 6 (PDF render + designer) · fflate (zip).

## Layout (short)
- `src/shared/` – logic used by server and web: money, `calcTotals`, tax modes, schemas, expenses/bank/tax-report definitions. No server- or DOM-only imports.
- `src/server/routes/<x>.ts` → mounted at `/api/<x>` in `app.ts`; `services/<x>.ts` hold DB logic plus tests; `lib/` holds numbering, paths, pdf, bank parsers and OCR.
- `src/web/sdk/` – the only API access: typed per-module hc clients, per-resource functions/types/queries/hooks, query keys (`keys.ts`) and cross-resource invalidation (`invalidate.ts`). Features call the API only through `@/sdk`; add new endpoints there.
- `src/web/features/<x>/` – `routes.tsx`, pages, components. Routes are registered in `src/web/app/router.tsx`, nav in `app-shell.tsx`.
- `data/` (gitignored): `nesev.db`, `assets/`, `pdfs/` (frozen PDFs), `receipts/`, `backups/`, `bin/` (compiled helpers).

## Invariants – don't break these
- Money is integer **cents**, quantity is **milli-units** (1000 = 1), rates are **basis points** (2000 = 20 %). Dates are `YYYY-MM-DD` strings. Format and parse only via `src/shared/money.ts`.
- Totals come only from `calcTotals(items, taxMode)` (shared by UI, API and PDF). Documents cache net/tax/gross whenever items change.
- Finalized documents are immutable: gapless number from `nextNumber()` inside the finalize transaction, client/seller snapshots, frozen PDF in `data/pdfs`. Corrections go through credit notes only.
- Credit notes store **positive** amounts. Every revenue figure has to subtract them.
- An invoice's open amount = gross − finalized credit notes − bank allocations (`services/bank.ts` helpers). Use those helpers; don't recompute it ad hoc.
- Expenses: `grossCents` = amount payable to the supplier (equals net for reverse charge / ig. Erwerb). Self-assessed tax is owed and deductible (see `src/shared/expenses.ts` header).
- Receipt OCR never runs on upload. Analysis is queued only on explicit user action. It's fully local (PDF text, Apple Vision, a llama-server that nesev starts itself), and results never overwrite saved data automatically.
- UI language is German. Tax output (UVA/ZM/EAR) is a helper, not tax advice.

## Gotchas
- **`bun --hot` can keep stale modules** (seen with `src/shared/*` and service files imported by other services): errors like "X is not defined" for an existing export, or old behaviour after an edit. Restart `bun run dev` before debugging further.
- **Migrations apply on server start only.** After a new migration, restart `bun run dev`; `--hot` doesn't re-run them.
- **drizzle-kit drops `ON DELETE …` when it `ALTER TABLE … ADD` a column with a FK.** Prefer new tables for new relations, or fix the generated SQL by hand. The user's DB has two such columns (`document_items.article_id`, `documents.recurring_invoice_id`) without SET NULL; services null them explicitly before deleting.
- bun:sqlite transactions are synchronous: no `await` inside `db.transaction`.
- Hono route handlers must be chained on one `new Hono()` or the RPC types are lost.
- Never type an `hc` client against the merged `AppType` in web code (the editor's TS server degrades to `never`); `sdk/client.ts` types each client against its route module. If the editor still shows `never` errors, trust `bun run typecheck`.
- The Apple Vision helper for receipt OCR is compiled on first use into `data/bin/`.
- Receipt OCR uses only llama.cpp: nesev spawns `llama-server` as its own child (handle on `globalThis`, pid file `data/llama-server.pid`). In tests use fake `ManagerDeps`, never the real binary. When testing for real, check `pgrep -P <your API pid> llama-server` and kill only that child; stopping your API process (SIGTERM) stops it too. Note: the server inherits nesev's env. An empty model path auto-picks from the GGUFs on disk (Qwen3.5-4B preferred).
- `src/server/lib/bank-parsers/fixtures/**` are byte-exact (CRLF, Windows-1252) via `.gitattributes`.

## Working style for this repo
- Bigger features have been built by parallel agents. The lead first lands the schema, migrations, route mounts, nav entries and placeholder pages in one go, so agents only touch their own feature folders. Keep doing that, and never let two agents generate migrations concurrently.
- Verify against reality: typecheck, tests, run the app on an isolated data dir, and look at generated PDFs (rasterize with `pdftoppm`).
- Commit only when the user asks.
