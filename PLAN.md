# nesev — local sevdesk clone

Single-user, local-only (no auth). Offers, invoices, credit notes, clients, PDF designer.
Currency: EUR only. Clients: AT, EU, CH. No e-invoicing for now.

## Stack
- **Bun** runtime, **Hono** API (typed RPC client via `hc`)
- **SQLite** (`bun:sqlite`) + **Drizzle** ORM / drizzle-kit migrations
- **React + Vite + Tailwind + shadcn/ui**, TanStack Router/Table, react-hook-form + zod
- **pdfme** for PDF template designer + generator
- Single package; `bun dev` runs API + Vite (proxy), `bun start` serves built SPA from Hono

```
nesev/
  src/
    server/   index.ts, routes/, db/schema.ts, db/migrations/
    web/      Vite React app (routes, components)
    shared/   zod schemas, totals calc, tax rules, types   ← used by both sides
  data/       nesev.db, pdfs/ (frozen invoices), assets/ (logo, fonts)
```

## Tax modes (per document, defaulted from client country + UID)
| Mode | When | Effect |
|---|---|---|
| `AT_DOMESTIC` | AT clients | 20/13/10/0 % per line |
| `EU_REVERSE_CHARGE` | EU B2B with UID | 0 %, reverse-charge note, client UID required |
| `THIRD_COUNTRY` | CH clients | 0 %, "nicht im Inland steuerbar" note |
| `SMALL_BUSINESS` | Kleinunternehmer | 0 %, §6 Abs 1 Z 27 note |

Note texts configurable in settings (verify wording with tax advisor).

## Data model
- **settings** (singleton): company data, UID, IBAN/BIC, logo, default payment terms, default intro/closing texts, default templates, tax note texts
- **clients**: number, type (company/person), name, contact person, address, country, UID, email, phone, payment terms, default tax mode, notes, archived_at
- **documents**: type (`offer|invoice|credit_note`), status, number (null until finalized), client_id, `client_snapshot` JSON, `seller_snapshot` JSON, issue date, service period, due/valid-until, tax_mode, intro/closing texts, template_id, parent_id (offer→invoice→credit note), cached totals (cents), finalized_at, sent_at, paid_at, pdf_path
- **document_items**: position, title, description, quantity (milli-units), unit, unit_price_cents, tax_rate_bp, discount_bp
- **number_sequences**: per type+year → `AN-2026-0001`, `RE-2026-0001`, `GS-2026-0001`; assigned transactionally on finalize, gapless
- **pdf_templates**: name, doc type, pdfme JSON, optional base PDF, is_default

Rules:
- Money as integer cents; one shared totals function for UI + PDF.
- Finalized invoice = read-only, snapshot + frozen PDF on disk; corrections only via credit note.

## Statuses
- Offer: draft → sent → accepted / declined
- Invoice: draft → final → sent → paid (overdue derived from due date)
- Credit note: draft → final

## Milestones
1. **Scaffold** — Bun/Hono/Vite/Drizzle wiring, migrations, settings page
2. **Clients** — list/search/filter, create/edit, archive
3. **Offers & invoices** — line-item editor with live totals, tax modes, finalize + numbering, status, offer→invoice, invoice→credit note, mark paid
4. **PDF output** — default pdfme template (items table, address variables, totals), preview, frozen PDF on finalize, EPC/GiroCode QR
5. **PDF designer** — pdfme Designer page, multiple templates per doc type, fonts/logo/letterhead, variable picker, live preview with sample data
6. **Polish** — dashboard (open/overdue/revenue per month), CSV export, DB backup

Later: Mahnungen, article catalog, recurring invoices.
