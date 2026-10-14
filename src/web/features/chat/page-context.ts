import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import type { ChatContext } from "@shared/chat";
import { DOCUMENT_TYPE_LABELS } from "@shared/documents";
import { type Client, type Document, type Expense, keys } from "@/sdk";
import { CREATE_ACTIONS, PAGES } from "@/features/search/commands";

// The page the user is looking at, sent with each message so the model can resolve "diese Rechnung".
// Record titles come from the query cache (the page has already loaded the record); no extra requests.

type Cache = ReturnType<typeof useQueryClient>;

function recordTitle(path: string, qc: Cache): string | null {
  const doc = /^\/(offers|invoices|credit-notes)\/(\d+)$/.exec(path);
  if (doc) {
    const d = qc.getQueryData<Document>(keys.documents.detail(Number(doc[2])));
    if (!d) return null;
    const label = DOCUMENT_TYPE_LABELS[d.type];
    return d.number ? `${label} ${d.number}` : `${label}sentwurf (ID ${d.id})`;
  }
  const client = /^\/clients\/(\d+)/.exec(path);
  if (client) {
    const c = qc.getQueryData<Client>(keys.clients.detail(Number(client[1])));
    return c ? `Kunde ${c.name}` : null;
  }
  const expense = /^\/expenses\/(\d+)$/.exec(path);
  if (expense) {
    const e = qc.getQueryData<Expense>(keys.expenses.detail(Number(expense[1])));
    return e ? `Ausgabe ${e.supplierName} (${e.issueDate})` : null;
  }
  return null;
}

function pageTitle(path: string): string | undefined {
  const create = CREATE_ACTIONS.find((c) => c.to === path);
  if (create) return create.label;
  const pages = PAGES.filter((p) => (p.to === "/" ? path === "/" : path === p.to || path.startsWith(`${p.to}/`)));
  return pages.sort((a, b) => b.to.length - a.to.length)[0]?.label;
}

export function usePageContext(): ChatContext {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const qc = useQueryClient();
  return { path, title: recordTitle(path, qc) ?? pageTitle(path) };
}
