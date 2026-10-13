# nesev conventions

Read PLAN.md first for the spec. This file covers how the code is organized.

## Commands
| | |
|---|---|
| `bun run dev` | API (`bun --hot`, :3001) + Vite (:5173, proxies `/api`). Override the API port with `PORT=3998 bun run dev` (Vite proxies to the same `PORT`). |
| `bun run build` / `bun start` | Build the SPA to `dist/web`, then serve SPA + API from Hono on `PORT` (3001) |
| `bun run db:generate` | After editing `src/server/db/schema.ts`, write a new migration to `src/server/db/migrations/` |
| `bun run db:migrate` | Apply migrations. Not normally needed: the server applies them on start. |
| `bun run typecheck` / `bun test` | `tsc` (TS 7) over everything / bun tests (`*.test.ts`) |

## Layout
```
src/shared/            used by server AND web; no server- or DOM-only imports
  money.ts             cents/qty/bp helpers, de-AT formatting + parsing
  totals.ts            calcTotals(items, taxMode): the only totals function (UI, API, PDF)
  tax.ts               TaxMode, defaultTaxMode(), EU_COUNTRIES, taxNoteFor(), AT_TAX_RATES_BP
  documents.ts         DocumentType/Status, German labels, formatDocumentNumber()
  countries.ts         COUNTRY_OPTIONS (German names) for pickers
  types.ts             ClientSnapshot, SellerSnapshot
  schemas/*.ts         zod DTOs (settings, client, document). Import `z` from ./zod (German messages).
src/server/
  app.ts               Hono app; mounts routes/*; exports AppType. Do not edit to add routes.
  index.ts             Bun entry (port, prod static/SPA fallback)
  routes/<x>.ts        one sub-app per resource, mounted at /api/<x>
  services/<x>.ts      DB logic reused across routes (e.g. getSettings, sellerSnapshot)
  lib/numbering.ts     nextNumber(tx, type, year): gapless, must run inside the finalize transaction
  lib/validate.ts      validate(target, schema): zValidator returning a uniform 400
  lib/paths.ts         DATA_DIR, ASSETS_DIR, PDFS_DIR, ...
  db/schema.ts         full Drizzle schema + row types (Client, Document, ...)
  db/index.ts          `db` singleton (data/nesev.db, auto-migrated). db/client.ts has createTestDb().
src/web/
  app/router.tsx       central route registry (one marked block)
  app/root-route.tsx   rootRoute (layout = app-shell.tsx sidebar)
  components/ui/*      shadcn primitives (add more: `bunx --bun shadcn@latest add <name>`, then fix the `cn` import to "@/lib/utils" if the CLI breaks it)
  components/page.tsx  <Page title actions> wrapper, PlaceholderPage
  components/form-fields.tsx  TextField/NumberField/TextareaField/SwitchField/FormSection for RHF
  lib/api.ts           typed client `api`, parseResponse, apiErrorMessage, fileUrl
  features/<feature>/  routes.tsx, pages, api.ts (query options + mutations), components
data/                  nesev.db, assets/, pdfs/ (gitignored)
```
Import aliases: `@/*` → src/web, `@shared/*` → src/shared, `@server/*` → src/server (web may only `import type` from it). Server code imports shared modules by relative path.

## Ownership (parallel agents)
- clients: `server/routes/clients.ts`, `services/clients.ts`, `web/features/clients/`, `shared/schemas/client.ts`
- documents: `server/routes/documents.ts`, `services/documents.ts`, `web/features/documents/` (/offers, /invoices, /credit-notes), `shared/schemas/document.ts`
- PDF/templates: `server/routes/templates.ts`, `services/pdf*.ts`, `web/features/templates/`
- Shared files (`schema.ts`, `shared/totals.ts`, `shared/tax.ts`, `app.ts`, `router.tsx`): change only when necessary, keep the change small, and say so in your report. A schema change means `bun run db:generate` and committing the new migration file.

## API routes
```ts
// src/server/routes/clients.ts: chain the calls so the types reach AppType
const app = new Hono()
  .get("/", (c) => c.json(rows))
  .post("/", validate("json", clientCreateSchema), (c) => { const body = c.req.valid("json"); ... return c.json(row, 201); })
  .get("/:id{[0-9]+}", (c) => ...);
export default app;
```
- Errors are JSON `{ error: string }` with a 4xx status. `throw new HTTPException(404, { message: "..." })` also works, because app.onError turns it into JSON.
- Use `db` from `../db`. Wrap multi-step writes in `db.transaction((tx) => ...)`. The transaction is synchronous (bun:sqlite), so don't `await` inside it. Helpers take `DbOrTx`.
- Files: `data/assets/x.png` is served at `/api/files/assets/x.png` and `data/pdfs/y.pdf` at `/api/files/pdfs/y.pdf`. Store paths in the DB relative to data/ (`"assets/x.png"`).

## Calling the API (web)
```ts
import { api, parseResponse, apiErrorMessage } from "@/lib/api";
export const clientsQuery = queryOptions({ queryKey: ["clients"], queryFn: () => parseResponse(api.clients.$get()) });
await parseResponse(api.clients[":id"].$put({ param: { id: String(id) }, json }));
```
Use React Query for everything. Keep query options and mutations in `features/<x>/api.ts`. Other features may import them (e.g. `settingsQuery` from `@/features/settings/api`). Show errors with `toast.error(apiErrorMessage(err))` from sonner.

## Pages and routes
Code-based TanStack Router, chosen over file-based so there's no codegen step and each feature registers its own routes. In `features/<x>/routes.tsx`:
```ts
const listRoute = createRoute({ getParentRoute: () => rootRoute, path: "/clients", component: ClientsPage,
  loader: ({ context }) => context.queryClient.ensureQueryData(clientsQuery) });
const detailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/clients/$id", component: ClientPage });
export const clientsRoutes = [listRoute, detailRoute] as const;
```
The existing features are already registered in `app/router.tsx`. Adding pages only touches your `routes.tsx`. Replace the `PlaceholderPage` in it. `<Link to>` is type-checked.
Forms use react-hook-form + `zodResolver(sharedSchema)`, typed `useForm<z.input<S>, unknown, z.infer<S>>`, with shadcn `<Form>` and the helpers in `components/form-fields.tsx`.
UI text is German. Style: light and minimal, using the `Page` wrapper, shadcn components, `text-sm`, and `tabular` class on number columns.

## Units and rules
- Money is integer **cents** (`*Cents`), quantity is integer **milli-units** (1000 = 1), and rates and discounts are integer **basis points** (`*Bp`, 2000 = 20 %). Format and parse only with `@shared/money`.
- Calendar dates are `"YYYY-MM-DD"` strings. Timestamps are ISO strings (`createdAt`, `finalizedAt`, ...).
- Text columns are NOT NULL DEFAULT `''`. Optional numbers, dates and references are nullable.
- Enums are text columns typed with the unions in `@shared` (`TaxMode`, `DocumentType`, `DocumentStatus`, `ClientType`).
- Totals: always use `calcTotals(items, taxMode)`. Line net is rounded per line and tax is computed per rate group. Store the net/tax/gross cache on the document whenever items change.
- Only `AT_DOMESTIC` charges VAT. Every other mode is 0 %, and its note comes from `taxNoteFor(mode, settings)`.
- Credit notes store positive amounts. Their meaning comes from the document type.
- Numbering: the draft's `number` is null. On finalize, call `nextNumber(tx, type, year)` in the same transaction that sets status, number, snapshots (`sellerSnapshot(getSettings(tx))` plus the client snapshot) and `finalizedAt`.

## Clients API
Client numbers are integers shown as `K-0001` (`formatClientNumber`/`parseClientNumber` in `@shared/schemas/client`). New clients get `max + 1` unless `number` is given. Numbers are unique but not gapless.
| | |
|---|---|
| `GET /api/clients?q=&archived=active\|archived\|all&country=DE` | List sorted by name. `q` matches name, contact person, email, city and the number (`K-0003`, `3`). |
| `GET /api/clients/picker?q=&limit=20` | Active clients only, for the picker |
| `GET /api/clients/next-number` | `{ number }` that the next auto-assigned client gets |
| `GET/PUT/DELETE /api/clients/:id` | DELETE returns 409 when documents reference the client (archive instead) |
| `POST /api/clients`, `POST /api/clients/:id/archive`, `.../unarchive` | |

Server: `getClient(db, id)`, `requireClient(db, id)` (404) and `clientSnapshot(client)` (→ `ClientSnapshot` for finalize) in `services/clients.ts`.
Web: `ClientDTO`, `clientQuery(id)`, `clientsQuery(filter)` and `clientPickerQuery(q)` in `features/clients/api.ts`. Use `<ClientPicker value={clientId} onChange={(client) => ...} />` from `features/clients/components/ClientPicker.tsx` (`client` is a `ClientDTO` or `null`). It also takes `placeholder`, `disabled`, `className`, `id` and `aria-invalid`. The "Dokumente" section on the client detail page renders `features/clients/components/client-documents.tsx`. The documents feature owns that component's body.
