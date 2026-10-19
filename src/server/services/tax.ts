import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { formatDate } from "../../shared/dates";
import { DOCUMENT_TYPE_LABELS } from "../../shared/documents";
import {
  calcExpenseTotals,
  categoryLabel,
  deductibleTaxCents,
  EXPENSE_CATEGORIES,
  type ExpenseCategory,
  expenseCostCents,
  getExpenseCategory,
  type VatTreatment,
} from "../../shared/expenses";
import { BP_SCALE, formatCents, roundHalfAwayFromZero } from "../../shared/money";
import type { TaxMode } from "../../shared/tax";
import {
  ACQUISITION_RATE_KZ,
  REVENUE_RATE_KZ,
  type TaxPeriod,
  UVA_KZ,
  type UvaSection,
  uvaDueDate,
  type VatBasis,
  type VatPeriod,
  zmDueDate,
} from "../../shared/tax-report";
import { calcTotals, type TaxGroup } from "../../shared/totals";
import type { DbOrTx } from "../db/client";
import { bankMatches, bankTransactions, clients, documentItems, documents, expenseLines, expenses } from "../db/schema";
import { formatAssetNumber, GWG_LIMIT_CENTS } from "../../shared/assets";
import { afaEntries, ASSET_CATEGORY, expensesWithoutAsset, monthlyAfa } from "./assets";
import { csvAmount, toCsv } from "./export";
import { getSettings } from "./settings";

// Tax reports: UVA (U 30 Kennzahlen), ZM and EAR. A helper for preparing filings, not tax advice.
//
// Which date counts:
// - Revenue, accrual basis (Sollbesteuerung): the invoice/credit note issue date.
// - Revenue, cash basis (Istbesteuerung) and the EAR: payment events. An invoice's events are its bank_matches
//   (booking date, amount); when it is marked paid, the rest of (gross − matched − its credit notes) counts at
//   paidAt. Each event takes the invoice's tax groups pro rata (gross share), so partial payments split
//   cleanly. Credit notes on an invoice dated up to its paidAt are realized through the smaller payment
//   ("absorbed"); only what the payment did not absorb counts on its own (refund matches, otherwise the credit
//   note date). A credit note dated after paidAt never reduces that payment (§ 16 UStG). Credit notes
//   of unpaid invoices wait until that invoice is paid. Credit notes without an invoice count at their
//   matches, otherwise their issue date.
// - Expenses: domestic Vorsteuer follows the basis (cash: § 12 Abs. 1 Z 1 lit. a, deductible once paid);
//   reverse charge / ig. acquisition / import EUSt always use the issue date. EAR uses payment events.
// - ZM: EU reverse-charge invoices by issue date, independent of the basis.
// - EAR: expense lines with category "anlagen" are capitalized, not expensed. Instead the AfA of the year from
//   the Anlagenverzeichnis (fixed_assets, services/assets.ts) and the remaining book value of assets disposed
//   in the year count under E1a KZ 9130 (category rows "afa" / "afa_abgang"). Their VAT is unaffected: the
//   input VAT of an asset purchase stays deductible in the UVA right away.

const isoDay = (s: string) => s.slice(0, 10);
const GWG_CATEGORY = "hardware_gwg";

// ── Money allocation ────────────────────────────────────────────────────────────

/** Slice of `value` for a payment that moves the cumulative paid share from `before` to `after` of `total`. */
function slice(value: number, total: number, before: number, after: number): number {
  if (total === 0) return before === 0 ? value : 0;
  return roundHalfAwayFromZero((value * after) / total) - roundHalfAwayFromZero((value * before) / total);
}

interface Payment {
  date: string;
  amountCents: number;
  note: string;
}

/** Payments capped so their sum never exceeds `cap`, sorted by date. */
function capPayments(payments: Payment[], cap: number): Payment[] {
  const out: Payment[] = [];
  let sum = 0;
  for (const p of [...payments].sort((a, b) => a.date.localeCompare(b.date))) {
    const amount = Math.min(p.amountCents, Math.max(0, cap - sum));
    if (amount <= 0) continue;
    out.push({ ...p, amountCents: amount });
    sum += amount;
  }
  return out;
}

// ── Revenue events ──────────────────────────────────────────────────────────────

export interface DocRef {
  id: number;
  type: "invoice" | "credit_note";
  number: string;
  issueDate: string;
  clientName: string;
  clientCountry: string;
  clientUid: string;
  taxMode: TaxMode;
}

export interface RevenueEvent {
  doc: DocRef;
  date: string;
  /** signed (credit notes negative) */
  groups: TaxGroup[];
  netCents: number;
  taxCents: number;
  /** gross money of this event, signed (exact, unlike netCents + taxCents of the pro-rata slices) */
  amountCents: number;
  note: string;
}

interface LoadedDoc {
  ref: DocRef;
  status: string;
  paidAt: string | null;
  parentId: number | null;
  totals: { groups: TaxGroup[]; grossCents: number };
  payments: Payment[];
}

function loadDocs(db: DbOrTx): LoadedDoc[] {
  const rows = db
    .select()
    .from(documents)
    .where(and(inArray(documents.type, ["invoice", "credit_note"]), ne(documents.status, "draft"), isNotNull(documents.number)))
    .all();
  if (rows.length === 0) return [];
  const ids = rows.map((d) => d.id);
  const items = db.select().from(documentItems).where(inArray(documentItems.documentId, ids)).all();
  const itemsByDoc = new Map<number, typeof items>();
  for (const i of items) itemsByDoc.set(i.documentId, [...(itemsByDoc.get(i.documentId) ?? []), i]);
  const liveClients = new Map(db.select().from(clients).all().map((c) => [c.id, c]));

  const matches = db
    .select({ documentId: bankMatches.documentId, amountCents: bankMatches.amountCents, date: bankTransactions.bookingDate })
    .from(bankMatches)
    .innerJoin(bankTransactions, eq(bankMatches.transactionId, bankTransactions.id))
    .where(isNotNull(bankMatches.documentId))
    .all();
  const paymentsByDoc = new Map<number, Payment[]>();
  for (const m of matches) {
    const list = paymentsByDoc.get(m.documentId!) ?? [];
    list.push({ date: isoDay(m.date), amountCents: m.amountCents, note: "Zahlung (Bank)" });
    paymentsByDoc.set(m.documentId!, list);
  }

  return rows.map((d) => {
    const live = liveClients.get(d.clientId);
    const client = d.clientSnapshot ?? { name: live?.name ?? "", country: live?.country ?? "", uid: live?.uid ?? "" };
    const totals = calcTotals(itemsByDoc.get(d.id) ?? [], d.taxMode);
    return {
      ref: {
        id: d.id,
        type: d.type as "invoice" | "credit_note",
        number: d.number ?? "",
        issueDate: d.issueDate,
        clientName: client.name,
        clientCountry: client.country.toUpperCase(),
        clientUid: client.uid,
        taxMode: d.taxMode,
      },
      status: d.status,
      paidAt: d.paidAt ? isoDay(d.paidAt) : null,
      parentId: d.parentId,
      totals: { groups: totals.taxGroups, grossCents: totals.grossCents },
      payments: paymentsByDoc.get(d.id) ?? [],
    };
  });
}

type Totals = LoadedDoc["totals"];

function eventFor(doc: LoadedDoc, date: string, before: number, after: number, note: string, totals: Totals = doc.totals): RevenueEvent {
  const sign = doc.ref.type === "credit_note" ? -1 : 1;
  const total = totals.grossCents;
  const groups = totals.groups.map((g) => ({
    rateBp: g.rateBp,
    netCents: sign * slice(g.netCents, total, before, after),
    taxCents: sign * slice(g.taxCents, total, before, after),
  }));
  return {
    doc: doc.ref,
    date,
    groups,
    netCents: groups.reduce((s, g) => s + g.netCents, 0),
    taxCents: groups.reduce((s, g) => s + g.taxCents, 0),
    amountCents: sign * (after - before),
    note,
  };
}

/** Events for a document given its (capped, sorted) payments of `total`. */
function paymentEvents(doc: LoadedDoc, payments: Payment[], totals: Totals = doc.totals): RevenueEvent[] {
  const total = totals.grossCents;
  const out: RevenueEvent[] = [];
  let cum = 0;
  for (const p of payments) {
    const next = cum + p.amountCents;
    const partial = p.amountCents !== total;
    const share = total ? Math.round((p.amountCents / total) * 1000) / 10 : 100;
    out.push(eventFor(doc, p.date, cum, next, partial ? `${p.note}, ${share.toLocaleString("de-AT")} %` : p.note, totals));
    cum = next;
  }
  return out;
}

/** All revenue events (any date). `basis` "accrual" → issue dates; "cash" → payment events (see header). */
export function revenueEvents(db: DbOrTx, basis: VatBasis, docs = loadDocs(db)): RevenueEvent[] {
  if (basis === "accrual") return docs.map((d) => eventFor(d, d.ref.issueDate, 0, d.totals.grossCents, ""));

  const byId = new Map(docs.map((d) => [d.ref.id, d]));
  const creditNotesOf = new Map<number, LoadedDoc[]>();
  for (const d of docs) {
    if (d.ref.type !== "credit_note" || d.parentId == null) continue;
    if (byId.get(d.parentId)?.ref.type !== "invoice") continue;
    creditNotesOf.set(d.parentId, [...(creditNotesOf.get(d.parentId) ?? []), d]);
  }
  /** credit note id → amount realized through the invoice's smaller payment */
  const absorbed = new Map<number, number>();
  const out: RevenueEvent[] = [];

  for (const d of docs) {
    if (d.ref.type !== "invoice") continue;
    const gross = d.totals.grossCents;
    const payments = capPayments(d.payments, gross);
    const matched = payments.reduce((s, p) => s + p.amountCents, 0);
    const cns = (creditNotesOf.get(d.ref.id) ?? []).sort((a, b) => a.ref.issueDate.localeCompare(b.ref.issueDate) || a.ref.id - b.ref.id);
    if (d.status === "paid") {
      // Only credit notes granted by the payment date can have reduced it. A later one is a correction of its
      // own period (§ 16 UStG): it counts at its refund match, else its issue date (second loop below).
      const paidAt = d.paidAt;
      const prior = paidAt ? cns.filter((c) => c.ref.issueDate <= paidAt) : cns;
      const cnTotal = prior.reduce((s, c) => s + c.totals.grossCents, 0);
      const rest = Math.max(0, gross - matched - cnTotal);
      if (rest > 0 && paidAt) payments.push({ date: paidAt, amountCents: rest, note: matched ? "Restzahlung" : "Zahlung" });
      let toAbsorb = Math.min(cnTotal, gross - matched);
      for (const cn of prior) {
        const a = Math.min(cn.totals.grossCents, toAbsorb);
        absorbed.set(cn.ref.id, a);
        toAbsorb -= a;
      }
    }
    // Payments cover the invoice minus the absorbed credit notes: take those out per rate first.
    const effective = { groups: d.totals.groups.map((g) => ({ ...g })), grossCents: gross };
    for (const cn of cns) {
      const a = absorbed.get(cn.ref.id) ?? 0;
      if (!a) continue;
      effective.grossCents -= a;
      for (const g of cn.totals.groups) {
        const share = { netCents: slice(g.netCents, cn.totals.grossCents, 0, a), taxCents: slice(g.taxCents, cn.totals.grossCents, 0, a) };
        const target = effective.groups.find((x) => x.rateBp === g.rateBp);
        if (target) {
          target.netCents -= share.netCents;
          target.taxCents -= share.taxCents;
        } else effective.groups.push({ rateBp: g.rateBp, netCents: -share.netCents, taxCents: -share.taxCents });
      }
    }
    out.push(...paymentEvents(d, payments, effective));
  }

  for (const d of docs) {
    if (d.ref.type !== "credit_note") continue;
    const parent = d.parentId != null ? byId.get(d.parentId) : undefined;
    const linked = parent?.ref.type === "invoice";
    const gross = d.totals.grossCents;
    const a = absorbed.get(d.ref.id) ?? 0;
    if (linked && parent!.status !== "paid" && d.payments.length === 0) continue; // waits for the invoice payment
    // The absorbed part counts as already settled; refunds (matches) and the rest follow.
    const payments = capPayments(d.payments, gross - a);
    const matched = payments.reduce((s, p) => s + p.amountCents, 0);
    const rest = linked && parent!.status !== "paid" ? 0 : gross - a - matched;
    if (rest > 0) {
      const date = linked && parent!.paidAt && parent!.paidAt > d.ref.issueDate ? parent!.paidAt : d.ref.issueDate;
      payments.push({ date, amountCents: rest, note: "Gutschrift verrechnet" });
    }
    // Offset the cumulative share by the absorbed part so slices sum to the unabsorbed remainder.
    let cum = a;
    for (const p of payments) {
      out.push(eventFor(d, p.date, cum, cum + p.amountCents, p.note));
      cum += p.amountCents;
    }
  }
  return out;
}

// ── Expense events ──────────────────────────────────────────────────────────────

export interface ExpenseRef {
  id: number;
  number: string;
  supplierName: string;
  supplierCountry: string;
  issueDate: string;
  vatTreatment: VatTreatment;
}

export interface ExpenseEvent {
  expense: ExpenseRef;
  date: string;
  category: string;
  rateBp: number;
  netCents: number;
  /** charged or self-assessed tax */
  taxCents: number;
  /** deductible part of taxCents */
  deductibleCents: number;
  note: string;
}

interface LoadedExpense {
  ref: ExpenseRef;
  paidAt: string | null;
  grossCents: number;
  lines: { category: string; rateBp: number; netCents: number; taxCents: number; deductibleCents: number }[];
  payments: Payment[];
}

function loadExpenses(db: DbOrTx): LoadedExpense[] {
  const rows = db.select().from(expenses).all();
  if (rows.length === 0) return [];
  const lines = db.select().from(expenseLines).all();
  const linesBy = new Map<number, typeof lines>();
  for (const l of lines) linesBy.set(l.expenseId, [...(linesBy.get(l.expenseId) ?? []), l]);
  const matches = db
    .select({ expenseId: bankMatches.expenseId, amountCents: bankMatches.amountCents, date: bankTransactions.bookingDate })
    .from(bankMatches)
    .innerJoin(bankTransactions, eq(bankMatches.transactionId, bankTransactions.id))
    .where(isNotNull(bankMatches.expenseId))
    .all();
  const paymentsBy = new Map<number, Payment[]>();
  for (const m of matches) {
    paymentsBy.set(m.expenseId!, [...(paymentsBy.get(m.expenseId!) ?? []), { date: isoDay(m.date), amountCents: m.amountCents, note: "Zahlung (Bank)" }]);
  }

  const out: LoadedExpense[] = [];
  for (const e of rows) {
    const ls = (linesBy.get(e.id) ?? []).sort((a, b) => a.position - b.position);
    if (ls.length === 0) continue; // draft receipt without lines
    const treatment = e.vatTreatment as VatTreatment;
    out.push({
      ref: {
        id: e.id,
        number: e.number ?? "",
        supplierName: e.supplierName,
        supplierCountry: e.supplierCountry,
        issueDate: e.issueDate,
        vatTreatment: treatment,
      },
      paidAt: e.paidAt ? isoDay(e.paidAt) : null,
      grossCents: calcExpenseTotals(ls, treatment).grossCents,
      lines: ls.map((l) => ({
        category: l.category,
        rateBp: l.taxRateBp,
        netCents: l.netCents,
        taxCents: treatment === "none" ? 0 : l.taxCents,
        deductibleCents: treatment === "none" ? 0 : deductibleTaxCents(l),
      })),
      payments: paymentsBy.get(e.id) ?? [],
    });
  }
  return out;
}

/** Expenses without lines (unvollständig, e.g. a dropped receipt) dated in [from, to]: excluded from reports. */
function incompleteExpenseWarning(db: DbOrTx, from: string, to: string): string[] {
  const withLines = new Set(db.select({ id: expenseLines.expenseId }).from(expenseLines).all().map((l) => l.id));
  const n = db
    .select({ id: expenses.id, issueDate: expenses.issueDate })
    .from(expenses)
    .all()
    .filter((e) => !withLines.has(e.id) && e.issueDate >= from && e.issueDate <= to).length;
  return n ? [`${n} unvollständige ${n === 1 ? "Ausgabe" : "Ausgaben"} (ohne Positionen) in diesem Zeitraum nicht berücksichtigt.`] : [];
}

function expenseEventsAt(e: LoadedExpense, date: string, before: number, after: number, note: string): ExpenseEvent[] {
  return e.lines.map((l) => ({
    expense: e.ref,
    date,
    category: l.category,
    rateBp: l.rateBp,
    netCents: slice(l.netCents, e.grossCents, before, after),
    taxCents: slice(l.taxCents, e.grossCents, before, after),
    deductibleCents: slice(l.deductibleCents, e.grossCents, before, after),
    note,
  }));
}

function expensePayments(e: LoadedExpense): Payment[] {
  const payments = capPayments(e.payments, e.grossCents);
  const matched = payments.reduce((s, p) => s + p.amountCents, 0);
  if (e.paidAt && matched < e.grossCents) payments.push({ date: e.paidAt, amountCents: e.grossCents - matched, note: matched ? "Restzahlung" : "Zahlung" });
  return payments;
}

function expenseCashEvents(e: LoadedExpense): ExpenseEvent[] {
  const payments = expensePayments(e);
  const out: ExpenseEvent[] = [];
  let cum = 0;
  for (const p of payments) {
    out.push(...expenseEventsAt(e, p.date, cum, cum + p.amountCents, p.note));
    cum += p.amountCents;
  }
  return out;
}

/** Expense line events for the UVA: domestic per basis, self-assessed/import by issue date. */
export function uvaExpenseEvents(db: DbOrTx, basis: VatBasis, list = loadExpenses(db)): ExpenseEvent[] {
  return list.flatMap((e) => {
    if (basis === "accrual" || e.ref.vatTreatment !== "domestic") return expenseEventsAt(e, e.ref.issueDate, 0, e.grossCents, "");
    return expenseCashEvents(e);
  });
}

// ── UVA ─────────────────────────────────────────────────────────────────────────

export interface UvaSource {
  kind: "document" | "expense";
  id: number;
  /** invoice / credit note for documents */
  docType?: "invoice" | "credit_note";
  number: string;
  date: string;
  party: string;
  netCents: number;
  taxCents: number;
  note: string;
}

export interface UvaLine {
  kz: string;
  label: string;
  section: UvaSection;
  /** Bemessungsgrundlage (or the amount for KZ without a tax column) */
  amountCents: number;
  /** Umsatzsteuer column; null when the KZ has none */
  taxCents: number | null;
  sources: UvaSource[];
}

export interface UvaInfoLine {
  key: "eu_services" | "third_country" | "unassigned";
  label: string;
  hint: string;
  netCents: number;
  sources: UvaSource[];
}

export interface UvaReport {
  period: TaxPeriod;
  basis: VatBasis;
  vatPeriod: VatPeriod;
  smallBusiness: boolean;
  euServicesIn021: boolean;
  dueDate: string;
  lines: UvaLine[];
  info: UvaInfoLine[];
  /** Σ USt (incl. self-assessed) */
  vatCents: number;
  /** Σ abziehbare Vorsteuer */
  inputVatCents: number;
  /** KZ 095: > 0 Zahllast, < 0 Gutschrift */
  resultCents: number;
  warnings: string[];
  empty: boolean;
}

export interface UvaOptions {
  /** list EU B2B services (place of supply abroad) in KZ 000 and 021 instead of ZM-only */
  euServicesIn021?: boolean;
}

const KZ_TAX_COLUMN = new Set(["022", "029", "006", "037", "056", "057", "072", "073", "008", "088"]);
/** KZ with only a tax amount (no Bemessungsgrundlage column) */
const KZ_TAX_ONLY = new Set(["056", "057"]);

class Acc {
  amount = 0;
  tax = 0;
  sources = new Map<string, UvaSource>();
  add(amount: number, tax: number, src: Omit<UvaSource, "netCents" | "taxCents">, srcNet = amount, srcTax = tax) {
    this.amount += amount;
    this.tax += tax;
    const key = `${src.kind}-${src.id}-${src.date}`;
    const prev = this.sources.get(key);
    if (prev) {
      prev.netCents += srcNet;
      prev.taxCents += srcTax;
    } else this.sources.set(key, { ...src, netCents: srcNet, taxCents: srcTax });
  }
  list(): UvaSource[] {
    return [...this.sources.values()].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  }
}

function docSource(e: RevenueEvent): Omit<UvaSource, "netCents" | "taxCents"> {
  return { kind: "document", id: e.doc.id, docType: e.doc.type, number: e.doc.number, date: e.date, party: e.doc.clientName, note: e.note };
}

function expenseSource(e: ExpenseEvent): Omit<UvaSource, "netCents" | "taxCents"> {
  return { kind: "expense", id: e.expense.id, number: e.expense.number, date: e.date, party: e.expense.supplierName, note: e.note };
}

const inRange = (date: string, p: TaxPeriod) => date >= p.from && date <= p.to;

export function computeUva(db: DbOrTx, period: TaxPeriod, options: UvaOptions = {}): UvaReport {
  const s = getSettings(db);
  const basis = s.vatBasis;
  const euIn021 = options.euServicesIn021 ?? false;
  const acc = new Map<string, Acc>(UVA_KZ.map((k) => [k.kz, new Acc()]));
  const kz = (k: string) => acc.get(k)!;
  const info = { eu_services: new Acc(), third_country: new Acc(), unassigned: new Acc() };
  const warnings: string[] = [];

  const revenue = revenueEvents(db, basis).filter((e) => inRange(e.date, period));
  for (const e of revenue) {
    const src = docSource(e);
    switch (e.doc.taxMode) {
      case "AT_DOMESTIC":
        for (const g of e.groups) {
          const rateKz = REVENUE_RATE_KZ[g.rateBp];
          if (!rateKz) {
            info.unassigned.add(g.netCents, g.taxCents, src);
            continue;
          }
          kz("000").add(g.netCents, 0, src, g.netCents, g.taxCents);
          kz(rateKz).add(g.netCents, g.taxCents, src);
        }
        break;
      case "EU_REVERSE_CHARGE":
        info.eu_services.add(e.netCents, 0, src);
        if (euIn021) {
          kz("000").add(e.netCents, 0, src);
          kz("021").add(e.netCents, 0, src);
        }
        if (!e.doc.clientUid.trim()) warnings.push(`${e.doc.number}: Reverse Charge ohne UID des Kunden.`);
        break;
      case "THIRD_COUNTRY":
        info.third_country.add(e.netCents, 0, src);
        break;
      case "SMALL_BUSINESS":
        kz("000").add(e.netCents, 0, src);
        kz("016").add(e.netCents, 0, src);
        break;
    }
  }

  for (const e of uvaExpenseEvents(db, basis).filter((x) => inRange(x.date, period))) {
    const src = expenseSource(e);
    const vst = s.smallBusiness ? 0 : e.deductibleCents;
    switch (e.expense.vatTreatment) {
      case "domestic":
        if (vst) kz("060").add(vst, 0, src, e.netCents, vst);
        break;
      case "import":
        if (vst) kz("061").add(vst, 0, src, e.netCents, vst);
        break;
      case "reverse_charge":
        kz("057").add(e.netCents, e.taxCents, src);
        if (vst) kz("066").add(vst, 0, src, e.netCents, vst);
        break;
      case "ig_acquisition": {
        const rateKz = ACQUISITION_RATE_KZ[e.rateBp];
        kz("070").add(e.netCents, 0, src, e.netCents, e.taxCents);
        if (rateKz) kz(rateKz).add(e.netCents, rateKz === "071" ? 0 : e.taxCents, src);
        else warnings.push(`${e.expense.number || e.expense.supplierName}: ig. Erwerb mit unbekanntem Steuersatz ${e.rateBp / 100} %.`);
        if (vst) kz("065").add(vst, 0, src, e.netCents, vst);
        break;
      }
      case "none":
        break;
    }
  }

  // FinanzOnline computes the tax of each rate KZ from its base; report that and flag larger deviations of the
  // invoiced tax (cent differences are rounding: per-invoice rounding, pro-rata partial payments).
  for (const meta of UVA_KZ) {
    if (!meta.rateBp || meta.section !== "steuerpflichtig") continue;
    const a = kz(meta.kz);
    const computed = roundHalfAwayFromZero((a.amount * meta.rateBp) / BP_SCALE);
    const diff = a.tax - computed;
    a.tax = computed;
    if (Math.abs(diff) > 2) {
      warnings.push(`KZ ${meta.kz}: Belege weisen ${(diff / 100).toFixed(2).replace(".", ",")} € ${diff > 0 ? "mehr" : "weniger"} USt aus als Bemessungsgrundlage × Satz — prüfen (zu viel ausgewiesene USt wird nach § 11 Abs. 12 geschuldet, KZ 056).`);
    }
  }
  for (const k of ["072", "073", "008", "088"]) {
    const a = kz(k);
    const rate = UVA_KZ.find((m) => m.kz === k)!.rateBp!;
    a.tax = roundHalfAwayFromZero((a.amount * rate) / BP_SCALE);
  }

  // Negative bases (credit notes exceeding revenue of a rate): the U30 schema allows negative amounts only in
  // KZ 063/067/090 (services/tax-xml.ts), and FinanzOnline checks 022+029+006+037 = 000 − 021 − tax-exempt and
  // 072+073+008+088 = 070 − 071. So such a KZ is entered as 0, its tax is corrected via KZ 090 (Vorsteuer via
  // 067), and its (negative) base is taken out of the total KZ 000 / 070 as well, so the sums still match.
  const PARENT_KZ: Record<string, string> = { "021": "000", "011": "000", "017": "000", "016": "000", "071": "070" };
  for (const k of Object.values(REVENUE_RATE_KZ)) PARENT_KZ[k] = "000";
  for (const k of Object.values(ACQUISITION_RATE_KZ)) PARENT_KZ[k] = "070";
  const zeroNegative = (meta: (typeof UVA_KZ)[number]) => {
    const a = kz(meta.kz);
    if (meta.section === "berichtigung" || meta.section === "ergebnis") return; // signed by nature
    if (meta.section === "vorsteuer") {
      if (a.amount < 0) {
        kz("067").amount += a.amount;
        warnings.push(`KZ ${meta.kz} wäre negativ — als Berichtigung in KZ 067 erfasst.`);
        a.amount = 0;
      }
      return;
    }
    if (KZ_TAX_ONLY.has(meta.kz) ? a.tax < 0 : a.amount < 0) {
      if (KZ_TAX_COLUMN.has(meta.kz) && a.tax < 0) kz("090").amount += a.tax;
      const parent = PARENT_KZ[meta.kz];
      if (parent) kz(parent).amount -= a.amount;
      const parts = [KZ_TAX_COLUMN.has(meta.kz) ? "Steuer in KZ 090 berichtigt" : "", parent ? `KZ ${parent} entsprechend angepasst` : ""].filter(Boolean);
      warnings.push(`KZ ${meta.kz} wäre negativ (Gutschriften > Umsätze) — 0 eingetragen${parts.length ? `, ${parts.join(", ")}` : ""}.`);
      a.amount = 0;
      a.tax = 0;
    }
  };
  // parts first, then the totals they belong to (000 / 070 can only stay negative through unassigned parts)
  for (const meta of UVA_KZ) if (PARENT_KZ[meta.kz]) zeroNegative(meta);
  for (const meta of UVA_KZ) if (!PARENT_KZ[meta.kz]) zeroNegative(meta);

  const sumTax = (ks: string[]) => ks.reduce((t, k) => t + kz(k).tax, 0);
  const vatCents = sumTax(["022", "029", "006", "037", "056", "057", "072", "073", "008", "088"]) + kz("090").amount;
  const inputVatCents = ["060", "061", "065", "066", "067"].reduce((t, k) => t + kz(k).amount, 0);
  const resultCents = vatCents - inputVatCents;
  kz("095").amount = resultCents;

  if (info.unassigned.sources.size) warnings.push("Umsätze mit 0 % oder unbekanntem Steuersatz im Inland sind keiner Kennzahl zugeordnet (siehe unten).");

  const lines: UvaLine[] = UVA_KZ.map((meta) => {
    const a = kz(meta.kz);
    return {
      kz: meta.kz,
      label: meta.label,
      section: meta.section,
      amountCents: KZ_TAX_ONLY.has(meta.kz) ? a.tax : a.amount,
      taxCents: KZ_TAX_COLUMN.has(meta.kz) && !KZ_TAX_ONLY.has(meta.kz) ? a.tax : null,
      sources: a.list(),
    };
  });

  const infoLines: UvaInfoLine[] = [
    {
      key: "eu_services",
      label: "EU-Leistungen an Unternehmer (Reverse Charge)",
      hint: euIn021
        ? "In KZ 000 und KZ 021 ausgewiesen; zusätzlich in der ZM melden."
        : "Leistungsort im EU-Ausland (§ 3a Abs. 6): in Österreich nicht steuerbar, nicht in der UVA — nur in der ZM.",
      netCents: info.eu_services.amount,
      sources: info.eu_services.list(),
    },
    {
      key: "third_country",
      label: "Leistungen an Drittland-Kunden (z.B. Schweiz)",
      hint: "Leistungsort im Ausland: in Österreich nicht steuerbar, nicht in der UVA.",
      netCents: info.third_country.amount,
      sources: info.third_country.list(),
    },
    {
      key: "unassigned",
      label: "Inland ohne zuordenbaren Steuersatz",
      hint: "Inlandsumsätze mit 0 % oder unbekanntem Satz — Zuordnung (z.B. KZ 020 steuerfrei, durchlaufende Posten) mit Steuerberatung klären.",
      netCents: info.unassigned.amount,
      sources: info.unassigned.list(),
    },
  ];

  return {
    period,
    basis,
    vatPeriod: s.vatPeriod,
    smallBusiness: s.smallBusiness,
    euServicesIn021: euIn021,
    dueDate: uvaDueDate(period),
    lines,
    info: infoLines,
    vatCents,
    inputVatCents,
    resultCents,
    warnings: [...new Set([...warnings, ...incompleteExpenseWarning(db, period.from, period.to)])],
    empty: lines.every((l) => l.sources.length === 0 && l.amountCents === 0) && infoLines.every((i) => i.sources.length === 0),
  };
}

/** Kennzahl → amount (for FinanzOnline / tests): only non-zero lines. */
export function uvaValues(r: UvaReport): Record<string, { amount: number; tax: number | null }> {
  const out: Record<string, { amount: number; tax: number | null }> = {};
  for (const l of r.lines) if (l.amountCents !== 0 || (l.taxCents ?? 0) !== 0) out[l.kz] = { amount: l.amountCents, tax: l.taxCents };
  return out;
}

// ── ZM ──────────────────────────────────────────────────────────────────────────

export interface ZmRow {
  /** normalized UID incl. country prefix (Greece: EL) */
  uid: string;
  country: string;
  clientNames: string[];
  amountCents: number;
  triangular: boolean;
  services: boolean;
  documents: UvaSource[];
}

export interface ZmReport {
  period: TaxPeriod;
  dueDate: string;
  rows: ZmRow[];
  totalCents: number;
  warnings: string[];
}

export function normalizeUid(uid: string): string {
  const u = uid.replace(/[\s.\-]/g, "").toUpperCase();
  return u.startsWith("GR") ? `EL${u.slice(2)}` : u;
}

export function computeZm(db: DbOrTx, period: TaxPeriod): ZmReport {
  const rows = new Map<string, ZmRow>();
  const warnings: string[] = [];
  for (const e of revenueEvents(db, "accrual")) {
    if (e.doc.taxMode !== "EU_REVERSE_CHARGE" || !inRange(e.date, period)) continue;
    const uid = normalizeUid(e.doc.clientUid);
    if (!uid) warnings.push(`${e.doc.number} (${e.doc.clientName}): keine UID — kann nicht in der ZM gemeldet werden.`);
    const key = uid || `?${e.doc.clientName}`;
    const row = rows.get(key) ?? { uid, country: e.doc.clientCountry, clientNames: [], amountCents: 0, triangular: false, services: true, documents: [] };
    if (!row.clientNames.includes(e.doc.clientName)) row.clientNames.push(e.doc.clientName);
    row.amountCents += e.netCents;
    row.documents.push({ ...docSource(e), netCents: e.netCents, taxCents: 0 });
    rows.set(key, row);
  }
  const list = [...rows.values()].sort((a, b) => a.uid.localeCompare(b.uid));
  for (const r of list) if (r.amountCents < 0) warnings.push(`${r.uid}: negative Summe (Gutschriften) — als Berichtigung melden.`);
  return {
    period,
    dueDate: zmDueDate(period),
    rows: list,
    totalCents: list.reduce((s, r) => s + r.amountCents, 0),
    warnings: [...new Set(warnings)],
  };
}

// ── EAR ─────────────────────────────────────────────────────────────────────────

export interface EarAssetSource {
  id: number;
  /** AV-0001 */
  number: string;
  name: string;
  amountCents: number;
  note: string;
}

export interface EarCategoryRow {
  key: string;
  label: string;
  e1aKz: string;
  hint: string;
  amountCents: number;
  /** AfA rows: the assets behind the amount */
  assets?: EarAssetSource[];
}

export interface EarGroup {
  group: string;
  amountCents: number;
  categories: EarCategoryRow[];
}

export interface EarOpenItem {
  kind: "document" | "expense";
  id: number;
  docType?: "invoice" | "credit_note";
  number: string;
  date: string;
  party: string;
  /** still open at year end (gross) */
  openCents: number;
}

export interface EarReport {
  year: number;
  /** true → amounts gross (Kleinunternehmer, no Vorsteuer) */
  gross: boolean;
  incomeCents: number;
  expensesCents: number;
  profitCents: number;
  monthly: { month: number; incomeCents: number; expensesCents: number; profitCents: number }[];
  income: { label: string; e1aKz: string; amountCents: number; sources: UvaSource[] }[];
  groups: EarGroup[];
  e1a: { kz: string; label: string; amountCents: number }[];
  unpaid: EarOpenItem[];
  warnings: string[];
}

export const E1A_LABELS: Record<string, string> = {
  "9040": "Erlöse (Betriebseinnahmen)",
  "9100": "Waren, Rohstoffe, Hilfsstoffe",
  "9110": "Beigestelltes Personal und Fremdleistungen",
  "9120": "Personalaufwand",
  "9130": "Abschreibungen (AfA, GWG)",
  "9150": "Instandhaltungen",
  "9160": "Reise- und Fahrtspesen",
  "9170": "Kfz-Kosten",
  "9180": "Miet- und Pachtaufwand, Leasing",
  "9190": "Provisionen, Lizenzgebühren",
  "9200": "Werbe- und Repräsentationsaufwand",
  "9220": "Zinsen und ähnliche Aufwendungen",
  "9225": "Eigene Pflichtversicherungsbeiträge",
  "9230": "Übrige Aufwendungen",
};

export function computeEar(db: DbOrTx, year: number): EarReport {
  const s = getSettings(db);
  const gross = s.smallBusiness;
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const warnings: string[] = [];
  const monthly = Array.from({ length: 12 }, (_, month) => ({ month, incomeCents: 0, expensesCents: 0, profitCents: 0 }));
  const monthOf = (d: string) => Number(d.slice(5, 7)) - 1;

  const docs = loadDocs(db);
  const incomeAcc = new Acc();
  const received = new Map<number, number>();
  for (const e of revenueEvents(db, "cash", docs)) {
    if (e.doc.type === "invoice" && e.date <= to) received.set(e.doc.id, (received.get(e.doc.id) ?? 0) + e.amountCents);
    if (e.date < from || e.date > to) continue;
    const amount = gross ? e.netCents + e.taxCents : e.netCents;
    incomeAcc.add(amount, e.taxCents, docSource(e), e.netCents, e.taxCents);
    monthly[monthOf(e.date)]!.incomeCents += amount;
  }

  const catAmounts = new Map<string, number>();
  const expenseList = loadExpenses(db);
  const gwgInYear = new Set<number>();
  for (const e of expenseList.flatMap(expenseCashEvents)) {
    if (e.date < from || e.date > to) continue;
    if (e.category === ASSET_CATEGORY) continue; // capitalized: counts through the AfA below
    if (e.category === GWG_CATEGORY) gwgInYear.add(e.expense.id);
    // Nettomethode: net + non-deductible tax; Kleinunternehmer: no Vorsteuer at all.
    const amount = expenseCostCents(e, e.expense.vatTreatment, gross);
    catAmounts.set(e.category, (catAmounts.get(e.category) ?? 0) + amount);
    monthly[monthOf(e.date)]!.expensesCents += amount;
  }

  const afa = afaEntries(db, year);
  const afaMonthly = monthlyAfa(afa);
  for (const m of monthly) {
    m.expensesCents += afaMonthly[m.month]!;
    m.profitCents = m.incomeCents - m.expensesCents;
  }

  const groups: EarGroup[] = [];
  const known = EXPENSE_CATEGORIES as readonly ExpenseCategory[];
  const allKeys = [...known.map((c) => c.key), ...[...catAmounts.keys()].filter((k) => !getExpenseCategory(k))];
  for (const key of allKeys) {
    const amount = catAmounts.get(key);
    if (!amount) continue;
    const cat = getExpenseCategory(key);
    const groupName = cat?.group ?? "Sonstiges";
    let g = groups.find((x) => x.group === groupName);
    if (!g) groups.push((g = { group: groupName, amountCents: 0, categories: [] }));
    g.amountCents += amount;
    g.categories.push({ key, label: categoryLabel(key), e1aKz: cat?.e1aKz ?? "9230", hint: cat?.hint ?? "", amountCents: amount });
  }
  const afaRows: EarCategoryRow[] = [
    {
      key: "afa",
      label: "Abschreibungen (AfA) lt. Anlagenverzeichnis",
      e1aKz: "9130",
      hint: "Lineare AfA der Anlagegüter, Halbjahresregel im Jahr der Inbetriebnahme",
      amountCents: afa.reduce((t, a) => t + a.afaCents, 0),
      assets: afa.filter((a) => a.afaCents).map((a) => ({ id: a.id, number: formatAssetNumber(a.number), name: a.name, amountCents: a.afaCents, note: "" })),
    },
    {
      key: "afa_abgang",
      label: "Restbuchwert ausgeschiedener Anlagen",
      e1aKz: "9130",
      hint: "Beim Verkauf / Ausscheiden abgeschriebener Restbuchwert",
      amountCents: afa.reduce((t, a) => t + a.disposalCents, 0),
      assets: afa
        .filter((a) => a.disposalCents)
        .map((a) => ({ id: a.id, number: formatAssetNumber(a.number), name: a.name, amountCents: a.disposalCents, note: a.disposalDate ? `ausgeschieden ${formatDate(a.disposalDate)}` : "" })),
    },
  ].filter((r) => r.amountCents !== 0);
  if (afaRows.length) {
    let g = groups.find((x) => x.group === "Anlagen");
    if (!g) groups.push((g = { group: "Anlagen", amountCents: 0, categories: [] }));
    g.amountCents += afaRows.reduce((t, r) => t + r.amountCents, 0);
    g.categories.push(...afaRows);
  }
  for (const e of expensesWithoutAsset(db, from, to)) {
    warnings.push(`${e.number || e.supplierName}: Anlagegut (${formatCents(e.netCents)} netto) nicht als Ausgabe enthalten, aber noch nicht im Anlagenverzeichnis — im Anlagenverzeichnis anlegen, damit die AfA berücksichtigt wird.`);
  }
  // GWG lines above the limit are expensed in full like the user booked them, but they should be capitalized
  // (§ 13 EStG: Anschaffungskosten = net + non-deductible VAT; Kleinunternehmer: gross).
  for (const e of expenseList) {
    if (!gwgInYear.has(e.ref.id)) continue;
    for (const l of e.lines) {
      if (l.category !== GWG_CATEGORY) continue;
      const cost = expenseCostCents(l, e.ref.vatTreatment, gross);
      if (cost <= GWG_LIMIT_CENTS) continue;
      warnings.push(
        `${e.ref.number || e.ref.supplierName}: Geringwertiges Wirtschaftsgut mit ${formatCents(cost)} ${gross ? "brutto" : "netto"} über der GWG-Grenze von ${formatCents(GWG_LIMIT_CENTS)} — voll als Ausgabe enthalten; als Anlagegut (Kategorie „Anlagegüter“) erfassen und abschreiben, sofern es kein Sammelposten mehrerer Geräte ist.`,
      );
    }
  }
  if (catAmounts.get("bewirtung")) warnings.push("Bewirtung ist voll enthalten — ertragsteuerlich nur zu 50 % absetzbar.");

  const incomeCents = incomeAcc.amount;
  const expensesCents = groups.reduce((t, g) => t + g.amountCents, 0);

  const e1aMap = new Map<string, number>([["9040", incomeCents]]);
  for (const g of groups) for (const c of g.categories) e1aMap.set(c.e1aKz, (e1aMap.get(c.e1aKz) ?? 0) + c.amountCents);
  const e1a = [...e1aMap.entries()]
    .filter(([, v]) => v !== 0)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kz, amountCents]) => ({ kz, label: E1A_LABELS[kz] ?? kz, amountCents }));

  // Items of the year still open at year end (not part of this year's EAR). Open as of 31.12. like
  // invoicePaymentState (services/bank.ts): gross − credit notes − payments + refunds on its credit notes, each
  // counted only up to that date; payments include a hand-marked paidAt (the cash events above).
  const unpaid: EarOpenItem[] = [];
  /** invoice id → credit notes issued by year end − refunds on them booked by year end */
  const creditedNet = new Map<number, number>();
  for (const c of docs) {
    if (c.ref.type !== "credit_note" || c.parentId == null) continue;
    const credited = c.ref.issueDate <= to ? c.totals.grossCents : 0;
    const refunded = c.payments.filter((p) => p.date <= to).reduce((t, p) => t + p.amountCents, 0);
    creditedNet.set(c.parentId, (creditedNet.get(c.parentId) ?? 0) + credited - refunded);
  }
  for (const d of docs) {
    if (d.ref.type !== "invoice" || d.ref.issueDate < from || d.ref.issueDate > to) continue;
    const open = d.totals.grossCents - (creditedNet.get(d.ref.id) ?? 0) - (received.get(d.ref.id) ?? 0);
    if (open > 0) unpaid.push({ kind: "document", id: d.ref.id, docType: "invoice", number: d.ref.number, date: d.ref.issueDate, party: d.ref.clientName, openCents: open });
  }
  for (const e of expenseList) {
    if (e.ref.issueDate < from || e.ref.issueDate > to) continue;
    const payable = e.grossCents;
    const open = payable - expensePayments(e).filter((p) => p.date <= to).reduce((t, p) => t + p.amountCents, 0);
    if (open > 0) unpaid.push({ kind: "expense", id: e.ref.id, number: e.ref.number, date: e.ref.issueDate, party: e.ref.supplierName, openCents: open });
  }
  unpaid.sort((a, b) => a.date.localeCompare(b.date));

  return {
    year,
    gross,
    incomeCents,
    expensesCents,
    profitCents: incomeCents - expensesCents,
    monthly,
    income: [{ label: "Erlöse aus Lieferungen und Leistungen", e1aKz: "9040", amountCents: incomeCents, sources: incomeAcc.list() }],
    groups,
    e1a,
    unpaid,
    warnings: [...warnings, ...incompleteExpenseWarning(db, from, to)],
  };
}

// ── CSV ─────────────────────────────────────────────────────────────────────────

const BASIS_LABEL: Record<VatBasis, string> = { accrual: "Sollbesteuerung", cash: "Istbesteuerung" };

function sourceRow(prefix: string[], s: UvaSource): string[] {
  const type = s.kind === "expense" ? "Ausgabe" : s.docType ? DOCUMENT_TYPE_LABELS[s.docType] : "";
  return [...prefix, type, s.number, formatDate(s.date), s.party, csvAmount(s.netCents), csvAmount(s.taxCents), s.note];
}

export function uvaCsv(r: UvaReport): string {
  const rows: string[][] = [];
  for (const l of r.lines) {
    if (l.amountCents === 0 && !l.taxCents && l.kz !== "095") continue;
    rows.push([l.kz, l.label, csvAmount(l.amountCents), l.taxCents == null ? "" : csvAmount(l.taxCents)]);
  }
  rows.push([], ["Zeitraum", r.period.label, "", ""], ["Besteuerung", BASIS_LABEL[r.basis], "", ""], ["Fällig", formatDate(r.dueDate), "", ""]);
  for (const i of r.info) if (i.sources.length) rows.push([i.label, i.hint, csvAmount(i.netCents), ""]);
  rows.push([], ["Kennzahl", "Typ", "Beleg", "Datum", "Partner", "Netto", "Steuer", "Hinweis"]);
  for (const l of r.lines) for (const s of l.sources) rows.push(sourceRow([l.kz], s));
  for (const i of r.info) for (const s of i.sources) rows.push(sourceRow([i.label], s));
  return toCsv(["Kennzahl", "Bezeichnung", "Betrag", "Steuer"], rows);
}

export function zmCsv(r: ZmReport): string {
  return toCsv(
    ["UID-Nummer", "Land", "Kunde", "Summe Bemessungsgrundlagen", "Dreiecksgeschäft", "Sonstige Leistung", "Belege"],
    r.rows.map((row) => [
      row.uid,
      row.country,
      row.clientNames.join(", "),
      csvAmount(row.amountCents),
      row.triangular ? "ja" : "nein",
      row.services ? "ja" : "nein",
      row.documents.map((d) => d.number).join(", "),
    ]),
  );
}

export function earCsv(r: EarReport): string {
  const rows: string[][] = [];
  rows.push(["Einnahmen", "", "Erlöse", "9040", csvAmount(r.incomeCents)]);
  for (const g of r.groups) for (const c of g.categories) rows.push(["Ausgaben", g.group, c.label, c.e1aKz, csvAmount(-c.amountCents)]);
  rows.push(["Gewinn / Verlust", "", "", "", csvAmount(r.profitCents)]);
  const assets = r.groups.flatMap((g) => g.categories.flatMap((c) => (c.assets ?? []).map((a) => ({ ...a, category: c.label }))));
  if (assets.length) {
    rows.push([], ["Anlage", "Bezeichnung", "Art", "Hinweis", "Betrag"]);
    for (const a of assets) rows.push([a.number, a.name, a.category, a.note, csvAmount(-a.amountCents)]);
  }
  rows.push([], ["Monat", "Einnahmen", "Ausgaben", "Ergebnis", ""]);
  for (const m of r.monthly) rows.push([`${r.year}-${String(m.month + 1).padStart(2, "0")}`, csvAmount(m.incomeCents), csvAmount(m.expensesCents), csvAmount(m.profitCents), ""]);
  rows.push([], ["E1a-Kennzahl", "Bezeichnung", "Betrag", "", ""]);
  for (const e of r.e1a) rows.push([e.kz, e.label, csvAmount(e.amountCents), "", ""]);
  return toCsv(["Bereich", "Gruppe", "Kategorie", "E1a-KZ", r.gross ? "Betrag (brutto)" : "Betrag (netto)"], rows);
}

export const taxFileNames = {
  uva: (p: TaxPeriod) => `uva-${p.key}.csv`,
  zm: (p: TaxPeriod) => `zm-${p.key}.csv`,
  ear: (year: number) => `ear-${year}.csv`,
};
