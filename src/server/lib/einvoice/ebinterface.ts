import { countryName } from "../../../shared/countries";
import { bpToPercentDecimal, centsToDecimal, quantityToDecimal } from "../../../shared/money";
import { formatClientNumber } from "../../../shared/schemas/client";
import { CURRENCY, type EInvoiceInput, GENERATOR, paymentTermsText, sellerName, totalsOf, vatCategory } from "./model";
import { unitCode } from "./units";
import { h, leaf, toXml } from "./xml";

// ebInterface 6.1 (Austrian e-invoice standard, schema https://www.ebinterface.at/schema/6p1/), as
// accepted by e-Rechnung.gv.at / USP for invoices to the Bund. For the Bund, the Auftragsreferenz goes
// into InvoiceRecipient/OrderReference/OrderID and our Lieferantennummer into
// Biller/InvoiceRecipientsBillerID. Credit notes are DocumentType="CreditMemo" with positive amounts and
// a RelatedDocument pointing at the corrected invoice.

export const EBINTERFACE_NS = "http://www.ebinterface.at/schema/6p1/";

/** ebInterface uses "00000000" when a party has no VAT ID. */
const vatId = (uid: string) => uid.replace(/\s+/g, "") || "00000000";

function country(code: string) {
  return h("Country", { CountryCode: code }, countryName(code) || code);
}

export function buildEbInterface(input: EInvoiceInput): string {
  const totals = totalsOf(input);
  const s = input.seller;
  const c = input.client;
  const category = (rateBp: number) => vatCategory(input.taxMode, rateBp, input.taxNote);

  const lines = input.items.map((item, i) => {
    const line = totals.lines[i]!;
    const cat = category(line.taxRateBp);
    return h(
      "ListLineItem",
      null,
      leaf("PositionNumber", i + 1),
      leaf("Description", item.title),
      leaf("Description", item.description.trim()),
      leaf("Quantity", quantityToDecimal(item.quantity), { Unit: unitCode(item.unit) }),
      leaf("UnitPrice", centsToDecimal(item.unitPriceCents)),
      item.discountBp > 0 &&
        h(
          "ReductionAndSurchargeListLineItemDetails",
          null,
          h(
            "ReductionListLineItem",
            null,
            leaf("BaseAmount", centsToDecimal(line.grossLineCents)),
            leaf("Percentage", bpToPercentDecimal(item.discountBp)),
            leaf("Amount", centsToDecimal(line.discountCents)),
            leaf("Comment", "Rabatt"),
          ),
        ),
      h(
        "TaxItem",
        null,
        leaf("TaxableAmount", centsToDecimal(line.netCents)),
        leaf("TaxPercent", bpToPercentDecimal(line.taxRateBp), { TaxCategoryCode: cat.code }),
      ),
      leaf("LineItemAmount", centsToDecimal(line.netCents)),
    );
  });

  const taxItems = totals.taxGroups.map((g) => {
    const cat = category(g.rateBp);
    return h(
      "TaxItem",
      null,
      leaf("TaxableAmount", centsToDecimal(g.netCents)),
      leaf("TaxPercent", bpToPercentDecimal(g.rateBp), { TaxCategoryCode: cat.code }),
      leaf("TaxAmount", centsToDecimal(g.taxCents)),
      leaf("Comment", cat.reason),
    );
  });

  const delivery =
    input.servicePeriodStart && input.servicePeriodEnd
      ? h("Period", null, leaf("FromDate", input.servicePeriodStart), leaf("ToDate", input.servicePeriodEnd))
      : leaf("Date", input.servicePeriodStart ?? input.issueDate);

  const isCredit = input.type === "credit_note";
  const root = h(
    "Invoice",
    {
      xmlns: EBINTERFACE_NS,
      GeneratingSystem: GENERATOR,
      DocumentType: isCredit ? "CreditMemo" : "Invoice",
      InvoiceCurrency: CURRENCY,
      DocumentTitle: input.title.trim() || null,
      Language: "de",
    },
    leaf("InvoiceNumber", input.number),
    leaf("InvoiceDate", input.issueDate),
    input.precedingInvoice &&
      h(
        "RelatedDocument",
        null,
        leaf("InvoiceNumber", input.precedingInvoice.number),
        leaf("InvoiceDate", input.precedingInvoice.issueDate),
        leaf("DocumentType", "Invoice"),
      ),
    h("Delivery", null, delivery),
    h(
      "Biller",
      null,
      leaf("VATIdentificationNumber", vatId(s.uid)),
      leaf("FurtherIdentification", s.companyRegister.trim(), { IdentificationType: "FN" }),
      h(
        "Address",
        null,
        leaf("Name", sellerName(s)),
        leaf("Street", s.street),
        leaf("Town", s.city),
        leaf("ZIP", s.zip),
        country(s.country),
        leaf("Phone", s.phone.trim()),
        leaf("Email", s.email.trim()),
      ),
      s.ownerName.trim() &&
        h("Contact", null, leaf("Name", s.ownerName.trim()), leaf("Phone", s.phone.trim()), leaf("Email", s.email.trim())),
      leaf("InvoiceRecipientsBillerID", input.supplierId.trim()),
    ),
    h(
      "InvoiceRecipient",
      null,
      leaf("VATIdentificationNumber", vatId(c.uid)),
      input.buyerReference.trim() && h("OrderReference", null, leaf("OrderID", input.buyerReference.trim())),
      h(
        "Address",
        null,
        leaf("Name", c.name),
        leaf("Street", c.street),
        leaf("Town", c.city),
        leaf("ZIP", c.zip),
        country(c.country),
        leaf("Email", c.email.trim()),
        leaf("AdditionalInformation", c.addressExtra.trim()),
      ),
      c.contactPerson.trim() && h("Contact", null, leaf("Name", c.contactPerson.trim())),
      leaf("BillersInvoiceRecipientID", formatClientNumber(c.number)),
    ),
    h(
      "Details",
      null,
      leaf("HeaderDescription", input.introText.trim()),
      h("ItemList", null, lines),
      leaf("FooterDescription", input.closingText.trim()),
    ),
    h("Tax", null, taxItems),
    leaf("TotalGrossAmount", centsToDecimal(totals.grossCents)),
    leaf("PayableAmount", centsToDecimal(totals.grossCents)),
    !isCredit &&
      h(
        "PaymentMethod",
        null,
        leaf("Comment", "Überweisung"),
        h(
          "UniversalBankTransaction",
          null,
          h(
            "BeneficiaryAccount",
            null,
            leaf("BankName", s.bankName.trim()),
            leaf("BIC", s.bic.replace(/\s+/g, "")),
            leaf("IBAN", s.iban.replace(/\s+/g, "")),
            leaf("BankAccountOwner", sellerName(s).slice(0, 70)),
          ),
          leaf("PaymentReference", input.number.slice(0, 35)),
        ),
      ),
    input.dueDate && h("PaymentConditions", null, leaf("DueDate", input.dueDate), leaf("Comment", paymentTermsText(input))),
    leaf("Comment", input.taxNote),
  );
  return toXml(root);
}
