import {
  BellRing,
  Calculator,
  CheckCheck,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  HardDrive,
  LayoutDashboard,
  LineChart,
  type LucideIcon,
  Package,
  Receipt,
  ReceiptEuro,
  ReceiptText,
  Repeat,
  ScanText,
  Search,
  Send,
  Stamp,
  UserPlus,
  Users,
  Wrench,
} from "lucide-react";

// German labels and icons for the MCP tools the assistant can call (names from src/mcp/tools).

const TOOLS: Record<string, { label: string; icon: LucideIcon }> = {
  search: { label: "Suche", icon: Search },
  get_dashboard: { label: "Dashboard", icon: LayoutDashboard },
  list_clients: { label: "Kunden auflisten", icon: Users },
  get_client: { label: "Kunde anzeigen", icon: Users },
  create_client: { label: "Kunde anlegen", icon: UserPlus },
  list_articles: { label: "Artikel auflisten", icon: Package },
  create_article: { label: "Artikel anlegen", icon: Package },
  list_documents: { label: "Belege auflisten", icon: FileSearch },
  get_document: { label: "Beleg anzeigen", icon: FileText },
  list_reminders_due: { label: "Fällig zum Mahnen", icon: BellRing },
  create_invoice_draft: { label: "Rechnung anlegen", icon: FilePlus },
  create_offer_draft: { label: "Angebot anlegen", icon: FilePlus },
  update_document_draft: { label: "Entwurf bearbeiten", icon: FilePen },
  finalize_document: { label: "Beleg finalisieren", icon: Stamp },
  mark_document_sent: { label: "Als versendet markieren", icon: Send },
  mark_invoice_paid: { label: "Als bezahlt markieren", icon: CheckCheck },
  convert_offer_to_invoice: { label: "Angebot in Rechnung umwandeln", icon: Repeat },
  create_credit_note: { label: "Gutschrift erstellen", icon: ReceiptText },
  create_reminder: { label: "Mahnung erstellen", icon: BellRing },
  list_expenses: { label: "Ausgaben auflisten", icon: ReceiptEuro },
  get_expense: { label: "Ausgabe anzeigen", icon: ReceiptEuro },
  create_expense: { label: "Ausgabe erfassen", icon: Receipt },
  list_fixed_costs: { label: "Fixkosten auflisten", icon: Repeat },
  get_forecast: { label: "Zahlungsprognose", icon: LineChart },
  get_tax_report: { label: "Steuerauswertung", icon: Calculator },
  list_assets: { label: "Anlagenverzeichnis", icon: HardDrive },
  get_receipt_analysis: { label: "Belegerkennung anzeigen", icon: ScanText },
  queue_receipt_analysis: { label: "Belegerkennung starten", icon: ScanText },
};

export function toolMeta(name: string): { label: string; icon: LucideIcon } {
  return TOOLS[name] ?? { label: name, icon: Wrench };
}

/** Finalizing is irreversible: its confirm button is styled destructive. */
export const isIrreversibleTool = (name: string) => name === "finalize_document" || name === "create_credit_note";

const ARG_LABELS: Record<string, string> = {
  query: "Suche",
  q: "Suche",
  client: "Kunde",
  clientId: "Kunde",
  documentId: "Beleg",
  id: "ID",
  type: "Typ",
  status: "Status",
  from: "von",
  to: "bis",
  period: "Zeitraum",
  year: "Jahr",
  items: "Positionen",
  date: "Datum",
  name: "Name",
};

function argValue(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (Array.isArray(v)) return v.length === 1 ? "1 Eintrag" : `${v.length} Einträge`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const named = o.name ?? o.number ?? o.id;
    return named != null ? String(named) : "…";
  }
  const s = String(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

/** One-line summary of a tool call's arguments, e.g. "Suche: Müller · Typ: invoice". */
export function summarizeArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => {
      const value = argValue(v);
      return value === null ? null : `${ARG_LABELS[k] ?? k}: ${value}`;
    })
    .filter(Boolean)
    .slice(0, 4)
    .join(" · ");
}
