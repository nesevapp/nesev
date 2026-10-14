# nesev – Plan & Status

Local single-user sevdesk clone for an Austrian sole trader: offers, invoices, credit notes, clients, PDF designer, plus expenses, bank and tax helpers. EUR only. Clients in AT, EU and CH. No auth, runs on localhost.

Last updated: 2026-10-14 · Commits: `5ce3215` (base app), `b7d5a36` + `b409092` (finance), receipt OCR (see git log).

---

## 1. Status

| # | Area | Status | Where |
|---|------|--------|-------|
| 1 | Scaffold, settings, numbering, shared money/tax/totals | ✅ done | `src/shared`, `/settings` |
| 2 | Clients | ✅ done | `/clients` |
| 3 | Offers, invoices, credit notes | ✅ done | `/offers`, `/invoices`, `/credit-notes` |
| 4 | PDF output (pdfme), GiroCode, frozen PDFs | ✅ done | `services/pdf.ts`, `/api/pdf` |
| 5 | PDF template designer (slimmed, section reordering) | ✅ done | `/templates` |
| 6 | Dashboard, CSV/ZIP export, backups | ✅ done | `/`, `/export` |
| 7 | Article catalog + autocomplete in line items | ✅ done | `/articles` |
| 8 | Payment reminders (Mahnwesen) | ✅ done | `/reminders` |
| 9 | Recurring invoices + payment forecast | ✅ done | `/recurring`, `/forecast` |
| 10 | Unit list ("Einheit" dropdown) | ✅ done | Einstellungen → Einheiten |
| 11 | Expenses with receipt upload | ✅ done | `/expenses` |
| 12 | Taxes: UVA, ZM, EAR | ✅ done | `/tax` |
| 13 | Bank import + payment matching | ✅ done | `/bank` |
| 14 | On-demand local receipt OCR | ✅ done | `/expenses`, Einstellungen → Belegerkennung |
| 15 | Frontend SDK (`src/web/sdk`) | ✅ done | all features |
| 16 | Anlagenverzeichnis / AfA | ✅ done | `/assets` |
| 16 | Global search (⌘K) + keyboard shortcuts | ✅ done | sidebar „Suchen …“, `/api/search` |
| 17 | Fixkosten + outflows/balance in the forecast | ✅ done | `/fixed-costs`, `/forecast` |
| 18 | MCP server, part 1: core + read-only tools | ✅ done | `src/mcp`, `bun run mcp` |
| 19 | MCP server, part 2: write tools + receipt analysis | ✅ done | `src/mcp/tools/write-*`, `receipts.ts` |
| 20 | Crop/straighten photographed receipts | ✅ done | `/expenses/:id` receipt pane, `nesev-ocr detect-document`/`crop` |
| 21 | In-app assistant (local LLM + MCP tools): backend | ✅ done | `/api/chat`, `services/chat*.ts`, `lib/llama/lease.ts` |

---

## 2. How it works

### Core rules
- **Units:** money in integer cents, quantity in milli-units, rates in basis points. Dates are `YYYY-MM-DD`.
- **Totals:** `calcTotals(items, taxMode)` is the only totals function (UI, API, PDF). Line net is rounded per line and tax is computed per rate.
- **Tax modes** (per document, defaulted from the client's country and UID, can be overridden):

| Mode | When | Effect |
|---|---|---|
| `AT_DOMESTIC` | AT clients | 20 / 13 / 10 / 0 % per line |
| `EU_REVERSE_CHARGE` | EU B2B with UID | 0 %, reverse-charge note; client UID required |
| `THIRD_COUNTRY` | e.g. CH | 0 %, "nicht im Inland steuerbar" note |
| `SMALL_BUSINESS` | Kleinunternehmer (setting) | 0 %, §6 Abs 1 Z 27 note |

- **Lifecycle:**
  - Offer: draft → final → sent → accepted / declined.
  - Invoice: draft → final → sent → paid. Overdue is derived from the due date.
  - Credit note: draft → final.
- **Finalize** = one transaction that assigns a gapless number (`AN-`, `RE-`, `GS-`, `MA-`, `ER-YYYY-NNNN`), freezes client and seller snapshots and locks the document. Afterwards the PDF is frozen to `data/pdfs`. Corrections only via credit notes, which store positive amounts.
- **Conversions:** offer → invoice (any status; marks the offer accepted), invoice → credit note, duplicate.

### Clients & articles
- Clients are numbered `K-0001` and can be archived. Delete is blocked while documents reference the client.
- Articles are numbered `A-0001`. Typing a line title in any line-item editor suggests articles, most used first, and values are copied onto the line. "Als Artikel speichern" turns a line into an article. Usage counts up when a document is finalized.
- Units come from the configurable list in Einstellungen (default: Std., Stk., Tag, Woche, Monat, Jahr, Pauschal, km).

### PDFs & designer
- pdfme templates per type (offer, invoice, credit note, reminder). A default is seeded and each document can pick a template.
- Anything inside the top 30 mm or the bottom ~28 mm repeats on every page (header/footer). The body flows, and the items table breaks across pages.
- A letterhead PDF is drawn under the pages: its page 1 under the first page, its page 2 under all following pages.
- Designer: canvas plus one panel ("Aufbau" with ↑/↓ section reordering that really moves content, "Variablen", "Eigenschaften"). Text elements support `{placeholders}`.
- Invoices get an EPC/GiroCode QR (IBAN, amount, invoice number as reference).

### Dashboard
- Tiles for the selected year: Umsatz (net, vs. the same months of the previous year), Ausgaben (net, by document date), Ergebnis (Umsatz − Ausgaben, with margin), Bezahlt; second row: open invoices, overdue, open offers.
- Monthly chart: revenue (blue) and expenses (orange) as columns, result as a line; switches for "Ausgaben" (on by default) and "Vorjahr"; table view with the same columns. Expenses count by document date like revenue (the EAR on `/tax` counts by payment date); incomplete drafts have no lines and add nothing. `anlagen` lines are replaced by the AfA (1/12 per month).

### Reminders (Mahnwesen)
- Levels are configurable (default: Zahlungserinnerung €0, 1. Mahnung €10, 2./letzte Mahnung €20, each +7 days). The last level can repeat. Optional default interest (simple, actual days / 365).
- Only overdue, finalized, unpaid invoices can get a reminder. Open amount = gross − credit notes − bank payments. Fees and interest are not taxable.
- Reminder PDF with GiroCode for the total including fees. Bulk creation from "Fällig zum Mahnen", plus actions on the invoice view and the dashboard.

### Recurring invoices & forecast
- Intervals: monthly, every N months or yearly. The day of month anchors to the start date (31 Jan → 28/29 Feb → 31 Mar).
- Missed periods are caught up with one invoice each, and the end date is respected.
- Generated invoices are either drafts or auto-finalized; a failed finalize leaves a draft.
- A scheduler runs on server start and then hourly. "Jetzt ausführen" and "Rechnung jetzt erstellen" trigger it by hand.
- **Forecast** of incoming and outgoing money (gross) over 3, 6 or 12 months, plus the projected account balance (`services/forecast.ts`):
  - Inflows: open invoices on their due date plus that client's average payment delay (overdue = "now"), every planned recurring run, optionally drafts and open offers at a set probability. The VAT share is shown separately.
  - Outflows (toggle „Ausgänge“): every Fixkosten payment; unpaid expenses (paidAt null, with lines; open = gross − bank allocations) on their due date, without one at issue date + 14 days, overdue = "now"; ESt-Vorauszahlung (setting, per quarter) on 15.2./15.5./15.8./15.11.
  - USt-Zahllast (not for Kleinunternehmer): each UVA period due (15th of the 2nd month after it, next working day) inside the horizon. Amount = `computeUva()` of what is already recorded + an estimate for what the forecast still expects in the period (output VAT of inflows − deductible VAT of Fixkosten/unpaid expenses; dated by basis: Ist = payment date, Soll = invoice date, offers = today). Periods not yet over are marked „geschätzt“. Negative = refund (inflow). Assumes nothing was paid before the due date.
  - Balance: „Kontostand am <Datum>“ (setting) + all entries expected on/after that date. Per bucket: balance at the end and lowest day-end balance; KPI and red banner for the lowest point if it goes below 0.
  - Settings via the page's „Kontostand & Steuern“ popover or Einstellungen → Zahlungsprognose (`GET/PUT /api/forecast/settings`).
- **Fixkosten** (`/fixed-costs`, `/api/recurring-expenses`): recurring outgoing payments (name, recipient, expense category, gross, contained deductible VAT with a 20/13/10/0 % helper, monthly / every N months / yearly anchored like recurring invoices, start, optional end, active, notes). Forecast-only; nothing is booked automatically.
  - **Payments ↔ expenses** (`recurring_expense_payments`): an expense can be linked to one scheduled payment („Miete · Nov 2026“). The forecast then skips that slot; the expense counts instead (unpaid → „Offene Ausgabe“, paid → nothing), and being a real expense it is also in `computeUva`. Unlinked expenses for Fixkosten are still counted twice.
  - „Zahlungen & Belege“ per Fixkosten: last 12 + next 6 slots with status (verknüpft/bezahlt, geplant, „überfällig – ohne Beleg“); actions „Ausgabe erfassen“ (`/expenses/new?fixedCost=<id>&slot=<date>`, prefilled and linked on save), „Verknüpfen“ (unlinked expenses ± 60 days, matching first), „Verknüpfung lösen“. The list shows slots of the last 90 days without a receipt.
  - Suggestions: active Fixkosten, free slot, supplier (normalized) or category matches, amount ± 5 %, issue/due/paid date ± 10 days of the slot; supplier matches rank first. The expense editor shows the link („Fixkosten: Miete · Nov 2026“, lösen) or the best suggestion as a one-click „verknüpfen“.
  - Links cascade when the expense or the Fixkosten entry is deleted.

### Expenses (Ausgaben)
- Fields: supplier, UID, country, supplier invoice number, dates, VAT treatment (`domestic`, `reverse_charge`, `ig_acquisition`, `import`, `none`).
- Lines carry an EAR category, rate, stored tax (can be overridden to match the receipt) and deductible share.
- `grossCents` = amount payable to the supplier. For reverse charge / ig. Erwerb that equals net, and the self-assessed tax is owed and deductible.
- Receipts (PDF/JPG/PNG/WebP, ≤ 20 MB) go to `data/receipts/<year>/`. Dropping several files creates incomplete drafts (no lines), which reports exclude with a warning.
- **Crop/straighten photo receipts** (receipt pane → crop icon; JPG/PNG/WebP only, on explicit action, never on upload). The dialog shows the original photo with the outline suggested by the Swift helper (`nesev-ocr detect-document`: Vision document segmentation, ignored below confidence 0.3 or 3 % of the image, then `VNDetectRectanglesRequest` tuned for long receipts; nothing found → whole image) and four draggable corners (pointer events, arrow keys ± 0.4 %, Shift ± 2 %; crossed/too small quads can't be saved). Buttons: „Automatisch erkennen“, „Ganzes Bild“, optional „Schwarz-Weiß, mehr Kontrast“, „Zuschneiden speichern“.
  - `nesev-ocr crop` cuts the quad out with `CIPerspectiveCorrection` (EXIF orientation applied first; quads are normalized on the image as displayed), max. 3000 px long side, JPEG q 0.9 (PNG stays PNG). Core Image's output aspect was within ~4 % of the real sheet on rendered pinhole-camera test photos; a Zhang–He focal-length estimate was tried and dropped (no better, worse on small/off-center shots).
  - Files: the crop is written next to the original (`<original stem>-crop-<ts>.jpg`), `attachmentPath` → crop, `attachmentOriginalPath` → original. Re-cropping always starts from the original and deletes the previous crop; „Original wiederherstellen“ deletes the crop and clears `attachmentOriginalPath`. Replacing/removing the receipt or deleting the expense removes both files.
  - API: `GET /api/expenses/:id/receipt/detect`, `POST …/receipt/crop {quad, enhance}`, `POST …/receipt/restore` (422 for PDFs or without the helper). The pane shows „Zugeschnitten · Original anzeigen · Original wiederherstellen“.
  - Analysis uses `attachmentPath`, so it reads the crop; earlier analyses become stale („Beleg wurde ersetzt oder zugeschnitten – neu analysieren“). On rendered test photos (tilted/perspective receipts on wood), Vision OCR of the uncropped photo mixed up the columns and the model got the 20 % tax line wrong on 2 of 3; after cropping, all 3 were fully correct.
  - The backup ZIP now also contains `receipts/` (it had none before). The accountant export only covers outgoing documents, so receipts aren't part of it.

### Taxes (`/tax`) – a helper, not tax advice
- **UVA:**
  - Month or quarter, per settings. Ist- or Sollbesteuerung, per settings.
  - Mapped to the U30 Kennzahlen (000, 022/029/006/037, 016, 057/066, 070/072/065, 060, 061, 090 → 095).
  - Each KZ opens the documents behind it and has a copy button. The due date is shown.
- **ZM:** per EU client UID, the sum of reverse-charge services.
- **EAR:** by payment date. Expenses grouped by category with an E1a suggestion, warning for Bewirtung. Expense lines with category `anlagen` are capitalized (not expensed); instead the AfA of the year and the remaining book value of assets disposed in the year come from the Anlagenverzeichnis under KZ 9130 ("Anlagen" group, expandable to the assets; also listed in the CSV). Warning when an expense of the year has `anlagen` lines but no linked asset. The UVA is unchanged: input VAT on assets is deductible at once.
- CSV export for each report.

### Anlagen / AfA (`/assets`) – a helper, not tax advice
- `fixed_assets`, numbered `AV-0001` (max + 1). Math in `src/shared/assets.ts` (pure, cents), shared by server and the live preview in the form.
- Straight-line AfA: annual = cost / useful life (rounded). Halbjahresregel: in service ≤ 30.6. → full AfA in the first year, otherwise half plus one extra year with the rest. The last year takes the remainder, so the AfA sums to the cost exactly. Cost = net + non-deductible VAT (Kleinunternehmer: gross).
- Disposal (sold / scrapped): regular AfA in the disposal year (full-year rule, kept simple) plus the remaining book value written off in that year; proceeds are only shown ("als Einnahme erfassen"), not booked.
- Useful-life suggestions (Computer 3, Smartphone 3, Software 4, Büromöbel 10, Maschinen 8, PKW 8 = § 8 Abs 6 minimum); free input 1–50.
- Register per year (book value 1.1., AfA, Restbuchwert-Abgang, book value 31.12., totals, CSV), detail with schedule and link to the source expense, edit / Ausscheiden / delete.
- Expense editor: a line with category `anlagen` shows a hint with "Im Anlagenverzeichnis anlegen" (prefilled from the saved expense's `anlagen` lines, minus assets already linked) or links to the linked assets.
- Dashboard: `anlagen` lines are left out of expenses; the year's AfA is spread evenly over the 12 months (remainder in December, also for the current year), a disposal write-off counts in its month. The EAR monthly view uses the same split.

### Bank
- **Import:** camt.053/052/054 and CSV.
  - Tested against fixtures: camt, N26, Revolut, Wise.
  - Built from memory, still to verify with real exports: George, ELBA, BAWAG, Revolut Business.
  - Everything else goes through a generic column mapper, remembered per account.
  - Duplicates are skipped via a hash, there's a preview before committing, and an import can be undone.
- **Matching:** the invoice number in the payment text (in any spelling), exact amount, IBAN learned per client or supplier, name similarity.
  - Auto-apply per account: off, safe (default) or aggressive, and only when exactly one candidate qualifies. Everything else is a one-click suggestion.
  - Split and partial payments are supported. A covered invoice becomes paid with the booking date, and unmatching reverts that.
- **Payment status of invoices** (`settleInvoice` in `services/documents.ts`):
  - An invoice is paid once finalized credit notes plus bank allocations cover its gross. Finalizing a credit note checks this too: paidAt = the later of its issue date and the last payment. A payment marked by hand is never moved or reverted automatically.
  - "Zahlung zurücksetzen" on an invoice with bank allocations returns 409 unless `removeAllocations: true` is sent; the UI asks "Zuordnungen ebenfalls entfernen?" and the transactions become open again.
  - Lists show "teilbezahlt" next to the status and the open amount under the gross (invoice list, dashboard "Überfällig"). An invoice with nothing left to pay is never overdue or open (dashboard, reminders, forecast).
  - Paid via credit note ≠ cash received: Istbesteuerung/EAR count no payment for it, the dashboard's "Bezahlt" uses gross − credit notes, and the forecast's payment-delay history skips it.

### Receipt OCR
- Upload never analyses anything. The user queues an analysis per receipt or in bulk, and a background worker processes the queue one receipt at a time.
- Pipeline: embedded ZUGFeRD/XRechnung XML (no model) → PDF text layer → Apple Vision OCR (Tesseract fallback) → rule-based extractor + local model (llama.cpp, temperature 0, thinking off, JSON-schema `response_format`).
- Model: only llama.cpp. The Ollama and OpenAI-compatible (Unsloth Studio) providers were removed on 2026-10-14. Settings stored with their old keys still load because the schema drops unknown keys. `services/receipt-llm.ts` holds the prompt, the schema, the answer mapping and the HTTP client for llama-server (`POST /v1/chat/completions` with a strict `json_schema`). llama-server enforces the schema as a grammar, so there is no prompt-only fallback.
- llama-server (`lib/llama/{paths,server}.ts`, `services/receipt-llama.ts`): nesev spawns `llama-server` itself on the first model run of a batch (127.0.0.1, free port, random key via `LLAMA_API_KEY`, `--offline --jinja --reasoning off -np 1 --no-webui`, `--mmproj` only in vision mode), waits for `/health` (120 s timeout) and reuses it for the batch. It is stopped after the batch ("nach der Analyse beenden") or after 5 min idle. An idle server is also stopped when a settings change affects it (or the LLM is switched off), and on nesev exit (SIGINT/SIGTERM/SIGHUP/exit handlers). Handles live on `globalThis` (`bun --hot` safe). `data/llama-server.pid` lets the next start reap a child orphaned by a hard kill, but only if that PID still runs llama-server on the recorded port.
  - Binary: configured path, else `~/.unsloth/llama.cpp/build/bin/llama-server`, PATH, `/opt/homebrew/bin`.
  - Models: GGUFs found in the HF cache (`HF_HUB_CACHE`), `~/.cache/llama.cpp`, `~/Library/Caches/llama.cpp`, `~/.unsloth`, `~/.lmstudio/models` (no mmproj, ≥ 50 MB, split models once) or a free path. An empty model path means automatic: a `Qwen3.5-4B` GGUF (one with mmproj first), else the first one found. The status shows "Automatisch: unsloth/Qwen3.5-4B-GGUF · UD-Q4_K_XL", so existing settings work without changes.
  - mmproj: configured, else the `mmproj*.gguf` next to the model (F16 > BF16 > F32 > by name).
  - No automatic download. Without any GGUF the status suggests `llama-server -hf unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL`.
  - Errors (binary/model missing, load failure from the log tail, timeout) degrade to rules-only. "Testen" starts a separate server, reads a sample receipt and stops it. Timings get `server` (start incl. load).
- Measured on M4 with Qwen3.5-4B UD-Q4_K_XL (auto-picked, warm page cache, generated PNG receipt): text mode server start 0.76 s, model 5.1–6.3 s per receipt; vision mode (auto mmproj-F16) server 1.0 s, model 5.4–7.7 s. All main fields were correct. One server per batch, gone afterwards. Earlier run: gemma-4-E2B Q4 text 3.4–5 s per receipt.
- Settings (Einstellungen → Belegerkennung): OCR engine; LLM on/off; mode text/vision; llama.cpp model (automatic, a discovered GGUF or a path), llama-server path, mmproj, context size; stop llama-server after the batch. The status shows the Vision helper, Tesseract and llama.cpp (binary, model, vision, server).
- The extracted fields are checked: amounts must add up, UID and IBAN must be valid, and known suppliers are recognised.
- In the editor, "Erkennung" suggestions only fill empty fields and are saved only when the user saves.
- Post-processing: descriptions are cut to a short form (≤ 6 words / 60 chars, first sentence, no dangling words; `shortDescription` in `src/shared/receipts.ts`). Category keywords come in two tiers: unambiguous trades/suppliers (Elektriker, Installateur, Reparatur, Wartung → Instandhaltung; Werkstätte/Tankstelle → KFZ; Steuerberater → Beratung; SVS) at 0.7, which overrides the model category unless the model reports ≥ 0.9; generic keywords stay a 0.45 hint.

### Frontend SDK
- `src/web/sdk/`: one typed `hc` client per route module (typed only against that module, which keeps editor type checking light), `<resource>Api` functions, consistently named types (`Client`, `DocumentListItem`, `ExpenseInput`, …), query options + mutation hooks, a central query-key factory (`keys.ts`) and a cross-resource invalidation map (`invalidate.ts`). For example, a bank match refreshes bank, documents, expenses, dashboard, forecast, reminders and tax.
- Features call the API only through `@/sdk`; new endpoints get added there.

### Search & shortcuts
- **⌘K / Ctrl+K** (or `/`, or „Suchen …“ in the sidebar) opens the command palette (`features/search/`, cmdk with `shouldFilter={false}`). Empty query: recently opened entries (localStorage `nesev.search.recent`, max 8), create actions, pages. Typing filters pages/actions client-side and queries `GET /api/search?q=&limit=` (debounced 150 ms), Enter opens the route.
- **Server** (`services/search.ts`): grouped results (default 6 per group) for Kunden, Rechnungen, Angebote, Gutschriften, Mahnungen, Serienrechnungen, Ausgaben, Fixkosten, Anlagen, Artikel. Each result has `label`/`sublabel`/`meta` and the frontend `path`.
  - Text: escaped LIKE over a folded form (lower-case, umlauts/ß/some accents, plus an "ae/oe/ue" variant, so Müller = Mueller = muller). The fold is nested `replace()` calls; SQLite's parser overflows at ~28 levels, so keep the pair list short.
  - Numbers in any spelling: `RE-2026-0012`, `RE-2026-12`, `2026-0012`, `re12`, `12` (any year); a prefix (RE/AN/GS/MA/ER/K/A/AV) limits the number match to that type. Documents also match the live and the snapshot client name; reminders their invoice number.
  - Amounts (`1.234,56`, `1234.56`, `500 €`) match gross/net (documents, expenses), the payment (Fixkosten) or the cost (Anlagen).
  - Ranking: exact number → number of any year → amount → text, then newest; groups with a number/amount hit come first.
- **Shortcuts** (`use-global-shortcuts.ts`, ignored while typing, while a dialog/menu is open and when a page already handled the key): `?` overview, `/` search (the bank list keeps its own `/`), `g` + d/p/a/r/g/m/w/e/f/v/b/s/k/i/x/, go to a page, `n` + r/a/g/k/e/w create. The map lives in `features/search/commands.ts` and the overview reads it.

### MCP server (`src/mcp`, details in `src/mcp/README.md`)
- Local stdio MCP server for AI clients (Claude Code / Desktop): `bun run mcp`, respects `NESEV_DATA_DIR`; web links use `NESEV_WEB_URL` (default `http://localhost:5174`). SDK v2 (`@modelcontextprotocol/server` 2.3.1, pinned) via `serveStdio` with `legacy: 'serve'`, so 2025-era (`initialize`) and 2026-07-28 clients both work.
- In-process: typed `hc` clients per route module whose `fetch` is `app.fetch` (no HTTP, no port, no raw SQL). Validation, rules and German error messages come from the routes; a non-2xx becomes a tool error (`isError: true`) with the API's message. It never imports `src/server/index.ts`, so no schedulers / OCR queue / llama-server run in the MCP process; it exits when stdin closes.
- stdout is reserved for JSON-RPC: `stdout-guard.ts` (first import) routes `console.log/info/debug` to stderr.
- 14 read-only tools (`readOnlyHint`, `openWorldHint: false`), in a fixed order: `search`, `get_dashboard`, `list_documents` (status incl. `open`/`overdue`), `get_document` (items, tax groups, payments, credit notes, absolute PDF path), `list_reminders_due`, `list_clients`, `get_client` (open invoices), `list_articles`, `list_expenses`, `get_expense`, `list_fixed_costs`, `get_forecast`, `get_tax_report` (uva/zm/ear, with disclaimer), `list_assets`.
- 14 write tools after them. Create (`destructiveHint: false`): `create_client` (refuses likely duplicates unless `allowDuplicate`), `create_article`, `create_invoice_draft` / `create_offer_draft` (client by id or unambiguous name, items with plain quantity, configured unit, net euro price, 20/13/10/0 %, optional `articleId`; tax mode/texts/dates default like the UI), `update_document_draft` (drafts only), `create_expense` (net or gross lines, VAT treatment from country/UID, optional local receipt file checked like the UI incl. content sniffing, optional Fixkosten slot link), `queue_receipt_analysis`. State-changing (`destructiveHint: true`): `finalize_document` (irreversible; number + PDF path), `mark_document_sent`, `mark_invoice_paid` (`expectedAmount` must equal the open amount), `convert_offer_to_invoice`, `create_credit_note` (full or selected positions with quantity/price overrides; a draft), `create_reminder` (finalized by default: MA number + PDF). Plus `get_receipt_analysis` (read). No delete/settings/bank/email tools.
- Receipt analysis never runs in the MCP process: `api.ts` refuses non-GET `/api/receipts` in-process (the analyze route kicks the worker). `queue_receipt_analysis` calls the running nesev server over HTTP (`NESEV_API_URL`, default `http://localhost:3998`), first checking per expense (number, supplier, receipt path) that the server works on the same data, and fails with a clear message when it isn't reachable.
- `list_expenses` status `open` excludes incomplete drafts (they come with `incomplete`).
- Output: short text summary + `structuredContent` matching an `outputSchema`; money as `{ cents, formatted }`, dates `YYYY-MM-DD`, quantities/rates as plain numbers, German status labels, web links. Money input for write tools: `euroAmount` (euro number or "1.234,56" / "1234.56" → cents).
- Adding a tool: `defineTool()` in `src/mcp/tools/<area>.ts` with `READ_ONLY` / `CREATES` / `CHANGES_STATE`, module appended to `TOOL_MODULES` (`server.ts`), test in `mcp.test.ts` (convention, and which tools to allow permanently vs. confirm, in the README).
- Tests spawn the real entry on a seeded temp dir (`src/mcp/test/seed.ts`, through the API) and drive it with the SDK client in both eras: every tool, annotations, gapless numbering, draft-only edits, receipt upload (fixtures), a fake nesev server on a random port for queueing, the in-process receipts guard, and a raw stdout-purity check.

### Assistent – UI (`features/chat/`, `sdk/chat.ts`)
- Side panel on the right of the app shell (420 px, pushes the content), toggled with **⌘J / Ctrl+J** (also while typing) or „Assistent“ under the search button; Esc closes it (not while a menu/dialog is open). Open state and the selected conversation persist in localStorage `nesev.chat`. Once opened it stays mounted, so an answer keeps streaming while the panel is closed.
- Header: status dot (tooltip from `GET /status`: ready / loaded / problem / live status line), title (click to rename), „Neu“ (the conversation is only created on the first message), Verlauf dropdown (switch, delete with confirm), link to Einstellungen#assistent.
- Streaming: `streamChat()` POSTs and parses the `text/event-stream` itself (`sdk/sse.ts`, tested incl. split chunks and split UTF-8). Events are applied to the cached conversation detail (`applyEvent` in `use-chat-session.ts`), so the list always renders from one source; at the end of a turn the conversation + list are refetched (1 s later after a Stop, when the server has stored the partial answer) and the views the turn's write tools touched are invalidated (`chatToolChanges`: documents / clients / articles / expenses / reminders / receipts).
- Messages: user bubbles; assistant text through a small Markdown subset (`markdown.ts` parser → AST → React, never raw HTML; links only to app paths, `/api/files/…` and http(s); local `http://localhost:*` links become router links; file-system paths stay text). Tool calls as compact cards (German label + icon per MCP tool in `tools.ts`, args summary, result summary, link buttons, red on error, raw args on click). Confirmation card for `pending`/`confirm` („Ausführen“ destructive for finalize/credit note, „Abbrechen“); the composer is locked until answered.
- Composer: autosizing textarea, Enter sends / Shift+Enter newline, Stop (aborts the fetch), disabled with the reason + settings link when the model isn't ready. Sends `context { path, title }`; the title comes from the query cache (e.g. „Rechnung RE-2026-0004“, „Kunde …“, „Ausgabe …“) or the page name; the chip above the composer drops it for the next message.
- Settings section „Assistent“ (`#assistent`): status rows, enable switch, model path + picker of discovered GGUFs (reuses `/api/receipts/llamacpp/models`, „Automatisch: …“ entry), context size 8k–64k, reasoning switch.

### Assistent (in-app chat, fully local)
- Contract `src/shared/chat.ts`; server `routes/chat.ts`, `services/chat.ts` (conversations + agent loop), `chat-llm.ts` (streaming client), `chat-tools.ts` (MCP host, tool selection, results, confirmation texts), `chat-settings.ts` (settings, model, status). Tables `chat_conversations` / `chat_messages` (OpenAI message order; tool results are own rows).
- **Model:** nesev's own llama-server. Settings (Einstellungen, `settings.chat_settings` JSON, invalid/unknown keys fall back per field): on/off, model (empty = the receipt recognition's model, i.e. Qwen3.5-4B auto-pick, so both share one server), context 32768, reasoning off. The binary is the one configured for receipt recognition. Chat runs text-only. Model list for the picker: `GET /api/receipts/llamacpp/models`.
- **Reasoning per request:** the server keeps `--reasoning off`; chat sends `chat_template_kwargs: {enable_thinking}` per request (verified with build 10430: it overrides the flag). Thinking text is not stored; the UI gets one `thinking` event. An empty answer after thinking is retried once without reasoning.
- **Sharing llama-server with receipt OCR** (`lib/llama/lease.ts`, `getLlamaLease()`): a process-wide FIFO lock around "ensure config + request". The OCR worker takes it per receipt, chat per model call, so neither restarts the server under the other. A running server is reused when it satisfies the request (same binary + model, ≥ context, projector if needed): OCR (8k, text) runs on chat's 32k server without a restart; only chat after an 8k OCR server restarts once. Chat keeps the server warm: after each call the 5-min idle stop is re-armed; `unloadAfterBatch` and OCR settings changes don't stop it while chat used it in the last 5 min; changing the chat settings stops an idle server that no longer fits. Measured: OCR queued during a chat answer waited for the lock and then ran on the same server (same PID).
- **Tools = the MCP tools in-process:** an MCP client linked to `buildServer()` (`src/mcp/build.ts`, no stdout guard) over the SDK's `InMemoryTransport`, loaded lazily. `createServerContext()` gives app-path links (`/invoices/12`) and `inServer: true` (receipt POSTs served in-process, `queue_receipt_analysis` queues directly). MCP definitions → OpenAI `tools` (`$schema` stripped). Results: text → model; structured content → `ChatToolResult` (first line as summary; every `link` plus a PDF url as links, max 6).
- **Tool selection:** all 28 definitions cost ≈ 13k tokens in Qwen3.5's template (read tools ≈ 4k; measured with `/apply-template` + `/tokenize`). With 32k context all tools are always sent: a stable tool block keeps llama-server's prompt cache valid across turns and conversations. Below that budget (≤ 60 % of what's left after system prompt and answer reserve): read tools + write tools by intent (German keywords of the last 3 user messages, the current page, tools used recently).
- **Agent loop:** history from the DB (capped by an estimate of 2.7 chars/token: old tool results cut to 600 chars first, then the oldest turns dropped), streamed `/v1/chat/completions` (temperature 0.4, top_p 0.8, top_k 20, `parallel_tool_calls: false`, max 2048 tokens / 8192 with reasoning), deltas → SSE, tool calls parsed from streamed chunks and executed, up to 8 model calls per turn. The first call of a data question ("Umsatz", "Rechnung", numbers, …) uses `tool_choice: "required"` (the 4B otherwise invented figures).
- **Guards for small models:** bad JSON / unknown tool → tool error back to the model; the same failing call repeated unchanged isn't executed again; the 2nd such incident ends the turn with a German error. A repetition loop in the text (block ≥ 60 chars 3×) is cut and generation stopped. The prompt forbids claiming success without a tool result.
- **Cards** (`chat-cards.ts`, built from structured content only): documents, document/client/expense/fixed-cost/asset/search lists, dashboard and forecast charts, tax KPIs; bank overview (KPIs), bank transactions (table), one transaction (suggestions while open, else its allocations; also for match/unmatch/ignore), recurring invoices (table; generating one shows the document card).
- **Confirmation:** tools with `destructiveHint` (= `CONFIRM_TOOLS`; a test keeps them in sync) are not executed: the tool row is stored `pending` with a German summary (e.g. "Rechnung (Entwurf, id 6) für Alpen Software GmbH über € 540,00 finalisieren – vergibt die Nummer …"; mark paid shows the open amount; bank matching names the booking, the targets and the amount, unmatching says what becomes unpaid again, recurring invoices are looked up by id for name, client, amount and finalize/draft), `confirm` ends the stream. `POST /confirm` executes or cancels ("Der Nutzer hat abgelehnt") and continues the loop. New messages while pending or while a reply runs → 409.
- **Prompt:** German, today's date, company name, amounts `€ 1.234,56`, search before guessing ids, numbers only from tool results, drafts first (no number yet), tax = helper, deletes/settings/bank/email → web app, Markdown links with app paths. The page context goes into the user message as "(Kontext: Der Nutzer sieht gerade Rechnung id 12 („…“).)", not the system prompt, so the cached prefix stays stable.
- **SSE:** `event: <type>` + `data: <json>`; `: ping` comments every 5 s (Bun.serve closes connections idle for 10 s – a cold first prompt takes longer). Client disconnect aborts the llama request; partial text is kept.
- **Measured** (M5 Pro, Qwen3.5-4B UD-Q4_K_XL, 32k, all tools): server start 1.3–1.8 s; first prompt of a fresh server (≈ 13.5k tokens) 8.5–9 s to the first token; later calls 0.2–1.7 s to the first token (prompt cache), 2–6 s per call; a full "Rechnungsentwurf anlegen" turn ~7–20 s depending on how many lookups the model does. Qwen3.8-27B UD-Q5_K_XL: start 24 s, first prompt 43 s, then ~1 s to the first token and ~10 tok/s; it got every step right on the first try (4B needed the guards: it dropped item titles until `title` became required in the schema, invented numbers without forced tool use, repeated paragraphs).

### Data, export & backups
- Everything lives in `data/` (gitignored).
- Daily automatic DB snapshot to `data/backups/` (newest 14 kept), plus a manual backup ZIP (DB snapshot + assets + PDFs).
- Accountant export: CSV (BOM, `;`, decimal comma) and a ZIP with all PDFs for a period.

---

## 3. Open decisions (for the user / Steuerberater)
1. **UVA, B2B services to EU clients:** currently not in the UVA, only in the ZM (per BMF guidance). There's a toggle to report them in KZ 000/021 instead. Confirm.
2. **Wording of the tax notes** for reverse charge, third country and Kleinunternehmer (editable in Einstellungen).
3. **Default interest rate** in Mahnwesen (placeholder 11.2 % p.a. = base rate + 9.2 pp). Check against the current OeNB base rate.
4. **Ist- vs. Sollbesteuerung** and monthly vs. quarterly UVA: set in Einstellungen → Umsatzsteuer.
5. **AfA details for the Steuerberater:** Halbjahresregel also in the disposal year (currently: full AfA + Restbuchwert, same total); whether the Restbuchwert belongs in KZ 9130; useful-life defaults; PKW Angemessenheitsgrenze (40.000 €) and private use; Investitionsfreibetrag / degressive AfA (not modelled); GWG ≤ 1.000 € may also be capitalized (allowed, form only warns).
6. **Optional DB constraint patch** for the two FK columns without `ON DELETE SET NULL` (handled in code today).

---

## 4. Roadmap (in order)
1. **Test receipt OCR with real receipts.** nesev starts llama.cpp itself; it needs a GGUF on disk (run `llama-server -hf unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL` once).
2. **Verify bank presets with real exports** from the user's bank (George / ELBA / …) and fix the presets.
3. **Email sending** (SMTP): PDF attachment, text templates per document type, auto-mark as sent, send log.
4. **Down payment / final invoice** (Anzahlungs- & Schlussrechnung) from accepted offers.
5. **Comfort:** dark mode. (Global search and keyboard shortcuts are done.)
6. **Ops:** run as a background service on login (launchd, `bun start`), offsite copy of backups.
7. **Assistant follow-ups:** pre-warm the model when the chat panel opens (the first prompt of a fresh server costs ~9 s with 4B); consider a smaller tool set for the 4B if accuracy matters more than cache hits.
8. **MCP follow-ups (if needed):** recurring invoices and Fixkosten write tools, applying receipt-analysis suggestions to an expense, email once SMTP exists.

Ideas parked: e-invoice output (ZUGFeRD/XRechnung), multi-currency, time tracking, live bank balance from the last import as the forecast start.
