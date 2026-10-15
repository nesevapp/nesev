import { bpToPercentDecimal, centsToDecimal, quantityToDecimal } from "../../../shared/money";
import type { ClientSnapshot, SellerSnapshot } from "../../../shared/types";
import {
  CURRENCY,
  type EInvoiceInput,
  isLeitwegId,
  paymentTermsText,
  sellerName,
  totalsOf,
  type VatCategory,
  vatCategory,
} from "./model";
import { unitCode } from "./units";
import { h, leaf, toXml } from "./xml";

// XRechnung 3.0 (CIUS of EN 16931 for German public buyers) in UBL 2.1 syntax. Invoices are
// <Invoice> (type code 380), credit notes <CreditNote> (381) with positive amounts and a
// BillingReference to the corrected invoice. BuyerReference (BT-10) carries the Leitweg-ID.

export const XRECHNUNG_CUSTOMIZATION_ID = "urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0";
const PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";

const NS = {
  invoice: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  creditNote: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
};

const amount = (name: string, cents: number) => leaf(name, centsToDecimal(cents), { currencyID: CURRENCY });
const compact = (s: string) => s.replace(/\s+/g, "");

function address(street: string, extra: string, city: string, zip: string, country: string) {
  return h(
    "cac:PostalAddress",
    null,
    leaf("cbc:StreetName", street.trim()),
    leaf("cbc:AdditionalStreetName", extra.trim()),
    leaf("cbc:CityName", city.trim()),
    leaf("cbc:PostalZone", zip.trim()),
    h("cac:Country", null, leaf("cbc:IdentificationCode", country)),
  );
}

function taxCategory(tag: "cac:TaxCategory" | "cac:ClassifiedTaxCategory", cat: VatCategory, rateBp: number, withReason: boolean) {
  return h(
    tag,
    null,
    leaf("cbc:ID", cat.code),
    leaf("cbc:Percent", bpToPercentDecimal(rateBp)),
    withReason && leaf("cbc:TaxExemptionReasonCode", cat.reasonCode),
    withReason && leaf("cbc:TaxExemptionReason", cat.reason),
    h("cac:TaxScheme", null, leaf("cbc:ID", "VAT")),
  );
}

function sellerParty(s: SellerSnapshot) {
  const name = sellerName(s);
  return h(
    "cac:AccountingSupplierParty",
    null,
    h(
      "cac:Party",
      null,
      leaf("cbc:EndpointID", s.email.trim(), { schemeID: "EM" }),
      h("cac:PartyName", null, leaf("cbc:Name", name)),
      address(s.street, "", s.city, s.zip, s.country),
      s.uid.trim() && h("cac:PartyTaxScheme", null, leaf("cbc:CompanyID", compact(s.uid)), h("cac:TaxScheme", null, leaf("cbc:ID", "VAT"))),
      s.taxNumber.trim() &&
        h("cac:PartyTaxScheme", null, leaf("cbc:CompanyID", s.taxNumber.trim()), h("cac:TaxScheme", null, leaf("cbc:ID", "FC"))),
      h("cac:PartyLegalEntity", null, leaf("cbc:RegistrationName", name), leaf("cbc:CompanyID", s.companyRegister.trim())),
      h(
        "cac:Contact",
        null,
        leaf("cbc:Name", s.ownerName.trim() || name),
        leaf("cbc:Telephone", s.phone.trim()),
        leaf("cbc:ElectronicMail", s.email.trim()),
      ),
    ),
  );
}

function buyerParty(c: ClientSnapshot, buyerReference: string) {
  // electronic address (BT-49): the Leitweg-ID (scheme 0204) when it is one, otherwise the e-mail
  const endpoint = isLeitwegId(buyerReference)
    ? leaf("cbc:EndpointID", buyerReference.trim(), { schemeID: "0204" })
    : leaf("cbc:EndpointID", c.email.trim(), { schemeID: "EM" });
  return h(
    "cac:AccountingCustomerParty",
    null,
    h(
      "cac:Party",
      null,
      endpoint,
      h("cac:PartyIdentification", null, leaf("cbc:ID", String(c.number))),
      h("cac:PartyName", null, leaf("cbc:Name", c.name)),
      address(c.street, c.addressExtra, c.city, c.zip, c.country),
      c.uid.trim() && h("cac:PartyTaxScheme", null, leaf("cbc:CompanyID", compact(c.uid)), h("cac:TaxScheme", null, leaf("cbc:ID", "VAT"))),
      h("cac:PartyLegalEntity", null, leaf("cbc:RegistrationName", c.name)),
      (c.contactPerson.trim() || c.email.trim()) &&
        h("cac:Contact", null, leaf("cbc:Name", c.contactPerson.trim()), leaf("cbc:ElectronicMail", c.email.trim())),
    ),
  );
}

export function buildXRechnung(input: EInvoiceInput): string {
  const totals = totalsOf(input);
  const s = input.seller;
  const isCredit = input.type === "credit_note";
  const category = (rateBp: number) => vatCategory(input.taxMode, rateBp, input.taxNote);
  const lineTag = isCredit ? "cac:CreditNoteLine" : "cac:InvoiceLine";
  const qtyTag = isCredit ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity";

  const lines = input.items.map((item, i) => {
    const line = totals.lines[i]!;
    return h(
      lineTag,
      null,
      leaf("cbc:ID", i + 1),
      leaf(qtyTag, quantityToDecimal(item.quantity), { unitCode: unitCode(item.unit) }),
      amount("cbc:LineExtensionAmount", line.netCents),
      item.discountBp > 0 &&
        h(
          "cac:AllowanceCharge",
          null,
          leaf("cbc:ChargeIndicator", "false"),
          leaf("cbc:AllowanceChargeReasonCode", "95"),
          leaf("cbc:AllowanceChargeReason", "Rabatt"),
          leaf("cbc:MultiplierFactorNumeric", bpToPercentDecimal(item.discountBp)),
          amount("cbc:Amount", line.discountCents),
          amount("cbc:BaseAmount", line.grossLineCents),
        ),
      h(
        "cac:Item",
        null,
        leaf("cbc:Description", item.description.trim()),
        leaf("cbc:Name", item.title),
        taxCategory("cac:ClassifiedTaxCategory", category(line.taxRateBp), line.taxRateBp, false),
      ),
      h("cac:Price", null, amount("cbc:PriceAmount", item.unitPriceCents)),
    );
  });

  const notes = [input.title.trim(), input.taxNote?.trim()].filter(Boolean).map((n) => leaf("cbc:Note", n!));
  const terms = paymentTermsText(input);

  const root = h(
    isCredit ? "CreditNote" : "Invoice",
    { xmlns: isCredit ? NS.creditNote : NS.invoice, "xmlns:cac": NS.cac, "xmlns:cbc": NS.cbc },
    leaf("cbc:CustomizationID", XRECHNUNG_CUSTOMIZATION_ID),
    leaf("cbc:ProfileID", PROFILE_ID),
    leaf("cbc:ID", input.number),
    leaf("cbc:IssueDate", input.issueDate),
    !isCredit && leaf("cbc:DueDate", input.dueDate),
    leaf(isCredit ? "cbc:CreditNoteTypeCode" : "cbc:InvoiceTypeCode", isCredit ? "381" : "380"),
    notes,
    leaf("cbc:DocumentCurrencyCode", CURRENCY),
    leaf("cbc:BuyerReference", input.buyerReference.trim()),
    input.servicePeriodStart &&
      input.servicePeriodEnd &&
      h("cac:InvoicePeriod", null, leaf("cbc:StartDate", input.servicePeriodStart), leaf("cbc:EndDate", input.servicePeriodEnd)),
    input.precedingInvoice &&
      h(
        "cac:BillingReference",
        null,
        h(
          "cac:InvoiceDocumentReference",
          null,
          leaf("cbc:ID", input.precedingInvoice.number),
          leaf("cbc:IssueDate", input.precedingInvoice.issueDate),
        ),
      ),
    sellerParty(s),
    buyerParty(input.client, input.buyerReference),
    // delivery date (BT-72) when there is no service period: the invoice date
    !(input.servicePeriodStart && input.servicePeriodEnd) &&
      h("cac:Delivery", null, leaf("cbc:ActualDeliveryDate", input.servicePeriodStart ?? input.issueDate)),
    h(
      "cac:PaymentMeans",
      null,
      leaf("cbc:PaymentMeansCode", s.iban.trim() ? "58" : "1"),
      isCredit && leaf("cbc:PaymentDueDate", input.dueDate),
      leaf("cbc:PaymentID", input.number),
      s.iban.trim() &&
        h(
          "cac:PayeeFinancialAccount",
          null,
          leaf("cbc:ID", compact(s.iban)),
          leaf("cbc:Name", sellerName(s)),
          s.bic.trim() && h("cac:FinancialInstitutionBranch", null, leaf("cbc:ID", compact(s.bic))),
        ),
    ),
    terms && h("cac:PaymentTerms", null, leaf("cbc:Note", terms)),
    h(
      "cac:TaxTotal",
      null,
      amount("cbc:TaxAmount", totals.taxCents),
      totals.taxGroups.map((g) =>
        h(
          "cac:TaxSubtotal",
          null,
          amount("cbc:TaxableAmount", g.netCents),
          amount("cbc:TaxAmount", g.taxCents),
          taxCategory("cac:TaxCategory", category(g.rateBp), g.rateBp, true),
        ),
      ),
    ),
    h(
      "cac:LegalMonetaryTotal",
      null,
      amount("cbc:LineExtensionAmount", totals.netCents),
      amount("cbc:TaxExclusiveAmount", totals.netCents),
      amount("cbc:TaxInclusiveAmount", totals.grossCents),
      amount("cbc:PayableAmount", totals.grossCents),
    ),
    lines,
  );
  return toXml(root);
}
