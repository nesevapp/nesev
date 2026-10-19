# How nesev works

This is the contributor reference for what each part of nesev does and why. It complements
[CONVENTIONS.md](../CONVENTIONS.md) (how the code is organized) and [CLAUDE.md](../CLAUDE.md) (invariants and
gotchas). The in-app assistant and the MCP server have their own page: [assistant.md](assistant.md). Open tax
questions are collected in [tax-notes.md](tax-notes.md).

nesev is a local, single-user invoicing and bookkeeping app for Austrian sole traders: offers, invoices, credit notes,
clients, a PDF designer, expenses, bank import and tax helpers. EUR only, clients in AT, the EU and third countries
(e.g. CH). No auth; it runs on localhost. The UI is German.

Contents: [Server, data dir and first start](#server-data-dir-and-first-start) ·
[Core rules](#core-rules) · [Clients & articles](#clients--articles) · [PDFs & designer](#pdfs--designer) ·
[E-invoices](#e-invoices) · [Dashboard](#dashboard) · [Reminders](#reminders-mahnwesen) ·
[Recurring invoices, Fixkosten & forecast](#recurring-invoices-fixkosten--forecast) · [Expenses](#expenses-ausgaben) ·
[Receipt OCR](#receipt-ocr) · [Taxes](#taxes) · [Fixed assets / AfA](#fixed-assets--afa) · [Bank](#bank) ·
[Frontend SDK](#frontend-sdk) · [Search & shortcuts](#search--shortcuts) · [Guided tour](#guided-tour) ·
[Data, export & backups](#data-export--backups) · [Security](#security) · [Background service](#background-service-macos)

---

## Server, data dir and first start

- **One port.** `PORT` (default **3998**, `DEFAULT_PORT` in `src/server/lib/app-files.ts`) is used everywhere: the
  production server serves the API and the built SPA on it, the Vite dev server (5173 or the next free port) proxies
  `/api` to it, the service installer and the MCP server's `NESEV_API_URL` / `NESEV_WEB_URL` defaults follow it.
  The server listens on `127.0.0.1` unless `NESEV_HOST` says otherwise.
- **Entry split.** `src/server/index.ts` only resolves the data dir and starts listening. With a data dir it
  dynamically imports `src/server/main.ts`, which opens the DB (migrations run here), adds the SPA fallback in
  production and starts the background work: daily backups, the recurring-invoice scheduler, PDF re-freeze, the
  Belege-Eingang scanner, receipt-queue recovery and llama-server orphan reaping. `src/server/app.ts` (the Hono app,
  `AppType`) stays side-effect free because the MCP server imports it in a second process.
- **Data dir resolution** (`lib/data-location.ts`, resolved once per process):
  1. `NESEV_DATA_DIR` (demo, tests, eval, experiments, power users);
  2. `dataDir` in the per-user config file: macOS `~/Library/Application Support/nesev/config.json`, Linux
     `$XDG_CONFIG_HOME/nesev/config.json` (default `~/.config`), Windows `%APPDATA%\nesev\config.json`.
     `NESEV_CONFIG_DIR` overrides the folder;
  3. `<checkout>/data` if it already holds `nesev.db` (installs from before the setup existed). Skipped when
     `NESEV_CONFIG_DIR` is set, so experiments with their own config dir never pick up real data.
- **Setup mode.** With none of these, the server serves the SPA plus `/api/setup` (status, folder check, native
  folder dialog, complete); every other API call answers 503 `setupRequired`. The web app asks for a folder and
  suggests the OS app-data dir (recommended, not cloud-synced: macOS `~/Library/Application Support/nesev/Daten`,
  Linux `$XDG_DATA_HOME/nesev`, Windows `%LOCALAPPDATA%\nesev\Daten`), `~/Documents/nesev`, or a custom path with a
  native folder picker. The check (`inspectDataDir`) refuses relative paths, files and unwritable folders, warns
  about non-empty folders and about cloud-synced locations (iCloud Drive, `~/Library/CloudStorage`, Dropbox,
  OneDrive, Google Drive, Nextcloud, and `~/Documents`/`~/Desktop` when iCloud "Desktop & Documents" is on): syncing a
  live SQLite database with its `-wal`/`-shm` files can corrupt it. Picking a folder that already holds `nesev.db`
  continues with that data. Completing writes the config file and loads `main.ts` in-process, no restart.
- **Shipped files vs. data.** `lib/app-files.ts` locates what ships with nesev (migrations, fonts, `dist/web`);
  `lib/paths.ts` the user's data (`DATA_DIR`, `ASSETS_DIR`, `PDFS_DIR`, `RECEIPTS_DIR`, `DB_PATH`; `NESEV_DB`
  overrides the database file). Other entry points without a configured dir (MCP, scripts) fall back to the app-data
  dir; the MCP server refuses to start before the setup.

## Core rules
- **Units:** money in integer cents, quantity in milli-units (1000 = 1), rates in basis points (2000 = 20 %). Dates
  are `YYYY-MM-DD` strings.
- **Totals:** `calcTotals(items, taxMode)` is the only totals function (UI, API, PDF). Line net is rounded per line
  and tax is computed per rate. Documents cache net/tax/gross whenever items change.
- **Tax modes** (per document, defaulted from the client's country and UID, can be overridden):

| Mode | When | Effect |
|---|---|---|
| `AT_DOMESTIC` | AT clients | 20 / 13 / 10 / 0 % per line |
| `EU_REVERSE_CHARGE` | EU B2B with UID | 0 %, reverse-charge note; client UID required |
| `THIRD_COUNTRY` | e.g. CH | 0 %, "nicht im Inland steuerbar" note |
| `SMALL_BUSINESS` | Kleinunternehmer (Steuerstatus at the document date) | 0 %, §6 Abs 1 Z 27 note |

  As Kleinunternehmer, `defaultTaxMode` still gives EU business clients `EU_REVERSE_CHARGE` (only if the own UID is
  set) and non-EU companies `THIRD_COUNTRY`: the place of supply of B2B services is abroad (§3a Abs 6), so the
  exemption doesn't apply. Only domestic (AT-taxable) revenue counts towards the Kleinunternehmer limit.
- **Finalize warnings** (`finalizeWarnings`, `GET /api/documents/:id/finalize-warnings`, shown in the finalize
  dialog): reverse charge without own UID, Kleinunternehmer mode for a foreign business, AT invoices > 10.000 € to a
  company without UID, Kleinunternehmer mode without that status at the issue date (e.g. recurring invoices after a
  change), VAT charged while Kleinunternehmer (§ 11 Abs. 12). Credit notes must use their invoice's tax mode and may
  not exceed its gross in total.
- **Lifecycle:**
  - Offer: draft → final → sent → accepted / declined.
  - Invoice: draft → final → sent → paid. Overdue is derived from the due date.
  - Credit note: draft → final.
- **Finalize** = one transaction that assigns a gapless number (`AN-`, `RE-`, `GS-`, `MA-`, `ER-YYYY-NNNN` via
  `nextNumber()`), freezes client and seller snapshots and locks the document. Afterwards the PDF is frozen to
  `<data dir>/pdfs`. Corrections only via credit notes, which store positive amounts.
- **Conversions:** offer → invoice (any status; marks the offer accepted), invoice → credit note, duplicate.

## Clients & articles
- Clients are numbered `K-0001` and can be archived. Delete is blocked while documents reference the client.
- Articles are numbered `A-0001`. Typing a line title in any line-item editor suggests articles, most used first,
  and their values are copied onto the line. "Als Artikel speichern" turns a line into an article. Usage counts up
  when a document is finalized.
- Units come from the configurable list in Einstellungen (default: Std., Stk., Tag, Woche, Monat, Jahr, Pauschal, km).

## PDFs & designer
- pdfme templates per type (offer, invoice, credit note, reminder). A default is seeded and each document can pick a
  template.
- Anything inside the top 30 mm or the bottom ~28 mm repeats on every page (header/footer). The body flows, and the
  items table breaks across pages.
- A letterhead PDF is drawn under the pages: its page 1 under the first page, its page 2 under all following pages.
- Designer: canvas plus one panel ("Aufbau" with ↑/↓ section reordering that really moves content, "Variablen",
  "Eigenschaften"). Text elements support `{placeholders}`.
- **Zahlen mit Code:** invoices and reminders get an EPC QR code (GiroCode, EPC069-12 v002, UTF-8;
  `lib/pdf/epc-qr.ts`):
  - payee = company name (else owner) + IBAN (+ BIC if valid), amount = gross at finalize (reminders: open amount +
    fees + interest), remittance text = invoice number;
  - name/text are cleaned of line breaks, cut to 70/140 characters and, if umlauts etc. push the payload over 331
    bytes, shortened further (text first);
  - no code without a valid IBAN, a name or an amount > 0, nor when Einstellungen → Unternehmen → Bankverbindung →
    „Zahlen mit Code“ (`settings.paymentQr`) is off; designer previews always show it. Caption „Zahlen mit Code“
    under the code; `epcQr` / `epcQrLabel` are placeable designer variables (group Zahlung).
- Frozen PDFs are never re-rendered. Documents have no currency field: everything is EUR.

## E-invoices
`lib/einvoice/`, `services/einvoice.ts`, `/api/einvoice`.

- Finalized invoices and credit notes only, generated on demand from the frozen document (snapshots, items, cached
  totals checked against `calcTotals`). Pure generators:
  - `buildEbInterface`: ebInterface 6.1 (`http://www.ebinterface.at/schema/6p1/`);
  - `buildXRechnung`: UBL 2.1 Invoice/CreditNote, CustomizationID `…xrechnung_3.0`;
  - `buildFacturX`: CII D16B, guideline `urn:cen.eu:en16931:2017` (profile EN 16931).
  - Credit notes: ebInterface `CreditMemo` + RelatedDocument, UBL `CreditNote` 381 + BillingReference, CII 381 +
    InvoiceReferencedDocument; amounts stay positive.
- Routing fields: the client has `eInvoiceFormat` (preselected), `eInvoiceBuyerReference` (Leitweg-ID /
  Auftragsreferenz default) and `eInvoiceSupplierId` (Lieferantennummer → ebInterface
  `Biller/InvoiceRecipientsBillerID`). A document's `buyerReference` overrides the client default (editor field
  „Leitweg-ID“/„Auftragsreferenz“ when the client has a format) and is copied on convert, credit note and duplicate.
  Routing fields are read live; the addresses come from the snapshots.
- VAT categories: AT_DOMESTIC → S (0 % lines Z), reverse charge → AE (VATEX-EU-AE), small business → E, third
  country → G (VATEX-EU-G; O is not allowed with a seller VAT ID, BR-O-02). Exemption reason = the tax note from the
  settings. Units map to UN/ECE Rec 20 (`units.ts`, unknown → C62). Line discounts become line allowances /
  ReductionListLineItem.
- Checks before download (`eInvoiceProblems`, German, 422 on download, listed in the dialog): seller
  name/address/UID or Steuernummer/IBAN, client PLZ/Ort, client UID for reverse charge; ebInterface: Auftragsreferenz
  + Lieferantennummer (Bund); XRechnung: Leitweg-ID, seller e-mail + phone (BR-DE-5..7), buyer e-mail when the
  reference isn't a Leitweg-ID (a Leitweg-ID goes in as EndpointID scheme 0204). Seller data is frozen at finalize,
  so fixing the settings only helps new documents.
- ZUGFeRD: `embedFacturX` attaches `factur-x.xml` (AFRelationship Alternative, catalog /AF) to a copy of the frozen
  PDF plus XMP (PDF/A-3b id + Factur-X extension schema), an sRGB output intent (CC0 micro profile) and a document
  ID; the frozen PDF stays untouched. Verified with veraPDF 1.30 (PDF/A-3b pass) and Mustang 2.26 (PDF/A + Factur-X
  EN 16931 schematron), also with a transparent PNG logo; custom letterhead PDFs are not checked.
- Validation: golden files and round trips through the receipt parser (`lib/einvoice/einvoice.test.ts`). All samples
  validate against the official ebInterface 6.1, UBL 2.1 and CII D16B XSDs
  (`NESEV_EINVOICE_XSD_DIR=… bun test src/server/lib/einvoice`) and the KoSIT validator 1.6.3 with the XRechnung
  3.0.2 configuration (XRechnung UBL invoice/credit note and EN 16931 CII all ACCEPTABLE).
- Download names: `RE-2026-0001_ebinterface.xml`, `…_xrechnung.xml`, `…_zugferd.pdf`.
- Not supported: sending via USP/Peppol, ebInterface for B2B without Auftragsreferenz (currently required).

## Dashboard
- Tiles for the selected year: Umsatz (net, vs. the same months of the previous year), Ausgaben (net, by document
  date), Ergebnis (Umsatz − Ausgaben, with margin), Bezahlt; second row: open invoices, overdue, open offers.
- Monthly chart: revenue and expenses as columns, result as a line; switches for "Ausgaben" (on by default) and
  "Vorjahr"; a table view with the same columns. Expenses count by document date like revenue (the EAR counts by
  payment date); incomplete drafts have no lines and add nothing.
- `anlagen` lines are replaced by the AfA: each half-year's AfA is spread over its six months (an asset put into
  service in H2 of its first year starts in July; the current year only up to the current month), a disposal
  write-off counts in its month. The current year's expense column is stacked (receipts + AfA in its own shade
  `--chart-afa`, legend „davon AfA“); the API returns `monthly[].afaCents` / `previousAfaCents`.
- **Kleinunternehmergrenze** (shown only when the Steuerstatus is Kleinunternehmer on some day of the selected year;
  `shared/small-business.ts`, `services/small-business.ts`): a card with the gross turnover of the year (non-draft
  invoices − credit notes) against € 55.000, markers at € 55.000 and € 60.500.
  - Rules since 2025 (§ 6 Abs. 1 Z 27 UStG, usp.gv.at): limit € 55.000 gross in the previous and the current year; up
    to 10 % over (≤ € 60.500) the current year stays exempt but the next one isn't; above € 60.500 the exemption ends
    with the invoice that crosses it (the card names its service date).
  - Colours: amber from 80 %, orange in the tolerance band, red when exceeded or when the previous year was over
    € 55.000. The current year shows a projection with draft invoices and the remaining runs of active recurring
    invoices until 31.12.
  - **Counted by the time of supply (Leistungszeitpunkt):** end of the service period → its start → invoice date, for
    every Kleinunternehmer regardless of Soll/Ist; even with Istbesteuerung the payment date doesn't matter for the
    limit (Forvis Mazars newsletter 09/2025 citing the VwGH; BFG RV/5100868/2012; kapas.at and prh-stb.at articles
    on the Umsatzgrenze). Credit notes subtract by their own issue date. Recurring runs in the projection count by
    the end of the period they cover.
  - A line „davon bereits eingegangen“ shows the paid part (invoices marked paid: gross − credit notes; otherwise bank
    allocations via `invoicePaymentStates`, capped at what is due). The hint text says that not every turnover
    counts (Hilfsgeschäfte …) and that this is a planning aid, not tax advice.

## Reminders (Mahnwesen)
- Levels are configurable (default: Zahlungserinnerung €0, 1. Mahnung €10, 2./letzte Mahnung €20, each +7 days). The
  last level can repeat. Optional default interest (simple, actual days / 365).
- Only overdue, finalized, unpaid invoices can get a reminder. Open amount = gross − credit notes − bank payments.
  Fees and interest are not taxable.
- Reminder PDF with GiroCode for the total including fees. Bulk creation from "Fällig zum Mahnen", plus actions on
  the invoice view and the dashboard.

## Recurring invoices, Fixkosten & forecast
**Recurring invoices**
- Intervals: monthly, every N months or yearly. The day of month anchors to the start date (31 Jan → 28/29 Feb → 31
  Mar). Missed periods are caught up with one invoice each, and the end date is respected.
- Generated invoices are either drafts or auto-finalized; a failed finalize leaves a draft.
- A scheduler runs on server start and then hourly. "Jetzt ausführen" and "Rechnung jetzt erstellen" trigger it by
  hand.

**Fixkosten** (`/fixed-costs`, `/api/recurring-expenses`): recurring outgoing payments (name, recipient, expense
category, gross, contained deductible VAT with a 20/13/10/0 % helper, interval anchored like recurring invoices,
start, optional end, active, notes). They only feed the forecast; nothing is booked automatically.
- **Payments ↔ expenses** (`recurring_expense_payments`): an expense can be linked to one scheduled payment („Miete ·
  Nov 2026“). The forecast then skips that slot and counts the expense instead (unpaid → „Offene Ausgabe“, paid →
  nothing); being a real expense it is also in the UVA. Unlinked expenses for Fixkosten are counted twice.
- „Zahlungen & Belege“ per entry: last 12 + next 6 slots with status (verknüpft/bezahlt, geplant, „überfällig – ohne
  Beleg“) and the actions „Ausgabe erfassen“ (`/expenses/new?fixedCost=<id>&slot=<date>`, prefilled and linked on
  save), „Verknüpfen“ (unlinked expenses ± 60 days, matching first), „Verknüpfung lösen“. The list shows slots of the
  last 90 days without a receipt.
- Link suggestions: active entry, free slot, supplier (normalized) or category match, amount ± 5 %, issue/due/paid
  date ± 10 days of the slot; supplier matches rank first. The expense editor shows the link or the best suggestion
  as a one-click „verknüpfen“. Links cascade when the expense or the Fixkosten entry is deleted.

**Forecast** of incoming and outgoing money (gross) over 3, 6 or 12 months, plus the projected account balance
(`services/forecast.ts`):
- Inflows: open invoices on their due date plus that client's average payment delay (overdue = "now"), every planned
  recurring run, optionally drafts and open offers at a set probability. The VAT share is shown separately.
- Outflows (toggle „Ausgänge“): every Fixkosten payment; unpaid expenses (with lines; open = gross − bank
  allocations) on their due date, without one at issue date + 14 days, overdue = "now"; ESt-Vorauszahlung (setting,
  per quarter) on 15.2./15.5./15.8./15.11.
- USt-Zahllast (not for Kleinunternehmer): each UVA period due inside the horizon (15th of the 2nd month after it,
  next working day). Amount = `computeUva()` of what is already recorded + an estimate for what the forecast still
  expects in the period (output VAT of inflows − deductible VAT of Fixkosten/unpaid expenses; dated by basis: Ist =
  payment date, Soll = invoice date, offers = today). Periods not yet over are marked „geschätzt“. Negative = refund.
  Assumes nothing was paid before the due date.
- Balance: „Kontostand am <Datum>“ (setting) + all entries expected on/after that date. Per bucket: balance at the
  end and lowest day-end balance; a KPI and a red banner if the lowest point goes below 0.
- Settings via the page's „Kontostand & Steuern“ popover or Einstellungen → Zahlungsprognose
  (`GET/PUT /api/forecast/settings`).
- Paid via credit note ≠ cash received: the payment-delay history skips such invoices.

## Expenses (Ausgaben)
- Fields: supplier, UID, country, supplier invoice number, dates, VAT treatment (`domestic`, `reverse_charge`,
  `ig_acquisition`, `import`, `none`). Lines carry an EAR category, rate, stored tax (can be overridden to match the
  receipt) and deductible share.
- `grossCents` = amount payable to the supplier. For reverse charge / ig. Erwerb that equals net, and the
  self-assessed tax is owed and deductible (see the header of `src/shared/expenses.ts`).
- Receipts (PDF/JPG/PNG/WebP, ≤ 20 MB) go to `<data dir>/receipts/<year>/`. Dropping several files creates
  incomplete drafts (no lines), which reports exclude with a warning.
- The list page has a small column chart (gross per month by Belegdatum, computed client-side from the filtered rows;
  matches „Summe brutto“). Shared component `components/charts/column-chart.tsx`.

**Crop/straighten photo receipts** (receipt pane → crop icon; JPG/PNG/WebP only, on explicit action, never on upload):
- The dialog shows the original photo with the outline suggested by the Swift helper (`nesev-ocr detect-document`:
  Vision document segmentation, ignored below confidence 0.3 or 3 % of the image, then `VNDetectRectanglesRequest`
  tuned for long receipts; nothing found → whole image) and four draggable corners (pointer, arrow keys ± 0.4 %,
  Shift ± 2 %; crossed or too small quads can't be saved). Buttons: „Automatisch erkennen“, „Ganzes Bild“, optional
  „Schwarz-Weiß, mehr Kontrast“, „Zuschneiden speichern“.
- `nesev-ocr crop` cuts the quad out with `CIPerspectiveCorrection` (EXIF orientation applied first; quads are
  normalized on the image as displayed), max. 3000 px long side, JPEG q 0.9 (PNG stays PNG). Core Image's output
  aspect was within ~4 % of the real sheet on rendered test photos; a Zhang–He focal-length estimate was tried and
  dropped (no better, worse on small or off-center shots).
- Files: the crop is written next to the original (`<original stem>-crop-<ts>.jpg`), `attachmentPath` → crop,
  `attachmentOriginalPath` → original. Re-cropping always starts from the original and deletes the previous crop;
  „Original wiederherstellen“ deletes the crop and clears `attachmentOriginalPath`. Replacing/removing the receipt or
  deleting the expense removes both files.
- API: `GET /api/expenses/:id/receipt/detect`, `POST …/receipt/crop {quad, enhance}`, `POST …/receipt/restore` (422
  for PDFs or without the helper).
- Analysis reads `attachmentPath` (the crop); earlier analyses become stale („Beleg wurde ersetzt oder zugeschnitten –
  neu analysieren“). On tilted test photos, OCR of the uncropped photo mixed up columns; after cropping the results
  were correct.

**Belege-Eingang** (receipt inbox; `/expenses/inbox`, `services/receipt-inbox.ts`, `/api/receipt-inbox`):
- Folder set in Einstellungen → Belegerkennung (`settings.receiptInboxPath`, saved only via
  `PUT /api/receipt-inbox/folder`: absolute, `~` expanded, must exist, be readable and lie outside the data dir).
- Scanner (started in `main.ts`, one per process on `globalThis`): scans on start, every 45 s and 1.5 s after an
  `fs.watch` event (a hint only; iCloud folders don't report reliably). Top-level files only; hidden files and iCloud
  placeholders (`.x.pdf.icloud`) are ignored. A file is taken when size + mtime are unchanged across two scans.
  PDF/JPG/PNG/WebP/HEIC ≤ 20 MB; HEIC/HEIF is converted to JPEG with `sips` (macOS). A missing or unreadable folder
  gives a German status (`GET /status`), no crash.
- Import: copy to `<data dir>/receipts/inbox/<sha12>-<name>`, a row in `receipt_inbox_items`, the source moved to
  `<folder>/Importiert/` (name collisions → „x (2).pdf“; nothing is deleted). Dedupe by sha256 against open items and
  existing expense receipts (still moved). A dismissed file dropped again comes back. If the move fails, the file is
  remembered by path/size/mtime so it isn't re-read.
- Page: list with preview and multi-select; „Als Ausgabe anlegen“ (one draft per item), „Anlegen + analysieren“ (then
  the web calls `POST /api/receipts/analyze` – explicit), „Verwerfen“, drop zone / „Dateien hinzufügen“, „Jetzt
  prüfen“. A badge on „Ausgaben“ in the sidebar.

## Receipt OCR
- Upload never analyses anything. The user queues an analysis per receipt or in bulk, and a background worker
  processes the queue one receipt at a time. Suggestions only fill empty fields in the editor and are saved only when
  the user saves; „Alle übernehmen“ skips low-confidence (red) suggestions and names them in the toast.
- Pipeline: embedded ZUGFeRD/XRechnung XML (no model) → PDF text layer → Apple Vision OCR (Tesseract fallback) →
  rule-based extractor + local model (llama.cpp, temperature 0, thinking off, JSON-schema `response_format`).
- Model access: only llama.cpp. `services/receipt-llm.ts` holds the prompt, the schema, the answer mapping and the
  HTTP client for llama-server (`POST /v1/chat/completions` with a strict `json_schema`). llama-server enforces the
  schema as a grammar, so there is no prompt-only fallback. (Ollama and OpenAI-compatible providers were removed;
  settings stored with their old keys still load because the schema drops unknown keys.)
- **llama-server lifecycle** (`lib/llama/{paths,server}.ts`, `services/receipt-llama.ts`): nesev spawns
  `llama-server` itself on the first model run of a batch (127.0.0.1, free port, random key via `LLAMA_API_KEY`,
  `--offline --jinja --reasoning off -np 1 --no-webui`, `--mmproj` only in vision mode), waits for `/health` (120 s
  timeout) and reuses it for the batch. It is stopped after the batch (setting "nach der Analyse beenden") or after
  5 min idle, when a settings change affects an idle server, and on nesev exit (SIGINT/SIGTERM/SIGHUP/exit
  handlers). Handles live on `globalThis` (`bun --hot` safe). `<data dir>/llama-server.pid` lets the next start reap
  an orphaned child, but only if that PID still runs llama-server on the recorded port. The assistant shares the same
  server through a lease, see [assistant.md](assistant.md#sharing-llama-server-with-receipt-ocr).
  - Binary: configured path, else `~/.unsloth/llama.cpp/build/bin/llama-server`, `PATH`, `/opt/homebrew/bin`.
  - Models: GGUFs found in the Hugging Face cache (`HF_HUB_CACHE` / `HF_HOME`), `~/.cache/llama.cpp`
    (`LLAMA_CACHE`), `~/Library/Caches/llama.cpp`, `~/.unsloth`, `~/.lmstudio/models` (no mmproj, ≥ 50 MB, split
    models once) or a free path. An empty model path means automatic: a `Qwen3.5-4B` GGUF (one with mmproj first),
    else the first one found.
  - mmproj: configured, else the `mmproj*.gguf` next to the model (F16 > BF16 > F32 > by name).
  - No automatic download. Without any GGUF the status suggests `llama-server -hf unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL`.
  - Errors (binary/model missing, load failure from the log tail, timeout) degrade to rules-only. "Testen" starts a
    separate server, reads a sample receipt and stops it.
- Measured on an M4 with Qwen3.5-4B UD-Q4_K_XL (warm page cache, generated PNG receipt): text mode server start
  0.76 s, model 5.1–6.3 s per receipt; vision mode (mmproj-F16) server 1.0 s, model 5.4–7.7 s. All main fields were
  correct.
- Settings (Einstellungen → Belegerkennung): OCR engine; LLM on/off; mode text/vision; model (automatic, a
  discovered GGUF or a path), llama-server path, mmproj, context size; stop after the batch. The status shows the
  Vision helper, Tesseract and llama.cpp (binary, model, vision, server).
- **Checks and post-processing:**
  - Amounts must add up, UID and IBAN must be valid, known suppliers are recognised.
  - Descriptions are cut to a short form (≤ 6 words / 60 chars; `shortDescription` in `src/shared/receipts.ts`).
  - Category keywords in two tiers: unambiguous trades/suppliers (Elektriker, Installateur, Reparatur, Wartung →
    Instandhaltung; Werkstätte/Tankstelle → KFZ; Steuerberater → Beratung; SVS) at 0.7, which overrides the model
    unless it reports ≥ 0.9; generic keywords stay a 0.45 hint.
  - Identifiers: a model UID/IBAN that is the user's own, or (text mode) not in the receipt text, is dropped
    (`groundIdentifiers`); small models tend to copy a UID from the prompt.
  - Gross or net entry per receipt (`amountBasis`, `detectAmountBasis` in `receipt-heuristics.ts`, rules only): the
    item lines above the first total/tax line add up to the net total → net (invoices) or the gross total → gross
    (till receipts); otherwise wording („zzgl.“ / „inkl.“, cash-register terms). E-invoices are always net; no basis
    for reverse charge / ig. Erwerb / no VAT. The editor's „Brutto-Eingabe“ switch follows it until the user flips it.
  - Repair on gross receipts (`repairGrossTaxLines`): when the tax lines don't add up (columns mixed up, garbled
    OCR), it looks for exactly one gross amount per rate that together make the total and recomputes net/tax. Unique
    combinations only; the result is capped at medium confidence with a warning.
  - The status at the expense date (Kleinunternehmer) decides whether the GWG/Anlage limit is gross or net.

## Taxes
`/tax` – a helper, not tax advice. See [tax-notes.md](tax-notes.md) for the open questions.

- **UVA:** month or quarter per settings; Ist- or Sollbesteuerung per the dated Steuerstatus (below). Mapped to the
  U30 Kennzahlen (000, 022/029/006/037, 016, 057/066, 070/072/065, 060, 061, 090 → 095). Each KZ opens the documents
  behind it and has a copy button. The due date is shown.
- **ZM:** per EU client UID, the sum of reverse-charge services.
- **EAR:** by payment date. Expenses grouped by category with an E1a suggestion, a warning for Bewirtung. Expense
  lines with category `anlagen` are capitalized; instead the AfA of the year and the remaining book value of assets
  disposed in the year come from the asset register under KZ 9130 (group "Anlagen", expandable; also in the CSV). A
  warning when an expense of the year has `anlagen` lines but no linked asset. Input VAT on assets stays deductible
  at once in the UVA.
- CSV export for each report.

**Steuerstatus with valid-from dates** (`tax_status_periods`; `shared/tax-status.ts`, `services/tax-status.ts`,
`/api/tax-status`, Einstellungen → Belege → Umsatzsteuer → „Steuerstatus“):
- Kleinunternehmer yes/no and Soll/Ist, one row per change („ab 01.01.2026: Regelbesteuert, Soll“), each valid until
  the next one. The first row is „von Beginn an“ (`0001-01-01`); it can be edited but not deleted. One table instead
  of two histories: a row is the complete status, a lookup needs one search, and the list stays readable.
- Rules: unique dates; Soll/Ist may only change on the first day of a UVA period (else 422); Kleinunternehmer may
  change on any day (mid-year loss of the exemption).
- Reports load the history once (`loadTaxStatus` → `TaxStatusTimeline`) and ask it per date:
  - Revenue: by the invoice's issue date; a credit note follows its invoice. After Ist → Soll a December Ist invoice
    paid in January counts in January (at its payment), new invoices at their issue date; after Soll → Ist nothing is
    counted twice (§ 17 Abs. 4 UStG). The UVA's „Besteuerung“ line = status at the period's first day;
    `UvaReport.smallBusiness` = Kleinunternehmer on every day of the period (then the „keine UVA nötig“ box).
  - Expenses by their Belegdatum: no Vorsteuer in the UVA while Kleinunternehmer, gross cost in the
    EAR/dashboard/BMD export, gross asset cost in the asset prefill. EAR: `gross` = Kleinunternehmer all year,
    `mixed` = part of the year; income counts gross when the invoice was issued as Kleinunternehmer.
  - Forecast: USt-Zahllast per UVA period unless Kleinunternehmer for the whole period, basis at the period start.
    Dashboard: the limit card for years with Kleinunternehmer days; `statusEndsOn` warns when the limit ends the
    exemption but the history still says Kleinunternehmer.
  - New documents (`documentDefaults`) use the status at the document date; the editor re-derives the tax mode when a
    changed date no longer fits it (toast).
- Today's status: `GET /api/settings` returns `smallBusiness`/`vatBasis` as the status valid today (derived).
  `PUT /api/settings` accepts them only unchanged; a change → 422 pointing to the Steuerstatus list. UI hints read
  today's status from there; reports (and the MCP/assistant tools built on them) never do.

**FinanzOnline upload files** (`services/tax-xml.ts`, `GET /api/tax/{uva,zm}.xml`, pre-check
`GET /api/tax/{uva,zm}/finanzonline`): XML for „Eingaben → Übermittlungen → Datei-Upload“ per the BMF XML
documentation for software vendors.
- U30 schema 07/2026 (the output never uses the 4,9 % KZ 124/125, so it also validates against the 01/2022 schema)
  and the ZM schema from 6.3.2025 (DREIECK/SOLEI = „J“, SUM_BGL in whole euros, may be negative).
- The BMF XSDs are not in the repo: bmf.gv.at content may be reprinted only non-commercially with attribution, which
  doesn't fit AGPL redistribution. `tax-xml.test.ts` downloads them on first run into
  `node_modules/.cache/nesev/finanzonline/` (or reads `NESEV_FINANZONLINE_XSD_DIR`) and validates with `xmllint`;
  offline or without xmllint the schema checks are skipped with a warning.
- FASTNR = 9 digits (FA-Nr + StNr) parsed from the Steuernummer („12 345/6789“, check digit not verified). Zero KZ
  are omitted (except KZ 000), only 063/067/090 may be negative; 095 and the tax columns are computed by FinanzOnline.
- Blocking checks (German, shown in the popover): missing/invalid Steuernummer, own UID for the ZM, unfinished
  period, > 5 years back, negative KZ, BMF plausibility sums (022+029+006+037 = 000−021−steuerfrei, 070/071/072…,
  066 ≤ 057), ZM without lines, missing/AT/invalid client UIDs.
- The user uploads the file and checks the values; nesev transmits nothing.

## Fixed assets / AfA
`/assets` – a helper, not tax advice.

- `fixed_assets`, numbered `AV-0001`. Math in `src/shared/assets.ts` (pure, cents), shared by the server and the
  form's live preview.
- Straight-line AfA: annual = cost / useful life (rounded). Halbjahresregel: in service ≤ 30.6. → full AfA in the
  first year, otherwise half plus one extra year with the rest. The last year takes the remainder, so the AfA sums
  to the cost exactly. Cost = net + non-deductible VAT (Kleinunternehmer: gross).
- Disposal (sold / scrapped): regular AfA in the disposal year (full-year rule, kept simple) plus the remaining book
  value written off in that year; proceeds are only shown ("als Einnahme erfassen"), not booked.
- Useful-life suggestions (Computer 3, Smartphone 3, Software 4, Büromöbel 10, Maschinen 8, PKW 8 = § 8 Abs 6
  minimum); free input 1–50.
- Register per year (book value 1.1., AfA, write-off, book value 31.12., totals, CSV), detail with schedule and link
  to the source expense; edit / Ausscheiden / delete. A chart shows additions (by Inbetriebnahme) and AfA per
  half-year (`halfYearAfa`: regular AfA split evenly, except a first year in service in H2, which goes all into H2;
  a write-off in the half of the disposal date).
- Expense editor: a line with category `anlagen` shows "Im Anlagenverzeichnis anlegen" (prefilled from the expense's
  `anlagen` lines, minus assets already linked) or links to the linked assets.

## Bank
- **Import:** camt.053/052/054 and CSV.
  - Tested against fixtures: camt, N26, Revolut, Wise.
  - Presets for George, ELBA, BAWAG and Revolut Business exist but are not yet verified against real exports.
  - Everything else goes through a generic column mapper, remembered per account.
  - Duplicates are skipped via a hash, there's a preview before committing, and an import can be undone.
  - Parser fixtures (`src/server/lib/bank-parsers/fixtures/**`) are byte-exact (CRLF, Windows-1252) via
    `.gitattributes`.
- **Matching:** the invoice number in the payment text (in any spelling), exact amount, IBAN learned per client or
  supplier, name similarity.
  - Auto-apply per account: off, safe (default) or aggressive, and only when exactly one candidate qualifies.
    Everything else is a one-click suggestion.
  - Split and partial payments are supported. A covered invoice becomes paid with the booking date; unmatching
    reverts that.
- **Payment status of invoices** (`settleInvoice` in `services/documents.ts`):
  - An invoice is paid once finalized credit notes plus bank allocations cover its gross. Finalizing a credit note
    checks this too: paidAt = the later of its issue date and the last payment. A payment marked by hand is never
    moved or reverted automatically.
  - "Zahlung zurücksetzen" on an invoice with bank allocations returns 409 unless `removeAllocations: true` is sent;
    the UI asks "Zuordnungen ebenfalls entfernen?" and the transactions become open again.
  - Lists show "teilbezahlt" and the open amount. An invoice with nothing left to pay is never overdue or open
    (dashboard, reminders, forecast).
  - Paid via credit note ≠ cash received: Istbesteuerung/EAR count no payment for it, and the dashboard's "Bezahlt"
    uses gross − credit notes.

## Frontend SDK
- `src/web/sdk/`: one typed `hc` client per route module (typed only against that module, which keeps editor type
  checking light), `<resource>Api` functions, consistently named types (`Client`, `DocumentListItem`,
  `ExpenseInput`, …), query options + mutation hooks, a central query-key factory (`keys.ts`) and a cross-resource
  invalidation map (`invalidate.ts`). For example, a bank match refreshes bank, documents, expenses, dashboard,
  forecast, reminders and tax.
- Features call the API only through `@/sdk`; new endpoints get added there. Details in
  [CONVENTIONS.md](../CONVENTIONS.md#calling-the-api-web).

## Search & shortcuts
- **⌘K / Ctrl+K** (or `/`, or „Suchen …“ in the sidebar) opens the command palette (`features/search/`, cmdk with
  `shouldFilter={false}`). Empty query: recently opened entries (localStorage `nesev.search.recent`, max 8), create
  actions, pages. Typing filters pages/actions client-side and queries `GET /api/search?q=&limit=` (debounced 150 ms).
- **Server** (`services/search.ts`): grouped results (default 6 per group) for clients, invoices, offers, credit
  notes, reminders, recurring invoices, expenses, Fixkosten, assets and articles, each with `label`/`sublabel`/`meta`
  and the frontend `path`.
  - Text: escaped LIKE over a folded form (lower-case, umlauts/ß/some accents, plus an "ae/oe/ue" variant, so
    Müller = Mueller = muller). The fold is nested `replace()` calls; SQLite's parser overflows at ~28 levels, so keep
    the pair list short.
  - Numbers in any spelling: `RE-2026-0012`, `RE-2026-12`, `2026-0012`, `re12`, `12` (any year); a prefix
    (RE/AN/GS/MA/ER/K/A/AV) limits the number match to that type. Documents also match the live and the snapshot
    client name; reminders their invoice number.
  - Amounts (`1.234,56`, `1234.56`, `500 €`) match gross/net (documents, expenses), the payment (Fixkosten) or the
    cost (assets).
  - Ranking: exact number → number of any year → amount → text, then newest; groups with a number/amount hit first.
- **Shortcuts** (`use-global-shortcuts.ts`, ignored while typing, while a dialog/menu is open and when a page already
  handled the key): `?` overview, `/` search, `g` + letter go to a page, `n` + letter create. The map lives in
  `features/search/commands.ts` and the overview reads it.

## Guided tour
`features/tour/`: a first-run tour with a dimmed overlay and a spotlight on one part of the shell (elements with
`data-tour="…"`) and a card explaining what lives there. A step whose target isn't on screen is skipped; it opens
the sidebar group it points at and never navigates. Starts once per browser (localStorage `nesev.tour`, not on the
template designer); restart via the ? button next to „Einstellungen“, „Rundgang starten“ in the command palette or
the link on the empty dashboard.

## Data, export & backups
- The data dir (see [above](#server-data-dir-and-first-start)) holds `nesev.db` (SQLite, WAL), `pdfs/` (frozen PDFs),
  `receipts/` (by year, plus `inbox/`), `assets/` (logo, letterhead), `backups/` and `bin/` (helpers compiled on first
  use, e.g. the Apple Vision OCR helper).
- Every DB transaction is `BEGIN IMMEDIATE` (default in `db/client.ts`) with WAL + `busy_timeout`, so the MCP process
  can write concurrently. Migrations run when the server (or MCP server) opens the DB.
- Daily automatic DB snapshot to `backups/` (newest 14 kept, database only – the UI says so), plus a manual backup ZIP
  (DB snapshot + assets + PDFs + receipts), streamed with fflate.
- Missing frozen PDFs are re-frozen at startup (`services/pdf-refreeze.ts`).
- CSV exports (BOM, `;`, decimal comma) and a ZIP with all PDFs for a period.
- **Accountant export** (`services/export-accounting.ts`, `/api/export/accounting/{summary,bmd.csv,belege.csv}`,
  `/api/export/accounting.zip`, mapping `GET/PUT /api/export/accounting-settings` → `settings.accountingExport`,
  shape and EKR defaults in `src/shared/accounting-export.ts`). Best effort after public BMD interface descriptions
  (BMD 5.5 pr08 guide by simplesoft, dvo „BuErf-Import“ manual 2021); **not tested against BMD**:
  - BMD CSV (`satzart;konto;gkonto;belegnr;belegdatum;buchsymbol;buchcode;prozent;steuercode;betrag;steuer;text;extbelegnr;uidnr;gegenbuchkz;verbuchkz;dokument`):
    konto = Erlös/Aufwand/Anlage, gkonto = Debitor (Sammelkonto or base + client number) / Kreditor (Sammelkonto);
    betrag net, signed (revenue Haben −, credit notes and expenses Soll +), steuer separate with the same sign,
    self-assessed tax opposite. One line per document tax rate and per expense line; partly deductible Vorsteuer is
    split into a line with code 2 and a gross line without tax.
  - Steuercodes: 1 USt, 2 VSt, 77 EU-Leistung, 16 Kleinunternehmer, 79/78 RC EU, 19/18 RC Drittland, 9/8 ig. Erwerb,
    34 EUSt, 81 Drittland-Erlös (nicht steuerbar), empty = ohne USt.
  - belegnr = digits of the number (RE-2026-0042 → 20260042; credit notes use symbol GU by default, or a leading 9
    when they share the invoice symbol); the full number is `extbelegnr` (OP-Nummer) and names the file in
    `dokument`. Optional bank payments (BK, matched bank transactions). Windows-1252 (default) or UTF-8, CRLF,
    TT.MM.JJJJ, decimal comma; text sanitized (no `;`/quotes), ≤ 60 chars.
  - Generic CSV without accounts (RZL/Excel): a row per document rate / expense line / payment.
  - ZIP streamed one file at a time: LIESMICH.txt, both CSVs, `belege/<Belegnr>.<ext>` (frozen PDFs, missing ones
    rendered; expense receipts by attachment).
  - Expenses by Belegdatum; `anlagen` lines go to the asset account (AfA is the accountant's).

## Security
Details and the threat model are in [SECURITY.md](../SECURITY.md). In code:
- `lib/origin-guard.ts`: loopback `Host` only (against DNS rebinding), no foreign `Origin` / cross-site writes;
  `NESEV_ALLOWED_HOSTS` adds hostnames.
- `lib/security-headers.ts`: CSP for the SPA, nosniff, frame-ancestors. Files from the data dir are served with
  nosniff and SVG/XML/HTML sandboxed; logo type sniffed from content and SVGs with scripts/external references refused.
- CSV/BMD text cells neutralised against formula injection, body limits on uploads, capped inflate for embedded
  e-invoice files.

## Background service (macOS)
`bun run service:install [--port 3998] [--skip-build]` (`scripts/service.ts`) builds the SPA, writes
`~/Library/LaunchAgents/at.nesev.plist` (label `at.nesev`: `bun src/server/index.ts` with NODE_ENV=production, PORT,
PATH = bun dir + Homebrew + system, NESEV_DATA_DIR if set at install time; WorkingDirectory = the checkout; RunAtLoad,
KeepAlive) and loads it with `launchctl bootstrap`. Logs: `~/Library/Logs/nesev/nesev.log` / `nesev.err.log`.
`service:status` shows state/PID and pings the port, `service:uninstall` boots it out and removes the plist.
`--dry-run` writes the plist to a temp dir and runs `plutil -lint` only. Stop a dev server on the same port first;
after code updates rerun `service:install` (rebuilds and restarts).
