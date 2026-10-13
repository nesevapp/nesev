import { normalizeIban } from "../../../shared/bank";
import { BankParseError, clean, type ParsedTransaction, type ParseResult } from "./types";
import { child, children, findAll, parseXml, textAt, type XmlNode } from "./xml";

// ISO 20022 camt.053 (Kontoauszug). Also reads camt.052 (Rpt) and camt.054 (Ntfctn), which share the
// Ntry structure. Only booked entries are imported (Sts = BOOK, or no status at all).
// Batch entries (one Ntry with several TxDtls that each carry an amount) become one transaction per TxDtls.

export function looksLikeCamt(text: string): boolean {
  return /<(\w+:)?(BkToCstmrStmt|BkToCstmrAcctRpt|BkToCstmrDbtCdtNtfctn)\b/.test(text.slice(0, 5000));
}

function amountToCents(s: string): number {
  const n = Number(s.trim());
  if (!Number.isFinite(n)) throw new BankParseError(`Ungültiger Betrag „${s}"`);
  return Math.round(n * 100);
}

/** <BookgDt><Dt>2026-01-02</Dt></BookgDt> or <DtTm>2026-01-02T10:00:00</DtTm> */
function dateOf(node: XmlNode | undefined): string | null {
  const s = textAt(node, "Dt") || textAt(node, "DtTm");
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** Party name: <Dbtr><Nm> (camt v2) or <Dbtr><Pty><Nm> (v8+). */
function partyName(party: XmlNode | undefined): string {
  return clean(textAt(party, "Nm") || textAt(party, "Pty", "Nm"));
}

function accountIban(acct: XmlNode | undefined): string {
  return normalizeIban(textAt(acct, "Id", "IBAN"));
}

function remittance(tx: XmlNode | undefined): { purpose: string; structuredRef: string } {
  const rmt = child(tx, "RmtInf");
  const ustrd = children(rmt, "Ustrd").map((n) => n.text.trim());
  const strdRefs = children(rmt, "Strd").flatMap((s) => {
    const ref = textAt(s, "CdtrRefInf", "Ref");
    const addtl = children(s, "AddtlRmtInf").map((n) => n.text.trim());
    return [ref, ...addtl].filter(Boolean);
  });
  return { purpose: clean([...ustrd, ...strdRefs].join(" ")), structuredRef: strdRefs[0] ?? "" };
}

function entryTransactions(ntry: XmlNode, statementCcy: string): ParsedTransaction[] {
  const status = textAt(ntry, "Sts", "Cd") || textAt(ntry, "Sts");
  if (status && status !== "BOOK") return [];
  const credit = textAt(ntry, "CdtDbtInd") === "CRDT";
  const sign = credit ? 1 : -1;
  const amtNode = child(ntry, "Amt");
  const ntryCents = amountToCents(amtNode?.text ?? "");
  const currency = amtNode?.attrs.Ccy || statementCcy || "EUR";
  const bookingDate = dateOf(child(ntry, "BookgDt")) ?? dateOf(child(ntry, "ValDt"));
  if (!bookingDate) throw new BankParseError("Buchung ohne Buchungsdatum");
  const valueDate = dateOf(child(ntry, "ValDt"));
  const ntryRef = textAt(ntry, "AcctSvcrRef");
  const addtlNtry = clean(textAt(ntry, "AddtlNtryInf"));

  const details = findAll(child(ntry, "NtryDtls") ?? { name: "", attrs: {}, children: [], text: "" }, "TxDtls");
  const split = details.length > 1 && details.every((d) => child(d, "AmtDtls", "TxAmt", "Amt") || child(d, "Amt"));

  const build = (tx: XmlNode | undefined, cents: number, ccy: string): ParsedTransaction => {
    const parties = child(tx, "RltdPties");
    const counterparty = credit
      ? partyName(child(parties, "Dbtr")) || partyName(child(parties, "UltmtDbtr"))
      : partyName(child(parties, "Cdtr")) || partyName(child(parties, "UltmtCdtr"));
    const iban = accountIban(child(parties, credit ? "DbtrAcct" : "CdtrAcct"));
    const { purpose, structuredRef } = remittance(tx);
    const e2e = textAt(tx, "Refs", "EndToEndId");
    const reference =
      [textAt(tx, "Refs", "AcctSvcrRef"), ntryRef, e2e && e2e !== "NOTPROVIDED" ? e2e : "", structuredRef].find(Boolean) ?? "";
    return {
      bookingDate,
      valueDate,
      amountCents: sign * cents || 0,
      currency: ccy,
      counterpartyName: counterparty,
      counterpartyIban: iban,
      purpose: purpose || clean(textAt(tx, "AddtlTxInf")) || addtlNtry,
      reference,
    };
  };

  if (split) {
    return details.map((d) => {
      const a = child(d, "AmtDtls", "TxAmt", "Amt") ?? child(d, "Amt")!;
      return build(d, amountToCents(a.text), a.attrs.Ccy || currency);
    });
  }
  return [build(details[0], ntryCents, currency)];
}

function balance(stmt: XmlNode, code: string): number | null {
  const bal = children(stmt, "Bal").find((b) => textAt(b, "Tp", "CdOrPrtry", "Cd") === code);
  if (!bal) return null;
  const cents = amountToCents(textAt(bal, "Amt"));
  return textAt(bal, "CdtDbtInd") === "DBIT" ? -cents : cents;
}

export function parseCamt(text: string): ParseResult {
  const doc = parseXml(text);
  const statements = [...findAll(doc, "Stmt"), ...findAll(doc, "Rpt"), ...findAll(doc, "Ntfctn")];
  if (statements.length === 0) throw new BankParseError("Keine camt-Kontoauszüge (Stmt) in der Datei gefunden");

  const transactions: ParsedTransaction[] = [];
  const warnings: string[] = [];
  const ibans = new Set<string>();
  let opening: number | null = null;
  let closing: number | null = null;
  // statements in file order: the first opening and the last closing balance span the whole file
  for (const stmt of statements) {
    const iban = accountIban(child(stmt, "Acct"));
    if (iban) ibans.add(iban);
    const ccy = textAt(stmt, "Acct", "Ccy");
    opening ??= balance(stmt, "OPBD") ?? balance(stmt, "PRCD");
    closing = balance(stmt, "CLBD") ?? closing;
    for (const ntry of children(stmt, "Ntry")) transactions.push(...entryTransactions(ntry, ccy));
  }
  if (ibans.size > 1) warnings.push(`Die Datei enthält ${ibans.size} verschiedene Konten.`);
  return {
    format: "camt053",
    transactions,
    accountIban: [...ibans][0] ?? null,
    openingBalanceCents: opening,
    closingBalanceCents: closing,
    warnings,
  };
}
