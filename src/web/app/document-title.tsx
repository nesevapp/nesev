import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { assetQuery, clientQuery, documentQuery, expenseQuery, recurringQuery, reminderQuery, templateQuery } from "@/sdk";

// Browser tab titles ("Rechnungen · nesev", "RE-2026-0012 · nesev"), set centrally from the current path. List pages
// come from a fixed mapping; detail pages read their record from the query cache the page itself fills (enabled:
// false, so this never fetches). A page can override the title with useDocumentTitle() (e.g. the 404 page).

const SUFFIX = "nesev";

const STATIC: [RegExp, string][] = [
  [/^\/$/, "Dashboard"],
  [/^\/forecast$/, "Zahlungsprognose"],
  [/^\/offers$/, "Angebote"],
  [/^\/offers\/new$/, "Neues Angebot"],
  [/^\/invoices$/, "Rechnungen"],
  [/^\/invoices\/new$/, "Neue Rechnung"],
  [/^\/credit-notes$/, "Gutschriften"],
  [/^\/credit-notes\/new$/, "Neue Gutschrift"],
  [/^\/reminders$/, "Mahnungen"],
  [/^\/recurring$/, "Serienrechnungen"],
  [/^\/recurring\/new$/, "Neue Serienrechnung"],
  [/^\/expenses$/, "Ausgaben"],
  [/^\/expenses\/new$/, "Neue Ausgabe"],
  [/^\/expenses\/inbox$/, "Belege-Eingang"],
  [/^\/fixed-costs$/, "Fixkosten"],
  [/^\/assets$/, "Anlagen"],
  [/^\/bank$/, "Bank"],
  [/^\/tax$/, "Steuern"],
  [/^\/clients$/, "Kunden"],
  [/^\/clients\/new$/, "Neuer Kunde"],
  [/^\/articles$/, "Artikel"],
  [/^\/settings$/, "Einstellungen"],
  [/^\/templates$/, "PDF-Vorlagen"],
  [/^\/export$/, "Export & Backup"],
];

type DetailKind = "document" | "client" | "expense" | "asset" | "recurring" | "reminder" | "template";

const DETAIL: [RegExp, DetailKind, string][] = [
  [/^\/(?:offers|invoices|credit-notes)\/(\d+)$/, "document", "Beleg"],
  [/^\/clients\/(\d+)(?:\/edit)?$/, "client", "Kunde"],
  [/^\/expenses\/(\d+)$/, "expense", "Ausgabe"],
  [/^\/assets\/(\d+)$/, "asset", "Anlage"],
  [/^\/recurring\/(\d+)$/, "recurring", "Serienrechnung"],
  [/^\/reminders\/(\d+)$/, "reminder", "Mahnung"],
  [/^\/templates\/(\d+)$/, "template", "PDF-Vorlage"],
];

const DRAFT_LABEL: Record<string, string> = {
  offer: "Angebotsentwurf",
  invoice: "Rechnungsentwurf",
  credit_note: "Gutschriftsentwurf",
};

// ── page override ──────────────────────────────────────────────────────────────
let override: string | null = null;
const listeners = new Set<() => void>();
const setOverride = (next: string | null) => {
  override = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Sets the tab title while the calling component is mounted (wins over the path mapping). */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return;
    setOverride(title);
    return () => setOverride(null);
  }, [title]);
}

// ── central title ──────────────────────────────────────────────────────────────
const cached = { enabled: false } as const;

function useDetailTitle(path: string): string | null {
  const match = DETAIL.map(([re, kind, fallback]) => {
    const m = re.exec(path);
    return m ? { kind, id: Number(m[1]), fallback } : null;
  }).find(Boolean);
  const is = (k: DetailKind) => match?.kind === k;
  const id = match?.id ?? 0;
  const doc = useQuery({ ...documentQuery(id), ...cached }).data;
  const client = useQuery({ ...clientQuery(id), ...cached }).data;
  const expense = useQuery({ ...expenseQuery(id), ...cached }).data;
  const asset = useQuery({ ...assetQuery(id), ...cached }).data;
  const recurring = useQuery({ ...recurringQuery(id), ...cached }).data;
  const reminder = useQuery({ ...reminderQuery(id), ...cached }).data;
  const template = useQuery({ ...templateQuery(id), ...cached }).data;
  if (!match) return null;
  let title: string | null | undefined;
  if (is("document") && doc) title = doc.number || DRAFT_LABEL[doc.type];
  else if (is("client") && client) title = client.name;
  else if (is("expense") && expense) title = expense.supplierName ? `Ausgabe ${expense.supplierName}` : null;
  else if (is("asset") && asset) title = asset.name;
  else if (is("recurring") && recurring) title = recurring.name;
  else if (is("reminder") && reminder) title = reminder.number ? `Mahnung ${reminder.number}` : `${reminder.level}. Mahnstufe`;
  else if (is("template") && template) title = template.name;
  return title || match.fallback;
}

/** Keeps document.title in sync with the current page; rendered once in the app shell. */
export function DocumentTitle() {
  const path = useRouterState({ select: (s) => s.location.pathname.replace(/\/+$/, "") || "/" });
  const pageOverride = useSyncExternalStore(subscribe, () => override);
  const detail = useDetailTitle(path);
  const title = pageOverride ?? detail ?? STATIC.find(([re]) => re.test(path))?.[1] ?? null;
  useEffect(() => {
    document.title = title ? `${title} · ${SUFFIX}` : SUFFIX;
  }, [title]);
  return null;
}
