# Changelog

All notable changes to nesev are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, minor versions may contain breaking changes;
they are called out here, and database migrations always run automatically on start.

## [Unreleased]

## [0.1.0] – unreleased

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
- macOS background service (`bun run service:install`).
- **First-start setup:** the data folder is chosen on the first start (OS app-data folder recommended, warning for
  cloud-synced folders) and stored in a per-user config file; one default port (3998) for the server, the dev proxy,
  the service and the MCP server.

Coming in this release (in progress):

- Restore from a backup in the app, plus a documented command-line path.
- A database snapshot before pending migrations run.
- Seller details checked before a document is finalized.
- Release binaries and a one-line installer.

### Security

- Listens on `127.0.0.1` only; loopback `Host` check against DNS rebinding and refusal of cross-site writes;
  security headers and a Content Security Policy for the web app; uploaded files typed by content. See
  [SECURITY.md](SECURITY.md).

[Unreleased]: https://github.com/nesevapp/nesev/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nesevapp/nesev/releases/tag/v0.1.0
