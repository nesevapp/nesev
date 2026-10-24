# Changelog

All notable changes to nesev are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, minor versions may contain breaking changes;
they are called out here, and database migrations always run automatically on start.

## [Unreleased]

## [0.1.2] – 2026-10-24

Security release: please update.

### Security

- The binaries are built with Bun 1.4.4 (was 1.3.13). It fixes an out-of-bounds write in the bundled brotli decoder
  (CVE-2026-111497, reachable through `fetch`, e.g. the update check) and removes compromised eMudhra (emSign)
  intermediate CAs from the bundled root certificates. Running from source now needs Bun 1.4.4 or newer.

### Changed

- Dependencies: MCP SDK 2.4.0, pdfme 6.2.8, Vite 8.3.5, TanStack Query/Router, react-hook-form, lucide-react.

## [0.1.1] – 2026-10-19

### Added

- **Update hint:** nesev checks once a day whether a newer release is out and shows it in the sidebar (security
  updates highlighted), with the command to update. On by default; switch it off in the setup, under Einstellungen →
  Export & Backup, or with `NESEV_UPDATE_CHECK=0`. Nothing but the request to GitHub is sent.

### Changed

- The app now addresses you with „du“ everywhere (UI, tour, setup, warnings, assistant). Texts to your clients
  (document and reminder texts, PDFs) stay formal.
- Dependencies: pdfme 6.2.6 (security fix GHSA-2rg9-wxfw-wrr7 and PDF fixes), React 19.3.1, TanStack Query,
  lucide-react; CI actions checkout v7 and cache v6.

## [0.1.0] – 2026-10-19

The first public release. nesev is a local, single-user invoicing and bookkeeping app for Austrian sole traders; the
user interface is German.

### Added

- **Documents:** offers, invoices, credit notes and reminders with gapless numbering (`RE-2026-0001`), immutable
  finalized documents with frozen client/seller snapshots and PDF; corrections through credit notes.
- **Tax modes per document:** domestic (20/13/10/0 %), EU reverse charge, third country, Kleinunternehmer.
- **PDFs:** pdfme template designer with letterhead support, EPC QR code („Zahlen mit Code“) on invoices and reminders.
- **E-invoices:** ebInterface 6.1, XRechnung 3.0 (UBL) and ZUGFeRD / Factur-X (EN 16931, PDF/A-3b).
- **Clients and articles** with an article catalog and autocomplete in line items; configurable units.
- **Reminders (Mahnwesen)** with configurable levels, fees and default interest.
- **Recurring invoices** (drafts or auto-finalized) and **Fixkosten** (recurring outgoing payments) linked to expenses.
- **Cash forecast** over 3–12 months: open invoices with each client's payment delay, recurring invoices, Fixkosten,
  open expenses, VAT payments and income tax prepayments, with the projected account balance.
- **Expenses** with receipts, EAR categories, reverse charge / ig. Erwerb / import, partly deductible input VAT, and a
  fixed asset register with AfA.
- **Belege-Eingang:** watches a folder (e.g. a scanner folder) and collects new receipts.
- **Receipt recognition on request only**, fully local: embedded e-invoice XML, PDF text, Apple Vision OCR
  (Tesseract fallback) and a local llama.cpp model. Suggestions never overwrite saved data. Crop and straighten
  photographed receipts (macOS).
- **Bank:** camt.053/052/054 and CSV import (N26, Revolut, Wise, a generic column mapper), payment matching with
  split and partial payments.
- **Taxes:** UVA (U30 Kennzahlen, Ist/Soll, monthly/quarterly), ZM and Einnahmen-Ausgaben-Rechnung; FinanzOnline
  upload files (UVA U30, ZM U13) checked against the BMF schemas; dated Steuerstatus (Kleinunternehmer, Ist/Soll with
  valid-from dates); Kleinunternehmergrenze tracking on the dashboard.
- **Accountant export:** BMD booking import CSV, generic CSV and a receipts ZIP.
- **Dashboard** with revenue, expenses and result per month.
- **Assistant:** in-app chat on a local model (llama.cpp, Qwen3.5-4B recommended) that looks things up, opens
  records, drafts invoices and matches payments; every state-changing action needs a confirmation. Voice input via
  whisper.cpp.
- **MCP server** (`bun run mcp`) so external AI clients can work with your data over stdio.
- Global search (⌘K), keyboard shortcuts, dark mode, guided tour, CSV/ZIP export, backup ZIP and daily database
  snapshots.
- **Release binaries** for macOS (Apple silicon, Intel) and Linux (x64, arm64): one file with the web app, Apple
  Vision helper included on macOS; a **one-line installer** (`install.sh`, checksum-verified, no admin rights) and the
  `nesev` command (`start`, `service install|uninstall|status`, `update`, `restore`, `mcp`, `uninstall`).
- **Background service** on macOS (launchd) and Linux (systemd user unit), from the binary or a checkout.
- **First-start setup:** the data folder is chosen on the first start (OS app-data folder recommended, warning for
  cloud-synced folders) and stored in a per-user config file; a moved or disconnected data folder brings back the
  setup instead of starting with empty books. One default port (3998) for the server, the dev proxy, the service and
  the MCP server.
- **Restore from a backup:** „Backup einspielen“ in the app (ZIP or `.db`, applied on the next start, previous data
  kept in `backups/before-restore-*`), in the first-start setup (moving to a new computer) and `nesev restore`.
- **Database snapshot before migrations** (`backups/pre-migration-*.db`); a database from a newer version is refused.
- **Seller details required on finalize:** documents and reminders can't be finalized without the seller's name and
  full address; a hint for invoices over 400 € with VAT but without own UID.

### Security

- Listens on `127.0.0.1` only; loopback `Host` check against DNS rebinding and refusal of cross-site writes;
  security headers and a Content Security Policy for the web app; uploaded files typed by content. See
  [SECURITY.md](SECURITY.md).

[Unreleased]: https://github.com/nesevapp/nesev/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/nesevapp/nesev/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/nesevapp/nesev/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/nesevapp/nesev/releases/tag/v0.1.0
