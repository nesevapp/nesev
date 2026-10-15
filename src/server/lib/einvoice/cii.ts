import { bpToPercentDecimal, centsToDecimal, quantityToDecimal } from "../../../shared/money";
import type { SellerSnapshot } from "../../../shared/types";
import { CURRENCY, type EInvoiceInput, paymentTermsText, sellerName, totalsOf, vatCategory } from "./model";
import { unitCode } from "./units";
import { h, leaf, toXml } from "./xml";

// ZUGFeRD 2.x / Factur-X 1.0, profile EN 16931 (COMFORT): UN/CEFACT Cross Industry Invoice D16B.
// The XML is embedded into the invoice PDF as factur-x.xml (see facturx-pdf.ts). Credit notes use
// type code 381 with positive amounts and reference the invoice (BT-25).

export const FACTURX_GUIDELINE_ID = "urn:cen.eu:en16931:2017";
export const FACTURX_CONFORMANCE_LEVEL = "EN 16931";

const NS = {
  rsm: "urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100",
  ram: "urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100",
  udt: "urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100",
  qdt: "urn:un:unece:uncefact:data:standard:QualifiedDataType:100",
};

const compact = (s: string) => s.replace(/\s+/g, "");
/** 2026-03-31 → 20260331 (format 102) */
const date102 = (iso: string) => iso.replaceAll("-", "");
const dateTime = (name: string, iso: string) => h(name, null, leaf("udt:DateTimeString", date102(iso), { format: "102" }));
const amount = (name: string, cents: number, currency = false) =>
  leaf(name, centsToDecimal(cents), currency ? { currencyID: CURRENCY } : undefined);

function sellerParty(s: SellerSnapshot) {
  const name = sellerName(s);
  return h(
    "ram:SellerTradeParty",
    null,
    leaf("ram:Name", name),
    s.companyRegister.trim() && h("ram:SpecifiedLegalOrganization", null, leaf("ram:ID", s.companyRegister.trim())),
    h(
      "ram:DefinedTradeContact",
      null,
      leaf("ram:PersonName", s.ownerName.trim() || name),
      s.phone.trim() && h("ram:TelephoneUniversalCommunication", null, leaf("ram:CompleteNumber", s.phone.trim())),
      s.email.trim() && h("ram:EmailURIUniversalCommunication", null, leaf("ram:URIID", s.email.trim())),
    ),
    h(
      "ram:PostalTradeAddress",
      null,
      leaf("ram:PostcodeCode", s.zip.trim()),
      leaf("ram:LineOne", s.street.trim()),
      leaf("ram:CityName", s.city.trim()),
      leaf("ram:CountryID", s.country),
    ),
    s.email.trim() && h("ram:URIUniversalCommunication", null, leaf("ram:URIID", s.email.trim(), { schemeID: "EM" })),
    s.uid.trim() && h("ram:SpecifiedTaxRegistration", null, leaf("ram:ID", compact(s.uid), { schemeID: "VA" })),
    s.taxNumber.trim() && h("ram:SpecifiedTaxRegistration", null, leaf("ram:ID", s.taxNumber.trim(), { schemeID: "FC" })),
  );
}

export function buildFacturX(input: EInvoiceInput): string {
  const totals = totalsOf(input);
  const s = input.seller;
  const c = input.client;
  const isCredit = input.type === "credit_note";
  const category = (rateBp: number) => vatCategory(input.taxMode, rateBp, input.taxNote);

  const lines = input.items.map((item, i) => {
    const line = totals.lines[i]!;
    const cat = category(line.taxRateBp);
    return h(
      "ram:IncludedSupplyChainTradeLineItem",
      null,
      h("ram:AssociatedDocumentLineDocument", null, leaf("ram:LineID", i + 1)),
      h("ram:SpecifiedTradeProduct", null, leaf("ram:Name", item.title), leaf("ram:Description", item.description.trim())),
      h(
        "ram:SpecifiedLineTradeAgreement",
        null,
        h("ram:NetPriceProductTradePrice", null, amount("ram:ChargeAmount", item.unitPriceCents)),
      ),
      h(
        "ram:SpecifiedLineTradeDelivery",
        null,
        leaf("ram:BilledQuantity", quantityToDecimal(item.quantity), { unitCode: unitCode(item.unit) }),
      ),
      h(
        "ram:SpecifiedLineTradeSettlement",
        null,
        h(
          "ram:ApplicableTradeTax",
          null,
          leaf("ram:TypeCode", "VAT"),
          leaf("ram:CategoryCode", cat.code),
          leaf("ram:RateApplicablePercent", bpToPercentDecimal(line.taxRateBp)),
        ),
        item.discountBp > 0 &&
          h(
            "ram:SpecifiedTradeAllowanceCharge",
            null,
            h("ram:ChargeIndicator", null, leaf("udt:Indicator", "false")),
            leaf("ram:CalculationPercent", bpToPercentDecimal(item.discountBp)),
            amount("ram:BasisAmount", line.grossLineCents),
            amount("ram:ActualAmount", line.discountCents),
            leaf("ram:ReasonCode", "95"),
            leaf("ram:Reason", "Rabatt"),
          ),
        h("ram:SpecifiedTradeSettlementLineMonetarySummation", null, amount("ram:LineTotalAmount", line.netCents)),
      ),
    );
  });

  const notes = [input.title.trim(), input.taxNote?.trim()]
    .filter(Boolean)
    .map((n) => h("ram:IncludedNote", null, leaf("ram:Content", n!)));
  const terms = paymentTermsText(input);
  const hasPeriod = !!(input.servicePeriodStart && input.servicePeriodEnd);

  const root = h(
    "rsm:CrossIndustryInvoice",
    { "xmlns:rsm": NS.rsm, "xmlns:ram": NS.ram, "xmlns:udt": NS.udt, "xmlns:qdt": NS.qdt },
    h(
      "rsm:ExchangedDocumentContext",
      null,
      h("ram:GuidelineSpecifiedDocumentContextParameter", null, leaf("ram:ID", FACTURX_GUIDELINE_ID)),
    ),
    h(
      "rsm:ExchangedDocument",
      null,
      leaf("ram:ID", input.number),
      leaf("ram:TypeCode", isCredit ? "381" : "380"),
      dateTime("ram:IssueDateTime", input.issueDate),
      notes,
    ),
    h(
      "rsm:SupplyChainTradeTransaction",
      null,
      lines,
      h(
        "ram:ApplicableHeaderTradeAgreement",
        null,
        leaf("ram:BuyerReference", input.buyerReference.trim()),
        sellerParty(s),
        h(
          "ram:BuyerTradeParty",
          null,
          leaf("ram:ID", String(c.number)),
          leaf("ram:Name", c.name),
          c.contactPerson.trim() && h("ram:DefinedTradeContact", null, leaf("ram:PersonName", c.contactPerson.trim())),
          h(
            "ram:PostalTradeAddress",
            null,
            leaf("ram:PostcodeCode", c.zip.trim()),
            leaf("ram:LineOne", c.street.trim()),
            leaf("ram:LineTwo", c.addressExtra.trim()),
            leaf("ram:CityName", c.city.trim()),
            leaf("ram:CountryID", c.country),
          ),
          c.email.trim() && h("ram:URIUniversalCommunication", null, leaf("ram:URIID", c.email.trim(), { schemeID: "EM" })),
          c.uid.trim() && h("ram:SpecifiedTaxRegistration", null, leaf("ram:ID", compact(c.uid), { schemeID: "VA" })),
        ),
      ),
      h(
        "ram:ApplicableHeaderTradeDelivery",
        null,
        !hasPeriod &&
          h("ram:ActualDeliverySupplyChainEvent", null, dateTime("ram:OccurrenceDateTime", input.servicePeriodStart ?? input.issueDate)),
      ),
      h(
        "ram:ApplicableHeaderTradeSettlement",
        null,
        leaf("ram:PaymentReference", input.number),
        leaf("ram:InvoiceCurrencyCode", CURRENCY),
        h(
          "ram:SpecifiedTradeSettlementPaymentMeans",
          null,
          leaf("ram:TypeCode", s.iban.trim() ? "58" : "1"),
          s.iban.trim() &&
            h("ram:PayeePartyCreditorFinancialAccount", null, leaf("ram:IBANID", compact(s.iban)), leaf("ram:AccountName", sellerName(s))),
          s.iban.trim() && s.bic.trim() && h("ram:PayeeSpecifiedCreditorFinancialInstitution", null, leaf("ram:BICID", compact(s.bic))),
        ),
        totals.taxGroups.map((g) => {
          const cat = category(g.rateBp);
          return h(
            "ram:ApplicableTradeTax",
            null,
            amount("ram:CalculatedAmount", g.taxCents),
            leaf("ram:TypeCode", "VAT"),
            leaf("ram:ExemptionReason", cat.reason),
            amount("ram:BasisAmount", g.netCents),
            leaf("ram:CategoryCode", cat.code),
            leaf("ram:ExemptionReasonCode", cat.reasonCode),
            leaf("ram:RateApplicablePercent", bpToPercentDecimal(g.rateBp)),
          );
        }),
        hasPeriod &&
          h(
            "ram:BillingSpecifiedPeriod",
            null,
            dateTime("ram:StartDateTime", input.servicePeriodStart!),
            dateTime("ram:EndDateTime", input.servicePeriodEnd!),
          ),
        (terms || input.dueDate) &&
          h(
            "ram:SpecifiedTradePaymentTerms",
            null,
            leaf("ram:Description", terms),
            input.dueDate && dateTime("ram:DueDateDateTime", input.dueDate),
          ),
        h(
          "ram:SpecifiedTradeSettlementHeaderMonetarySummation",
          null,
          amount("ram:LineTotalAmount", totals.netCents),
          amount("ram:TaxBasisTotalAmount", totals.netCents),
          amount("ram:TaxTotalAmount", totals.taxCents, true),
          amount("ram:GrandTotalAmount", totals.grossCents),
          amount("ram:DuePayableAmount", totals.grossCents),
        ),
        input.precedingInvoice &&
          h(
            "ram:InvoiceReferencedDocument",
            null,
            leaf("ram:IssuerAssignedID", input.precedingInvoice.number),
            h(
              "ram:FormattedIssueDateTime",
              null,
              leaf("qdt:DateTimeString", date102(input.precedingInvoice.issueDate), { format: "102" }),
            ),
          ),
      ),
    ),
  );
  return toXml(root);
}
