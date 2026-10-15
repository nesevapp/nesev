import { calcTotals } from "../../../../shared/totals";
import { DEFAULT_TAX_NOTES, type TaxMode } from "../../../../shared/tax";
import type { ClientSnapshot, SellerSnapshot } from "../../../../shared/types";
import type { EInvoiceInput, EInvoiceItem } from "../model";

// Sample documents for the e-invoice tests (and for regenerating the golden files in this folder:
// `UPDATE_EINVOICE_FIXTURES=1 bun test src/server/lib/einvoice`).

export const SELLER: SellerSnapshot = {
  companyName: "Muster Design e.U.",
  ownerName: "Maria Muster",
  street: "Mariahilfer Straße 1/5",
  zip: "1060",
  city: "Wien",
  country: "AT",
  uid: "ATU12345678",
  taxNumber: "12 345/6789",
  companyRegister: "FN 123456a",
  email: "office@muster-design.at",
  phone: "+43 1 234 56 78",
  website: "www.muster-design.at",
  iban: "AT61 1904 3002 3457 3201",
  bic: "BKAUATWW",
  bankName: "Bank Austria",
  logoPath: null,
};

const client = (over: Partial<ClientSnapshot>): ClientSnapshot => ({
  clientId: 1,
  number: 7,
  type: "company",
  name: "Bundesministerium für Testwesen",
  contactPerson: "Max Mustermann",
  street: "Herrengasse 12",
  addressExtra: "",
  zip: "1010",
  city: "Wien",
  country: "AT",
  uid: "",
  email: "einkauf@bmtw.gv.at",
  ...over,
});

const ITEMS: EInvoiceItem[] = [
  { title: "Konzeption & Workshop", description: "Anforderungsanalyse\nund Wireframes", quantity: 7500, unit: "Std.", unitPriceCents: 9500, taxRateBp: 2000, discountBp: 0 },
  { title: "Umsetzung", description: "", quantity: 1000, unit: "Pauschal", unitPriceCents: 240000, taxRateBp: 2000, discountBp: 1000 },
  { title: "Fachbuch „Gutes Webdesign“ & <Zubehör>", description: "", quantity: 2000, unit: "Stk.", unitPriceCents: 3990, taxRateBp: 1000, discountBp: 0 },
];

function make(over: Partial<EInvoiceInput> & { taxMode: TaxMode }): EInvoiceInput {
  const items = over.items ?? ITEMS;
  const t = calcTotals(items, over.taxMode);
  const taxNote =
    over.taxMode === "EU_REVERSE_CHARGE"
      ? DEFAULT_TAX_NOTES.taxNoteReverseCharge
      : over.taxMode === "THIRD_COUNTRY"
        ? DEFAULT_TAX_NOTES.taxNoteThirdCountry
        : over.taxMode === "SMALL_BUSINESS"
          ? DEFAULT_TAX_NOTES.taxNoteSmallBusiness
          : null;
  return {
    type: "invoice",
    number: "RE-2026-0001",
    issueDate: "2026-03-31",
    dueDate: "2026-04-14",
    servicePeriodStart: "2026-03-01",
    servicePeriodEnd: "2026-03-31",
    title: "Website-Relaunch",
    introText: "Vielen Dank für Ihren Auftrag.",
    closingText: "Wir freuen uns auf die weitere Zusammenarbeit.",
    seller: SELLER,
    client: client({}),
    buyerReference: "",
    supplierId: "",
    taxNote,
    precedingInvoice: null,
    ...over,
    items,
    netCents: t.netCents,
    taxCents: t.taxCents,
    grossCents: t.grossCents,
  };
}

/** AT domestic to the Bund: two VAT rates, a discounted line, Auftragsreferenz + Lieferantennummer. */
export const AT_BUND = make({ taxMode: "AT_DOMESTIC", buyerReference: "4500012345", supplierId: "312345" });

/** DE public buyer, reverse charge, Leitweg-ID. */
export const DE_REVERSE_CHARGE = make({
  taxMode: "EU_REVERSE_CHARGE",
  number: "RE-2026-0002",
  buyerReference: "04011000-1234512345-06",
  servicePeriodStart: null,
  servicePeriodEnd: null,
  client: client({
    number: 12,
    name: "Stadt Musterhausen",
    street: "Rathausplatz 1",
    zip: "80331",
    city: "München",
    country: "DE",
    uid: "DE123456789",
    email: "rechnung@musterhausen.de",
  }),
});

/** Kleinunternehmer (no UID, only Steuernummer), AT private buyer. */
export const SMALL_BUSINESS = make({
  taxMode: "SMALL_BUSINESS",
  number: "RE-2026-0003",
  seller: { ...SELLER, uid: "" },
  buyerReference: "PO-77",
  client: client({ number: 3, name: "Alpen Handel GmbH", email: "office@alpen.at", uid: "ATU87654321" }),
});

/** Third country (CH). */
export const CH_THIRD_COUNTRY = make({
  taxMode: "THIRD_COUNTRY",
  number: "RE-2026-0004",
  client: client({ number: 4, name: "Zürich Software AG", street: "Bahnhofstrasse 1", zip: "8001", city: "Zürich", country: "CH", uid: "CHE-123.456.789 MWST", email: "ap@zuerich-software.ch" }),
});

/** Credit note for part of AT_BUND. */
export const AT_CREDIT_NOTE = make({
  taxMode: "AT_DOMESTIC",
  type: "credit_note",
  number: "GS-2026-0001",
  issueDate: "2026-04-10",
  dueDate: null,
  title: "Gutschrift zu Rechnung RE-2026-0001",
  buyerReference: "4500012345",
  supplierId: "312345",
  items: [ITEMS[2]!],
  precedingInvoice: { number: "RE-2026-0001", issueDate: "2026-03-31" },
});

/** Credit note to the German public buyer (XRechnung CreditNote). */
export const DE_CREDIT_NOTE = make({
  ...DE_REVERSE_CHARGE,
  type: "credit_note",
  number: "GS-2026-0002",
  issueDate: "2026-04-10",
  dueDate: "2026-04-24",
  items: [ITEMS[0]!],
  precedingInvoice: { number: "RE-2026-0002", issueDate: "2026-03-31" },
});

export const SAMPLES = { AT_BUND, DE_REVERSE_CHARGE, SMALL_BUSINESS, CH_THIRD_COUNTRY, AT_CREDIT_NOTE, DE_CREDIT_NOTE };
