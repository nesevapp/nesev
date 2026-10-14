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

### Reminders (Mahnwesen)
- Levels are configurable (default: Zahlungserinnerung €0, 1. Mahnung €10, 2./letzte Mahnung €20, each +7 days). The last level can repeat. Optional default interest (simple, actual days / 365).
- Only overdue, finalized, unpaid invoices can get a reminder. Open amount = gross − credit notes − bank payments. Fees and interest are not taxable.
- Reminder PDF with GiroCode for the total including fees. Bulk creation from "Fällig zum Mahnen", plus actions on the invoice view and the dashboard.

### Recurring invoices & forecast
- Intervals: monthly, every N months or yearly. The day of month anchors to the start date (31 Jan → 28/29 Feb → 31 Mar).
- Missed periods are caught up with one invoice each, and the end date is respected.
- Generated invoices are either drafts or auto-finalized; a failed finalize leaves a draft.
- A scheduler runs on server start and then hourly. "Jetzt ausführen" and "Rechnung jetzt erstellen" trigger it by hand.
- **Forecast** of incoming money (gross) over 3, 6 or 12 months:
  - Open invoices are expected on their due date plus that client's average payment delay. Overdue invoices count as "now".
  - Every planned recurring run is included.
  - Optional: drafts, and open offers at a set probability.
  - The VAT share of the inflow is shown separately.

### Expenses (Ausgaben)
- Fields: supplier, UID, country, supplier invoice number, dates, VAT treatment (`domestic`, `reverse_charge`, `ig_acquisition`, `import`, `none`).
- Lines carry an EAR category, rate, stored tax (can be overridden to match the receipt) and deductible share.
- `grossCents` = amount payable to the supplier. For reverse charge / ig. Erwerb that equals net, and the self-assessed tax is owed and deductible.
- Receipts (PDF/JPG/PNG/WebP, ≤ 20 MB) go to `data/receipts/<year>/`. Dropping several files creates incomplete drafts (no lines), which reports exclude with a warning.

### Taxes (`/tax`) – a helper, not tax advice
- **UVA:**
  - Month or quarter, per settings. Ist- or Sollbesteuerung, per settings.
  - Mapped to the U30 Kennzahlen (000, 022/029/006/037, 016, 057/066, 070/072/065, 060, 061, 090 → 095).
  - Each KZ opens the documents behind it and has a copy button. The due date is shown.
- **ZM:** per EU client UID, the sum of reverse-charge services.
- **EAR:** by payment date. Expenses grouped by category with an E1a suggestion, with warnings for assets over 1,000 € and for Bewirtung.
- CSV export for each report.

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
5. **Optional DB constraint patch** for the two FK columns without `ON DELETE SET NULL` (handled in code today).

---

## 4. Roadmap (in order)
1. **Test receipt OCR with real receipts.** nesev starts llama.cpp itself; it needs a GGUF on disk (run `llama-server -hf unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL` once).
2. **Verify bank presets with real exports** from the user's bank (George / ELBA / …) and fix the presets.
3. **Email sending** (SMTP): PDF attachment, text templates per document type, auto-mark as sent, send log.
4. **Down payment / final invoice** (Anzahlungs- & Schlussrechnung) from accepted offers.
5. **Comfort:** dark mode, keyboard shortcuts overview, global search.
6. **Ops:** run as a background service on login (launchd, `bun start`), offsite copy of backups.

Ideas parked: e-invoice output (ZUGFeRD/XRechnung), multi-currency, time tracking.
