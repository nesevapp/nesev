# Roadmap

What's planned for nesev, roughly in order. Priorities can change; for anything bigger, please open an issue before
you start so we can agree on the approach. What already exists is listed in the [README](README.md#features) and the
[changelog](CHANGELOG.md); open tax questions are in [docs/tax-notes.md](docs/tax-notes.md).

## Next

1. **Data safety:** an offsite backup folder and long-term rotation (weekly/monthly snapshots; Austrian records are
   kept for 7 years, § 132 BAO).
2. **Audit trail:** an append-only log of changes (before/after) to expenses, bank allocations and status changes,
   and a period lock for filed UVA periods (§ 131 BAO).
3. **Email sending (SMTP):** PDF attachment, text templates per document type, mark as sent automatically, send log.
   The MCP server gets an email tool once this exists.
4. **Down payment and final invoices** (Anzahlungs- & Schlussrechnung) from accepted offers.
5. **Packaging:** notarized macOS binaries (no Gatekeeper step for browser downloads), Windows support, a Docker
   image.

## Needs real-world testing

- **Receipt recognition with real receipts.** It works on test receipts; feedback from real-world use is welcome.
- **Bank presets** (George, ELBA, BAWAG, Revolut Business) are not yet verified against real exports. camt and the
  N26, Revolut and Wise CSV formats are tested.
- **BMD export** has not been tested against a real BMD import (see [docs/tax-notes.md](docs/tax-notes.md)).
- **Windows** is untested.

## Assistant

- Turn answers flagged as wrong („Antwort war falsch“) into eval cases as they come in.
- Known weak spots of the recommended 4B model: it sometimes opens a PDF when asked to download it, or answers a
  navigation request without navigating.

## Ideas, not planned

Multi-currency, time tracking, using the balance of the last bank import as the forecast's starting balance,
sending e-invoices via USP/Peppol.
