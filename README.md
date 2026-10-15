<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img src="docs/logo.svg" alt="nesev" width="240">
  </picture>
</p>

<p align="center">
  Local-first invoicing and bookkeeping for Austrian sole traders.
</p>

---

nesev is a lightweight, local alternative to hosted invoicing tools, built for a single Austrian sole trader
(Einzelunternehmer). You write offers, invoices and credit notes, record expenses, import bank statements and get UVA, ZM
and EAR figures. Everything runs on your own machine: no cloud, no account, no telemetry. All data stays in one folder
(`data/`), and the optional AI features (receipt recognition, assistant, voice input) use local models only.

The user interface is **German**. The code, comments and docs are in English.

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Dashboard with revenue, expenses and result per month" width="900">
</p>

## Features

**Belege: offers, invoices, credit notes, reminders**
- Gapless numbering (`RE-2026-0001`), finalized documents are immutable with frozen client and seller snapshots and a
  frozen PDF; corrections go through credit notes.
- Tax modes per document: domestic (20/13/10/0 %), EU reverse charge, third country, Kleinunternehmer.
- PDF template designer (pdfme) with letterhead support, article catalog, recurring invoices, dunning levels with fees
  and interest.
- **Zahlen mit Code**: EPC QR code (GiroCode) on invoices and reminders.
- **E-Rechnung**: ebInterface 6.1, XRechnung 3.0 (UBL) and ZUGFeRD / Factur-X (EN 16931, PDF/A-3b).

**Ausgaben & Belegerkennung**
- Expenses with receipts (PDF/JPG/PNG/WebP/HEIC), EAR categories, reverse charge / ig. Erwerb / import, partly
  deductible input VAT, fixed costs, fixed asset register with AfA.
- Belege-Eingang: watches a folder (e.g. an iCloud scanner folder) and collects new receipts.
- Receipt recognition **only on request**, fully local: embedded e-invoice XML, PDF text, Apple Vision OCR and a
  local llama.cpp model. Suggestions never overwrite saved data.
- Crop and straighten photographed receipts.

**Bank**
- Import camt.053/052/054 and CSV (N26, Revolut, Wise, plus a generic column mapper).
- Payment matching by invoice number, amount, learned IBAN and name; split and partial payments.

**Steuern: UVA, ZM, EAR**
- UVA with U30 Kennzahlen (Ist- or Sollbesteuerung, monthly or quarterly), ZM, Einnahmen-Ausgaben-Rechnung.
- Upload files for FinanzOnline (UVA U30, ZM U13), checked against the BMF XML schemas.
- Accountant export: BMD booking import CSV, generic CSV, receipts ZIP.
- Kleinunternehmergrenze tracking on the dashboard.

**Prognose**
- Cash forecast over 3–12 months: open invoices with each client's payment delay, recurring invoices, fixed costs,
  open expenses, VAT payments and income tax prepayments, with the projected account balance.

**Assistent**
- In-app chat assistant on a local model (llama.cpp, Qwen3.5-4B recommended) that can look things up, open records,
  draft invoices and match payments. Every state-changing action needs your confirmation.
- Voice input via whisper.cpp, also fully local.
- [MCP server](src/mcp/README.md) so external AI clients (Claude Code, Claude Desktop, …) can work with your data.

**Everything else**
- Global search (⌘K), keyboard shortcuts, dark mode, CSV/ZIP export, daily database snapshots.

## Screenshots

| | |
|---|---|
| ![Invoice editor](docs/screenshots/invoice.png) | ![Expense with receipt recognition](docs/screenshots/expense.png) |
| Invoice editor | Expense with receipt recognition |
| ![Bank matching](docs/screenshots/bank.png) | ![UVA](docs/screenshots/tax.png) |
| Bank matching | UVA |
| ![Assistant](docs/screenshots/assistant.png) | ![Dark mode](docs/screenshots/dark.png) |
| Assistant | Dark mode |

All screenshots show demo data.

## Requirements

- [Bun](https://bun.sh) 1.3.13 or newer. No Node.js needed.
- **macOS recommended.** The core app (documents, expenses, bank, taxes, PDFs) is plain TypeScript and SQLite and is
  tested on macOS and Linux in CI.
  Apple Vision OCR and receipt cropping need macOS with the Xcode command line tools (`swiftc`); on other systems receipt
  recognition falls back to Tesseract if it is installed.
- Optional, for the assistant and receipt recognition: [llama.cpp](https://github.com/ggml-org/llama.cpp)
  (`llama-server`) and a GGUF model, e.g. `llama-server -hf unsloth/Qwen3.5-4B-GGUF:UD-Q4_K_XL` once to download it.
  nesev starts and stops `llama-server` itself and never downloads anything.
- Optional, for voice input: [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`brew install whisper-cpp`) and a
  whisper model (`ggml-large-v3-turbo-q5_0` recommended).

## Quick start

```bash
bun install
bun run demo          # demo data in demo-data/, served on http://127.0.0.1:3999; your data/ is not touched
```

`bun run demo -- --reset` seeds the demo data again (dates are relative to the seed day), `-- --port 4100` picks
another port.

For real use:

```bash
PORT=3998 bun run dev               # development: API on :3998 + Vite dev server (prints its URL)
bun run build && PORT=3998 bun start  # production: one process serves the web app and the API on :3998
```

Then open the URL that is printed and fill in Einstellungen → Unternehmen (company, UID, Steuernummer, IBAN) before
writing the first invoice. On macOS, `bun run service:install --port 3998` installs a launchd agent that keeps nesev
running in the background.

| Env | Default | |
|---|---|---|
| `PORT` | `3001` | API / server port |
| `NESEV_DATA_DIR` | `<repo>/data` | where the database, PDFs and receipts live |
| `NESEV_HOST` | `127.0.0.1` | interface to listen on |

> [!WARNING]
> nesev has **no authentication** by design. It listens on `127.0.0.1` only. Don't set `NESEV_HOST=0.0.0.0` or put it
> behind a public reverse proxy: anyone who can reach the port can read and change all of your bookkeeping data. See
> [SECURITY.md](SECURITY.md).

## Data & backups

Everything lives in `data/` (or `NESEV_DATA_DIR`), which is gitignored:

```
data/
  nesev.db      SQLite database (WAL mode)
  pdfs/         frozen PDFs of finalized documents
  receipts/     expense receipts by year
  assets/       logo, letterhead
  backups/      daily database snapshots (newest 14 kept)
  bin/          helpers compiled on first use (Apple Vision OCR)
```

Back up the whole folder. Under Export you can download a backup ZIP (database snapshot, assets, PDFs, receipts),
CSV exports and an accountant export (BMD CSV, generic CSV, all documents and receipts as a ZIP).

## MCP server

`bun run mcp` starts a stdio [MCP](https://modelcontextprotocol.io) server with read and write tools (search,
dashboard, documents, expenses, tax reports, drafts, finalizing with confirmation in the client, …). It calls nesev's
API in-process and opens no network port. Setup for Claude Code and Claude Desktop: [src/mcp/README.md](src/mcp/README.md).

## Project layout

```
src/shared/   logic shared by server and web: money, totals, tax modes, schemas
src/server/   Hono API (routes/, services/), SQLite + Drizzle, PDF, bank parsers, OCR, llama.cpp/whisper.cpp
src/web/      React SPA: features/<area>/, sdk/ (typed API client), shadcn/ui components
src/mcp/      MCP server
```

- [CONVENTIONS.md](CONVENTIONS.md): code layout, API and form patterns, units, colors.
- [PLAN.md](PLAN.md): how each feature works in detail, open decisions and the roadmap.
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, tests and the rules for changes.

## Disclaimer

nesev is a bookkeeping **helper**, not tax advice. The UVA, ZM and EAR figures, the FinanzOnline upload files and the
BMD export follow Austrian rules as the author understands them and may be incomplete or wrong for your situation.
Check every figure before you file it, and talk to your Steuerberater when in doubt. nesev transmits nothing to
FinanzOnline; you upload the files yourself.

The software is provided "as is", without warranty of any kind (see sections 15 and 16 of the license). You are
responsible for your bookkeeping, for keeping records as required by law (e.g. BAO retention periods) and for backups.

## License

[GNU Affero General Public License v3.0 only](LICENSE) (AGPL-3.0-only).

You may use, change and share nesev freely. If you distribute it, or let other people use a modified version over a
network, you have to make the complete source code of your version available under the same license.

## Credits

nesev is built on [Bun](https://bun.sh), [Hono](https://hono.dev), [SQLite](https://sqlite.org) and
[Drizzle ORM](https://orm.drizzle.team), [React](https://react.dev), [Vite](https://vite.dev),
[Tailwind CSS](https://tailwindcss.com), [shadcn/ui](https://ui.shadcn.com) and [Radix UI](https://www.radix-ui.com),
[TanStack Router, Query and Table](https://tanstack.com), [react-hook-form](https://react-hook-form.com),
[Zod](https://zod.dev), [pdfme](https://pdfme.com), [fflate](https://github.com/101arrowz/fflate),
[Lucide](https://lucide.dev) icons and the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
Local AI runs on [llama.cpp](https://github.com/ggml-org/llama.cpp) and [whisper.cpp](https://github.com/ggml-org/whisper.cpp).

The logo is set in [Bricolage Grotesque](https://github.com/ateliertriay/bricolage) (SIL Open Font License 1.1),
outlined to paths. PDFs use [Inter](https://rsms.me/inter/) (SIL Open Font License 1.1, bundled in
`src/server/assets/fonts/`).

### Third-party licenses

All production dependencies use permissive licenses compatible with the AGPL-3.0: MIT (most), Apache-2.0
(MCP SDK, Drizzle ORM, class-variance-authority), ISC (Lucide), BSD-3-Clause, 0BSD, Unlicense, MIT AND Zlib (pako) and
MPL-2.0 OR Apache-2.0 (DOMPurify, used under Apache-2.0). llama.cpp (MIT) and whisper.cpp (MIT) are external programs
that you install yourself; models have their own licenses.
