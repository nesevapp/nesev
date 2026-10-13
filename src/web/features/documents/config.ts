import { countryName } from "@shared/countries";
import type { DocumentType } from "@shared/documents";

/** Per-type routes and wording. Route paths are literal so <Link to> / navigate stay type-checked. */
export const DOC_CONFIG = {
  offer: {
    list: "/offers",
    detail: "/offers/$id",
    create: "/offers/new",
    plural: "Angebote",
    singular: "Angebot",
    newLabel: "Neues Angebot",
    empty: "Noch keine Angebote erstellt.",
  },
  invoice: {
    list: "/invoices",
    detail: "/invoices/$id",
    create: "/invoices/new",
    plural: "Rechnungen",
    singular: "Rechnung",
    newLabel: "Neue Rechnung",
    empty: "Noch keine Rechnungen erstellt.",
  },
  credit_note: {
    list: "/credit-notes",
    detail: "/credit-notes/$id",
    create: "/credit-notes/new",
    plural: "Gutschriften",
    singular: "Gutschrift",
    newLabel: "Neue Gutschrift",
    empty: "Noch keine Gutschriften erstellt. Gutschriften entstehen aus finalisierten Rechnungen.",
  },
} as const satisfies Record<DocumentType, unknown>;

/** Link props for a document's detail page. */
export function docLink(type: DocumentType, id: number) {
  return { to: DOC_CONFIG[type].detail, params: { id } } as const;
}

/** "1010 Wien", "10115 Berlin, Deutschland" (country only for non-AT). */
export function cityLine(a: { zip: string; city: string; country: string }): string {
  const place = [a.zip, a.city].filter(Boolean).join(" ");
  return [place, a.country !== "AT" ? countryName(a.country) : ""].filter(Boolean).join(", ");
}
