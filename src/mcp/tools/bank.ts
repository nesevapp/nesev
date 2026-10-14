import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { BANK_TX_STATUS_LABELS, BANK_TX_STATUSES, type BankTxStatus, formatIban } from "../../shared/bank";
import type { DocumentType } from "../../shared/documents";
import { call, idParam } from "../api";
import { bullets, deDate, eur, euroAmount, isoDate, join, Money, money } from "../format";
import { CHANGES_STATE, defineTool, READ_ONLY, type ToolContext, ToolError } from "../tool";
import { documentPath } from "./documents";

// Bank transactions and payment matching. Matching, suggestions and the settling of invoices/expenses stay in
// services/bank-matching.ts; the tools only call /api/bank and format.

const TargetKind = z.enum(["invoice", "credit_note", "expense"]);
type TargetKind = z.infer<typeof TargetKind>;

const MatchRow = z.object({
  matchId: z.number().int().describe("for unmatch_bank_transaction"),
  kind: TargetKind,
  id: z.number().int(),
  number: z.string().nullable(),
  name: z.string().describe("client or supplier"),
  amount: Money,
  link: z.string(),
});

const Suggestion = z.object({
  kind: TargetKind,
  id: z.number().int(),
  number: z.string(),
  name: z.string(),
  issueDate: z.string(),
  open: Money,
  proposedAmount: Money.describe("amount to allocate"),
  confidence: z.enum(["high", "medium", "low"]),
  reasons: z.array(z.string()),
  link: z.string(),
});

const TransactionRow = z.object({
  id: z.number().int(),
  date: z.string(),
  accountId: z.number().int(),
  account: z.string(),
  amount: Money.describe("signed: incoming > 0, outgoing < 0"),
  direction: z.enum(["in", "out"]),
  counterparty: z.string(),
  purpose: z.string(),
  status: z.enum(BANK_TX_STATUSES),
  statusLabel: z.string(),
  remaining: Money.describe("not yet allocated"),
  matches: z.array(MatchRow),
  link: z.string(),
});

const TransactionDetail = TransactionRow.extend({
  counterpartyIban: z.string(),
  reference: z.string(),
  valueDate: z.string().nullable(),
  allocated: Money,
  suggestions: z.array(Suggestion).describe("best match candidates, open transactions only"),
});

interface ApiMatch {
  id: number;
  amountCents: number;
  documentId: number | null;
  documentType: string | null;
  documentNumber: string | null;
  clientName: string | null;
  expenseId: number | null;
  expenseNumber: string | null;
  supplierName: string | null;
}
interface ApiSuggestion {
  kind: "document" | "expense";
  id: number;
  number: string;
  name: string;
  issueDate: string;
  openCents: number;
  amountCents: number;
  confidence: "high" | "medium" | "low";
  reasons: { label: string }[];
}
interface ApiTransaction {
  id: number;
  accountId: number;
  accountName: string;
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  counterpartyName: string;
  counterpartyIban: string;
  purpose: string;
  reference: string;
  status: BankTxStatus;
  allocatedCents: number;
  remainingCents: number;
  matches: ApiMatch[];
  suggestions: ApiSuggestion[];
}

const targetLink = (ctx: ToolContext, kind: TargetKind, id: number) =>
  ctx.webUrl(kind === "expense" ? `/expenses/${id}` : documentPath(kind as DocumentType, id));

/** The bank page filtered to the transaction's account and amount (there is no detail page). */
function txLink(ctx: ToolContext, t: { accountId: number; amountCents: number }) {
  const amount = (Math.abs(t.amountCents) / 100).toFixed(2).replace(".", ",");
  return ctx.webUrl(`/bank?account=${t.accountId}&status=all&q=${encodeURIComponent(amount)}`);
}

function matchRow(ctx: ToolContext, m: ApiMatch): z.input<typeof MatchRow> {
  const kind: TargetKind = m.documentId ? (m.documentType === "credit_note" ? "credit_note" : "invoice") : "expense";
  const id = (m.documentId ?? m.expenseId)!;
  return {
    matchId: m.id,
    kind,
    id,
    number: m.documentId ? m.documentNumber : m.expenseNumber,
    name: (m.documentId ? m.clientName : m.supplierName) ?? "",
    amount: money(m.amountCents),
    link: targetLink(ctx, kind, id),
  };
}

function suggestion(ctx: ToolContext, s: ApiSuggestion): z.input<typeof Suggestion> {
  const kind: TargetKind = s.kind === "document" ? "invoice" : "expense";
  return {
    kind,
    id: s.id,
    number: s.number,
    name: s.name,
    issueDate: s.issueDate,
    open: money(s.openCents),
    proposedAmount: money(s.amountCents),
    confidence: s.confidence,
    reasons: s.reasons.map((r) => r.label),
    link: targetLink(ctx, kind, s.id),
  };
}

function txRow(ctx: ToolContext, t: ApiTransaction): z.input<typeof TransactionRow> {
  return {
    id: t.id,
    date: t.bookingDate,
    accountId: t.accountId,
    account: t.accountName,
    amount: money(t.amountCents),
    direction: t.amountCents >= 0 ? "in" : "out",
    counterparty: t.counterpartyName,
    purpose: t.purpose,
    status: t.status,
    statusLabel: BANK_TX_STATUS_LABELS[t.status],
    remaining: money(t.remainingCents),
    matches: t.matches.map((m) => matchRow(ctx, m)),
    link: txLink(ctx, t),
  };
}

const matchText = (m: z.input<typeof MatchRow>) => `${m.number ?? "Entwurf"} ${m.name} (${m.kind} id ${m.id}) ${m.amount.formatted}`;

function txLine(r: z.input<typeof TransactionRow>) {
  return join(
    `${deDate(r.date)} ${r.amount.formatted}`,
    r.counterparty || "(ohne Name)",
    r.purpose && r.purpose.slice(0, 80),
    r.statusLabel,
    r.matches.length ? `→ ${r.matches.map(matchText).join(", ")}` : null,
    `id ${r.id}`,
  );
}

async function transactionDetail(ctx: ToolContext, id: number, headline?: string) {
  const t = (await call(ctx.api.bank.transactions[":id"].$get({ param: idParam(id) }))) as ApiTransaction;
  const data = {
    ...txRow(ctx, t),
    counterpartyIban: formatIban(t.counterpartyIban),
    reference: t.reference,
    valueDate: t.valueDate,
    allocated: money(t.allocatedCents),
    suggestions: t.suggestions.map((s) => suggestion(ctx, s)),
  };
  const text = [
    headline,
    `Bankbuchung (id ${data.id}) · ${data.statusLabel} · ${data.account}`,
    join(`${deDate(data.date)} ${data.amount.formatted}`, data.counterparty, data.counterpartyIban),
    data.purpose && `Zweck: ${data.purpose}`,
    data.reference && `Referenz: ${data.reference}`,
    join(`zugeordnet ${data.allocated.formatted}`, `offen ${data.remaining.formatted}`),
    data.matches.length ? `Zuordnungen:\n${bullets(data.matches.map((m) => `${matchText(m)} (matchId ${m.matchId})`))}` : null,
    data.suggestions.length
      ? `Vorschläge:\n${bullets(
          data.suggestions.map((s) =>
            join(`${s.kind} id ${s.id} ${s.number} ${s.name}`, `offen ${s.open.formatted}`, `Vorschlag ${s.proposedAmount.formatted}`, s.confidence, s.reasons.join(", ")),
          ),
        )}`
      : null,
    `Link: ${data.link}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { text, data };
}

export function registerBankTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "get_bank_overview",
    {
      title: "Bankübersicht",
      group: "bank",
      description:
        "Bank accounts with transaction counts, the sum of imported amounts and the last booking date, plus how many " +
        "transactions are still unmatched (open) and their unallocated sums in/out. Start here for bank questions.",
      input: z.object({}),
      output: z.object({
        accounts: z.array(
          z.object({
            id: z.number().int(),
            name: z.string(),
            iban: z.string(),
            archived: z.boolean(),
            transactionCount: z.number().int(),
            openCount: z.number().int(),
            importedSum: Money.describe("sum of all imported amounts (not necessarily the bank balance)"),
            lastBookingDate: z.string().nullable(),
            link: z.string(),
          }),
        ),
        openCount: z.number().int(),
        openIn: Money.describe("unallocated incoming"),
        openOut: Money.describe("unallocated outgoing, positive"),
      }),
      annotations: READ_ONLY,
    },
    async () => {
      const [accounts, open] = await Promise.all([
        call(ctx.api.bank.accounts.$get()),
        call(ctx.api.bank.transactions.$get({ query: { status: "open" } })),
      ]);
      const sum = (dir: 1 | -1) => open.filter((t) => Math.sign(t.amountCents) === dir).reduce((s, t) => s + t.remainingCents, 0);
      const data = {
        accounts: accounts.map((a) => ({
          id: a.id,
          name: a.name,
          iban: formatIban(a.iban),
          archived: a.archivedAt != null,
          transactionCount: a.transactionCount,
          openCount: a.openCount,
          importedSum: money(a.totalCents),
          lastBookingDate: a.lastBookingDate,
          link: ctx.webUrl(`/bank?account=${a.id}`),
        })),
        openCount: open.length,
        openIn: money(sum(1)),
        openOut: money(sum(-1)),
      };
      const text = [
        `${data.openCount} offene Bankbuchungen: Eingänge ${data.openIn.formatted}, Ausgänge ${data.openOut.formatted}`,
        "Konten:",
        bullets(
          data.accounts.map((a) =>
            join(
              `${a.name} (id ${a.id})${a.archived ? " archiviert" : ""}`,
              a.iban,
              `${a.transactionCount} Buchungen, ${a.openCount} offen`,
              `Summe ${a.importedSum.formatted}`,
              a.lastBookingDate && `letzte ${deDate(a.lastBookingDate)}`,
            ),
          ),
          "(keine Bankkonten)",
        ),
      ].join("\n");
      return { text, data };
    },
  );

  defineTool(
    server,
    "list_bank_transactions",
    {
      title: "Bankbuchungen auflisten",
      group: "bank",
      description:
        "List imported bank transactions, newest first. Default status open (= not yet matched to an invoice/expense). " +
        "Filters: status (open|matched|ignored|all), direction (in|out), accountId, date range, query (name, purpose, " +
        "IBAN, matched number), amount (euros, either sign). Rows show the allocations; use get_bank_transaction for " +
        "match suggestions.",
      input: z.object({
        status: z.enum([...BANK_TX_STATUSES, "all"]).default("open"),
        direction: z.enum(["in", "out"]).optional(),
        accountId: z.number().int().positive().optional(),
        from: isoDate.optional().describe("booking date from"),
        to: isoDate.optional().describe("booking date to"),
        query: z.string().trim().max(200).optional(),
        amount: euroAmount.optional().describe("exact amount in euros"),
        limit: z.number().int().min(1).max(200).default(20),
      }),
      output: z.object({
        total: z.number().int(),
        truncated: z.boolean(),
        sumIn: Money,
        sumOut: Money.describe("negative"),
        transactions: z.array(TransactionRow),
      }),
      annotations: READ_ONLY,
    },
    async ({ status, direction, accountId, from, to, query, amount, limit }) => {
      const rows = await call(
        ctx.api.bank.transactions.$get({
          query: {
            status: status === "all" ? undefined : status,
            direction,
            accountId: accountId ? String(accountId) : undefined,
            from,
            to,
            q: query || undefined,
          },
        }),
      );
      const matching = amount === undefined ? rows : rows.filter((t) => Math.abs(t.amountCents) === Math.abs(amount));
      const transactions = matching.slice(0, limit).map((t) => txRow(ctx, t as ApiTransaction));
      const sumIn = matching.reduce((s, t) => s + Math.max(t.amountCents, 0), 0);
      const sumOut = matching.reduce((s, t) => s + Math.min(t.amountCents, 0), 0);
      const text = [
        `${matching.length} Bankbuchungen${matching.length > transactions.length ? ` (die neuesten ${transactions.length} gezeigt)` : ""}, Eingänge ${eur(sumIn)}, Ausgänge ${eur(sumOut)}:`,
        bullets(transactions.map(txLine)),
      ].join("\n");
      return {
        text,
        data: { total: matching.length, truncated: matching.length > transactions.length, sumIn: money(sumIn), sumOut: money(sumOut), transactions },
      };
    },
  );

  defineTool(
    server,
    "get_bank_transaction",
    {
      title: "Bankbuchung anzeigen",
      group: "bank",
      description:
        "One bank transaction with its allocations and, if open, up to 3 suggested invoices (incoming) or expenses " +
        "(outgoing) with open amount, proposed amount, confidence and reasons. With `query`, searches open " +
        "invoices/expenses by number, name or amount instead (when the right one is not suggested).",
      input: z.object({
        id: z.number().int().positive(),
        query: z.string().trim().min(1).max(200).optional().describe("search candidates by number, name or amount"),
      }),
      output: TransactionDetail,
      annotations: READ_ONLY,
    },
    async ({ id, query }) => {
      const d = await transactionDetail(ctx, id);
      if (!query) return d;
      const found = await call(
        ctx.api.bank.candidates.$get({ query: { direction: d.data.direction, q: query, transactionId: String(id) } }),
      );
      const suggestions = found.slice(0, 10).map((s) => suggestion(ctx, s));
      const lines = suggestions.map((s) => join(`${s.kind} id ${s.id} ${s.number} ${s.name}`, `offen ${s.open.formatted}`, s.reasons.join(", ")));
      const text = `${d.text}\nSuche „${query}“:\n${bullets(lines, "(keine offenen Belege gefunden)")}`;
      return { text, data: { ...d.data, suggestions } };
    },
  );

  defineTool(
    server,
    "match_bank_transaction",
    {
      title: "Bankbuchung zuordnen",
      group: "bank",
      description:
        "Allocate a bank transaction as payment: incoming → finalized invoices, outgoing → expenses or credit notes " +
        "(refunds). One target without amount takes the whole unallocated amount; several targets (split) need an " +
        "amount each. Partial payments are fine. A fully paid invoice/expense becomes paid automatically. Reversible " +
        "with unmatch_bank_transaction.",
      input: z.object({
        id: z.number().int().positive().describe("transaction id"),
        targets: z
          .array(
            z.object({
              kind: TargetKind,
              id: z.number().int().positive(),
              amount: euroAmount.optional().describe("euros, positive; default the unallocated amount"),
            }),
          )
          .min(1)
          .max(20),
      }),
      output: TransactionDetail.extend({
        targets: z.array(z.object({ kind: TargetKind, id: z.number().int(), open: Money.describe("still open after the match"), paid: z.boolean(), link: z.string() })),
      }),
      annotations: CHANGES_STATE,
    },
    async ({ id, targets }) => {
      const tx = await call(ctx.api.bank.transactions[":id"].$get({ param: idParam(id) }));
      if (tx.status === "ignored") throw new ToolError("Die Buchung ist ignoriert; zuerst mit set_bank_transaction_ignored (ignored: false) wieder öffnen");
      if (tx.remainingCents <= 0) throw new ToolError("Die Buchung ist bereits vollständig zugeordnet");
      if (targets.length > 1 && targets.some((t) => t.amount === undefined)) throw new ToolError("Bei mehreren Zielen braucht jedes einen Betrag (amount)");
      const allocations = targets.map((t) => {
        const amountCents = Math.abs(t.amount ?? tx.remainingCents);
        if (amountCents === 0) throw new ToolError("Betrag darf nicht 0 sein");
        return t.kind === "expense" ? { expenseId: t.id, amountCents } : { documentId: t.id, amountCents };
      });
      for (const t of targets) {
        // the API checks the document's type against the direction, but not the kind the model claimed
        if (t.kind === "expense") continue;
        const doc = await call(ctx.api.documents[":id"].$get({ param: idParam(t.id) }));
        if (doc.type !== t.kind) throw new ToolError(`Beleg id ${t.id} ist kein ${t.kind === "invoice" ? "Rechnung" : "Gutschrift"}, sondern ${doc.type}`);
      }
      await call(ctx.api.bank.transactions[":id"].match.$post({ param: idParam(id), json: { allocations } }));
      const after = await Promise.all(
        targets.map(async (t) => {
          const p = await call(
            t.kind === "expense"
              ? ctx.api.bank.expenses[":id"].payments.$get({ param: idParam(t.id) })
              : ctx.api.bank.documents[":id"].payments.$get({ param: idParam(t.id) }),
          );
          return { kind: t.kind, id: t.id, open: money(p.openCents), paid: p.openCents <= 0, link: targetLink(ctx, t.kind, t.id) };
        }),
      );
      const d = await transactionDetail(ctx, id, "Zugeordnet.");
      const effect = bullets(after.map((a) => `${a.kind} id ${a.id}: ${a.paid ? "vollständig bezahlt" : `noch offen ${a.open.formatted}`}`));
      return { text: `${d.text}\nWirkung:\n${effect}`, data: { ...d.data, targets: after } };
    },
  );

  defineTool(
    server,
    "unmatch_bank_transaction",
    {
      title: "Zuordnung lösen",
      group: "bank",
      description:
        "Remove the allocations of a bank transaction (all, or one by matchId from get_bank_transaction). The " +
        "transaction becomes open again; invoices/expenses it had paid become unpaid again.",
      input: z.object({
        id: z.number().int().positive().describe("transaction id"),
        matchId: z.number().int().positive().optional().describe("only this allocation"),
      }),
      output: TransactionDetail,
      annotations: CHANGES_STATE,
    },
    async ({ id, matchId }) => {
      const tx = await call(ctx.api.bank.transactions[":id"].$get({ param: idParam(id) }));
      if (tx.matches.length === 0) throw new ToolError("Die Buchung hat keine Zuordnungen");
      if (matchId) {
        if (!tx.matches.some((m) => m.id === matchId)) throw new ToolError(`Zuordnung ${matchId} gehört nicht zu Buchung ${id}`);
        await call(ctx.api.bank.matches[":id"].$delete({ param: idParam(matchId) }));
      } else {
        await call(ctx.api.bank.transactions[":id"].match.$delete({ param: idParam(id) }));
      }
      return transactionDetail(ctx, id, "Zuordnung gelöst.");
    },
  );

  defineTool(
    server,
    "set_bank_transaction_ignored",
    {
      title: "Bankbuchung ignorieren",
      group: "bank",
      description:
        "Ignore a bank transaction that needs no invoice/expense (private, transfer between own accounts), or with " +
        "ignored: false reopen it. Only transactions without allocations can be ignored.",
      input: z.object({ id: z.number().int().positive(), ignored: z.boolean().default(true) }),
      output: TransactionDetail,
      annotations: { ...CHANGES_STATE, idempotentHint: true },
    },
    async ({ id, ignored }) => {
      const route = ctx.api.bank.transactions[":id"];
      await call(ignored ? route.ignore.$post({ param: idParam(id) }) : route.unignore.$post({ param: idParam(id) }));
      return transactionDetail(ctx, id, ignored ? "Ignoriert." : "Wieder offen.");
    },
  );
}
