import type { NavigateOptions } from "@tanstack/react-router";
import {
  Archive,
  BellRing,
  Calculator,
  CalendarClock,
  FileText,
  HardDrive,
  Landmark,
  LayoutDashboard,
  LayoutTemplate,
  LineChart,
  type LucideIcon,
  Package,
  Receipt,
  ReceiptEuro,
  ReceiptText,
  Repeat,
  Settings,
  Users,
} from "lucide-react";
import type { SearchResultType } from "@/sdk";

// Static palette entries (pages and create actions) and the keyboard shortcuts that open them.
// `key` is the second key of a "g …" (pages) or "n …" (create) sequence.

export type AppPath = NonNullable<NavigateOptions["to"]>;

export interface PaletteCommand {
  id: string;
  label: string;
  to: AppPath;
  icon: LucideIcon;
  key?: string;
  /** extra words the client-side filter matches */
  keywords?: string;
}

export const PAGES: PaletteCommand[] = [
  { id: "page:dashboard", label: "Dashboard", to: "/", icon: LayoutDashboard, key: "d", keywords: "übersicht start" },
  { id: "page:forecast", label: "Zahlungsprognose", to: "/forecast", icon: LineChart, key: "p", keywords: "prognose cashflow liquidität" },
  { id: "page:offers", label: "Angebote", to: "/offers", icon: FileText, key: "a" },
  { id: "page:invoices", label: "Rechnungen", to: "/invoices", icon: Receipt, key: "r" },
  { id: "page:credit-notes", label: "Gutschriften", to: "/credit-notes", icon: ReceiptText, key: "g", keywords: "storno" },
  { id: "page:reminders", label: "Mahnungen", to: "/reminders", icon: BellRing, key: "m", keywords: "mahnwesen zahlungserinnerung" },
  { id: "page:recurring", label: "Serienrechnungen", to: "/recurring", icon: Repeat, key: "w", keywords: "wiederkehrend abo" },
  { id: "page:expenses", label: "Ausgaben", to: "/expenses", icon: ReceiptEuro, key: "e", keywords: "belege eingangsrechnungen" },
  { id: "page:fixed-costs", label: "Fixkosten", to: "/fixed-costs", icon: CalendarClock, key: "f", keywords: "laufende kosten" },
  { id: "page:assets", label: "Anlagen", to: "/assets", icon: HardDrive, key: "v", keywords: "anlageverzeichnis afa abschreibung" },
  { id: "page:bank", label: "Bank", to: "/bank", icon: Landmark, key: "b", keywords: "umsätze konto zahlungen" },
  { id: "page:tax", label: "Steuern", to: "/tax", icon: Calculator, key: "s", keywords: "uva zm ear umsatzsteuer" },
  { id: "page:clients", label: "Kunden", to: "/clients", icon: Users, key: "k" },
  { id: "page:articles", label: "Artikel", to: "/articles", icon: Package, key: "i", keywords: "produkte leistungen" },
  { id: "page:templates", label: "PDF-Vorlagen", to: "/templates", icon: LayoutTemplate, keywords: "designer layout" },
  { id: "page:export", label: "Export & Backup", to: "/export", icon: Archive, key: "x", keywords: "sicherung csv zip" },
  { id: "page:settings", label: "Einstellungen", to: "/settings", icon: Settings, key: ",", keywords: "firma konfiguration" },
];

export const CREATE_ACTIONS: PaletteCommand[] = [
  { id: "new:invoice", label: "Neue Rechnung", to: "/invoices/new", icon: Receipt, key: "r" },
  { id: "new:offer", label: "Neues Angebot", to: "/offers/new", icon: FileText, key: "a" },
  { id: "new:credit-note", label: "Neue Gutschrift", to: "/credit-notes/new", icon: ReceiptText, key: "g" },
  { id: "new:client", label: "Neuer Kunde", to: "/clients/new", icon: Users, key: "k" },
  { id: "new:expense", label: "Neue Ausgabe", to: "/expenses/new", icon: ReceiptEuro, key: "e", keywords: "beleg" },
  { id: "new:recurring", label: "Neue Serienrechnung", to: "/recurring/new", icon: Repeat, key: "w" },
];

export const RESULT_ICONS: Record<SearchResultType, LucideIcon> = {
  client: Users,
  invoice: Receipt,
  offer: FileText,
  credit_note: ReceiptText,
  reminder: BellRing,
  recurring: Repeat,
  expense: ReceiptEuro,
  fixed_cost: CalendarClock,
  asset: HardDrive,
  article: Package,
};

/** Lower-case, umlauts folded both ways ("ä" → "a", "ae" → "a"), for the client-side filter. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss")
    .replace(/ae/g, "a")
    .replace(/oe/g, "o")
    .replace(/ue/g, "u");
}

/** Every word of the query must start a word of the label or keywords ("neu rech" → "Neue Rechnung"). */
export function matchesCommand(cmd: PaletteCommand, query: string): boolean {
  const words = fold(`${cmd.label} ${cmd.keywords ?? ""}`).split(/[^a-z0-9]+/);
  return fold(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((q) => words.some((w) => w.startsWith(q)));
}
