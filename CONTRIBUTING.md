# Contributing to nesev

Thanks for your interest. nesev is a small, local, single-user app for Austrian sole traders. Bug reports, fixes
and well-scoped features are welcome. For anything bigger than a fix, please open an issue first so we can agree on
the approach before you write the code.

## Setup

```bash
bun install
bun run demo                 # the app with demo data in its own data dir
```

Use a separate data dir and port for experiments, never your real `data/`:

```bash
NESEV_DATA_DIR=/tmp/nesev-dev PORT=3999 bun run dev:api
PORT=3999 bunx vite --port 5199 --strictPort       # Vite proxies /api to the same PORT
```

## Commands

| | |
|---|---|
| `PORT=3998 bun run dev` | API (`bun --hot`) + Vite dev server proxying `/api` |
| `bun run typecheck` | `tsc` over everything; must be clean |
| `bun test` | all `*.test.ts` (in-memory databases via `createTestDb`) |
| `bun run build && bun start` | production build: Hono serves the SPA and the API on `PORT` |
| `bun run db:generate` | after editing `src/server/db/schema.ts`: writes a new migration (commit it) |
| `bun run mcp` | the MCP server over stdio, see [src/mcp/README.md](src/mcp/README.md) |
| `bun run eval:chat` | assistant eval against a real local model, see [src/server/eval/README.md](src/server/eval/README.md) |

`bun --hot` sometimes keeps stale modules (errors like "X is not defined" for an export that exists). Restart
`bun run dev` before debugging further. Migrations apply on server start only, so restart after adding one.

## Before you open a pull request

- `bun run typecheck` and `bun test` pass.
- New logic has tests next to it (`services/<x>.test.ts`, `src/shared/*.test.ts`). Tests must not open the real
  database: use `createTestDb()`, or spawn a subprocess with `NESEV_DATA_DIR` like `chat.test.ts` / `mcp.test.ts`.
- You tried the change in the running app on a temporary data dir. For PDF changes, look at the generated PDF
  (e.g. rasterize it with `pdftoppm`).
- [PLAN.md](PLAN.md) is updated when a feature lands or a decision changes.

## Code

Read [CONVENTIONS.md](CONVENTIONS.md) before writing code. It covers the layout, the API route and SDK patterns,
forms, units and colors. The short version:

- **UI text is German**, code, comments and docs are English.
- **Money** is integer cents, **quantities** milli-units (1000 = 1), **rates** basis points (2000 = 20 %), dates
  `YYYY-MM-DD` strings. Format and parse only via `src/shared/money.ts`.
- **Totals** come only from `calcTotals(items, taxMode)`, shared by UI, API and PDF.
- **Finalized documents are immutable**: gapless number inside the finalize transaction, snapshots, frozen PDF.
  Corrections go through credit notes, which store positive amounts; every revenue figure subtracts them.
- An invoice's **open amount** comes from the helpers in `services/bank.ts`; don't recompute it ad hoc.
- The web app calls the API only through `src/web/sdk/` (`@/sdk`). New endpoints get a function, types, a query key
  and, where other views are affected, an entry in `invalidate.ts`.
- Hono routes are chained on one `new Hono()` so the RPC types survive. bun:sqlite transactions are synchronous: no
  `await` inside `db.transaction`.
- **Colors**: never hard-code palette colors (`text-red-700`, `bg-white`, `#2a78d6`). Use the tokens from
  `src/web/styles.css` (`bg-background`, `text-muted-foreground`, `text-success`, `bg-warning-muted`, chart variables)
  so light and dark mode both work. PDF content is the exception.
- Receipt OCR never runs on upload and never overwrites saved data automatically.
- Importing `src/server/app.ts` must stay side-effect free (the MCP server imports it); startup work belongs in
  `src/server/index.ts`.

The full list of invariants is in [CLAUDE.md](CLAUDE.md) (written for coding agents, but it applies to everyone).

## Database changes

1. Edit `src/server/db/schema.ts`.
2. Run `bun run db:generate` and commit the new file in `src/server/db/migrations/`.
3. Restart the server; migrations apply on start.

drizzle-kit drops `ON DELETE …` when it adds a foreign key column with `ALTER TABLE … ADD`. Prefer a new table for new
relations, or fix the generated SQL by hand.

## Bigger features

Larger features are usually split so several people (or agents) can work in parallel without conflicts:

1. One change lands the shared parts first: schema and migration, route mounts in `app.ts`, nav entries, placeholder
   pages and SDK stubs.
2. Each part then lives in its own files: `src/server/routes/<x>.ts`, `src/server/services/<x>.ts` (+ tests),
   `src/web/sdk/<x>.ts`, `src/web/features/<x>/`.
3. Shared files (`schema.ts`, `shared/totals.ts`, `shared/tax.ts`, `app.ts`, `router.tsx`) change only when necessary
   and in small steps. Never generate two migrations concurrently.

## Tax logic

Tax output (UVA, ZM, EAR, FinanzOnline XML, BMD export) follows Austrian rules. When you change it, cite the source
(law, BMF documentation, USP, a court decision) in the PR or in PLAN.md, and add a test with concrete figures.

## License

By contributing you agree that your contribution is licensed under the [AGPL-3.0](LICENSE), like the rest of the
project.
