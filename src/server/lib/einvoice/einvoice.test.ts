import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PDFDocument } from "@pdfme/pdf-lib";
import { EINVOICE_FORMATS } from "../../../shared/einvoice";
import { extractEmbeddedInvoiceXml, find, findAll, parseEInvoiceXml, parseXml, pdfEmbeddedFiles } from "../ocr/einvoice";
import { AT_BUND, AT_CREDIT_NOTE, CH_THIRD_COUNTRY, DE_CREDIT_NOTE, DE_REVERSE_CHARGE, SAMPLES, SMALL_BUSINESS } from "./fixtures/inputs";
import { buildEInvoiceXml, eInvoiceFileName, eInvoiceProblems, embedFacturX } from "./index";
import { unitCode } from "./units";

const FIXTURES = join(import.meta.dir, "fixtures");
const UPDATE = process.env.UPDATE_EINVOICE_FIXTURES === "1";
/**
 * Optional schema validation with xmllint. Point it at a directory with
 *   ebinterface-6p1/Invoice.xsd   (github.com/austriapro/ebinterface-standards, schemas/ebInterface6p1)
 *   ubl-2.1/maindoc/…, cii-16b/…  (resources/ubl/2.1/xsd and resources/cii/16b/xsd of the KoSIT
 *                                  XRechnung validator configuration, github.com/itplr-kosit)
 */
const XSD_DIR = process.env.NESEV_EINVOICE_XSD_DIR;

const text = (xml: string, ...path: string[]) => find(parseXml(xml), ...path)?.text.trim();

describe("golden files", () => {
  for (const [name, input] of Object.entries(SAMPLES)) {
    for (const format of EINVOICE_FORMATS) {
      test(`${name} ${format}`, async () => {
        const xml = buildEInvoiceXml(input, format);
        const file = Bun.file(join(FIXTURES, `${name}.${format}.xml`));
        if (UPDATE) await Bun.write(file, xml);
        expect(xml).toBe(await file.text());
      });
    }
  }
});

describe("round trip through the receipt e-invoice parser", () => {
  test("XRechnung UBL: seller, totals, tax groups, due date", () => {
    const r = parseEInvoiceXml(buildEInvoiceXml(AT_BUND, "xrechnung"))!;
    expect(r.format).toBe("ubl");
    expect(r.fields.supplierName?.value).toBe("Muster Design e.U.");
    expect(r.fields.supplierUid?.value).toBe("ATU12345678");
    expect(r.fields.supplierInvoiceNumber?.value).toBe("RE-2026-0001");
    expect(r.fields.issueDate?.value).toBe("2026-03-31");
    expect(r.fields.dueDate?.value).toBe("2026-04-14");
    expect(r.fields.iban?.value).toBe("AT611904300234573201");
    expect(r.fields.grossCents?.value).toBe(AT_BUND.grossCents);
    expect(r.fields.taxLines?.value).toEqual([
      { taxRateBp: 2000, netCents: 287250, taxCents: 57450, grossCents: 344700 },
      { taxRateBp: 1000, netCents: 7980, taxCents: 798, grossCents: 8778 },
    ]);
    expect(r.fields.vatTreatment?.value).toBe("domestic");
  });

  test("ZUGFeRD CII: same figures", () => {
    const r = parseEInvoiceXml(buildEInvoiceXml(AT_BUND, "zugferd"))!;
    expect(r.format).toBe("cii");
    expect(r.fields.supplierUid?.value).toBe("ATU12345678");
    expect(r.fields.dueDate?.value).toBe("2026-04-14");
    expect(r.fields.grossCents?.value).toBe(AT_BUND.grossCents);
    expect(r.fields.taxLines?.value.map((l) => l.taxCents)).toEqual([57450, 798]);
  });

  test("reverse charge: AE with 0 % and exemption reason", () => {
    for (const format of ["xrechnung", "zugferd"] as const) {
      const xml = buildEInvoiceXml(DE_REVERSE_CHARGE, format);
      const r = parseEInvoiceXml(xml)!;
      expect(r.fields.vatTreatment?.value).toBe("reverse_charge");
      expect(r.fields.taxLines?.value).toEqual([{ taxRateBp: 0, netCents: DE_REVERSE_CHARGE.netCents, taxCents: 0, grossCents: DE_REVERSE_CHARGE.netCents }]);
      expect(xml).toContain("VATEX-EU-AE");
      expect(xml).toContain("Steuerschuldnerschaft des Leistungsempfängers");
    }
    expect(text(buildEInvoiceXml(DE_REVERSE_CHARGE, "xrechnung"), "BuyerReference")).toBe("04011000-1234512345-06");
    expect(buildEInvoiceXml(DE_REVERSE_CHARGE, "ebinterface")).toContain('TaxCategoryCode="AE"');
  });

  test("small business: E, Steuernummer instead of UID", () => {
    const ubl = buildEInvoiceXml(SMALL_BUSINESS, "xrechnung");
    const tax = findAll(parseXml(ubl), "TaxSubtotal")[0]!;
    expect(find(tax, "TaxCategory", "ID")?.text).toBe("E");
    expect(find(tax, "TaxExemptionReason")?.text).toContain("Kleinunternehmer");
    expect(ubl).toContain("<cbc:ID>FC</cbc:ID>");
    expect(ubl).not.toContain("ATU12345678");
    expect(parseEInvoiceXml(ubl)!.fields.vatTreatment?.value).toBe("none");
    const cii = buildEInvoiceXml(SMALL_BUSINESS, "zugferd");
    expect(cii).toContain('<ram:ID schemeID="FC">12 345/6789</ram:ID>');
    expect(text(buildEInvoiceXml(SMALL_BUSINESS, "ebinterface"), "Biller", "VATIdentificationNumber")).toBe("00000000");
  });

  test("third country: G (export) with the third-country note", () => {
    const cii = buildEInvoiceXml(CH_THIRD_COUNTRY, "zugferd");
    expect(text(cii, "ApplicableHeaderTradeSettlement", "ApplicableTradeTax", "CategoryCode")).toBe("G");
    expect(text(cii, "ApplicableHeaderTradeSettlement", "ApplicableTradeTax", "ExemptionReason")).toBe("Nicht im Inland steuerbare Leistung.");
  });

  test("credit notes reference the invoice and keep positive amounts", () => {
    const ubl = buildEInvoiceXml(DE_CREDIT_NOTE, "xrechnung");
    const r = parseEInvoiceXml(ubl)!;
    expect(r.warnings).toContain("E-Rechnung ist eine Gutschrift");
    expect(r.fields.grossCents?.value).toBe(DE_CREDIT_NOTE.grossCents);
    expect(text(ubl, "CreditNoteTypeCode")).toBe("381");
    expect(text(ubl, "BillingReference", "InvoiceDocumentReference", "ID")).toBe("RE-2026-0002");
    expect(text(ubl, "PaymentMeans", "PaymentDueDate")).toBe("2026-04-24");

    const cii = buildEInvoiceXml(AT_CREDIT_NOTE, "zugferd");
    expect(parseEInvoiceXml(cii)!.warnings[0]).toContain("TypeCode 381");
    expect(text(cii, "InvoiceReferencedDocument", "IssuerAssignedID")).toBe("RE-2026-0001");

    const eb = parseXml(buildEInvoiceXml(AT_CREDIT_NOTE, "ebinterface"));
    expect(eb.children[0]!.attrs.DocumentType).toBe("CreditMemo");
    expect(find(eb, "RelatedDocument", "InvoiceNumber")?.text).toBe("RE-2026-0001");
    expect(find(eb, "PayableAmount")?.text).toBe("87.78");
    expect(find(eb, "PaymentMethod")).toBeUndefined();
  });
});

describe("ebInterface for the Bund", () => {
  const eb = parseXml(buildEInvoiceXml(AT_BUND, "ebinterface"));

  test("order reference, supplier number, bank transfer, due date", () => {
    expect(eb.children[0]!.attrs).toMatchObject({ DocumentType: "Invoice", InvoiceCurrency: "EUR", GeneratingSystem: "nesev" });
    expect(find(eb, "InvoiceRecipient", "OrderReference", "OrderID")?.text).toBe("4500012345");
    expect(find(eb, "Biller", "InvoiceRecipientsBillerID")?.text).toBe("312345");
    expect(find(eb, "InvoiceRecipient", "BillersInvoiceRecipientID")?.text).toBe("K-0007");
    expect(find(eb, "UniversalBankTransaction", "IBAN")?.text).toBe("AT611904300234573201");
    expect(find(eb, "UniversalBankTransaction", "BIC")?.text).toBe("BKAUATWW");
    expect(find(eb, "PaymentConditions", "DueDate")?.text).toBe("2026-04-14");
    expect(find(eb, "Delivery", "Period", "FromDate")?.text).toBe("2026-03-01");
  });

  test("lines: discount as reduction, line amount after discount; totals from calcTotals", () => {
    const items = findAll(eb, "ListLineItem");
    expect(items).toHaveLength(3);
    expect(find(items[0], "Quantity")?.attrs.Unit).toBe("HUR");
    expect(find(items[0], "Quantity")?.text).toBe("7.5");
    expect(find(items[1], "ReductionListLineItem", "Amount")?.text).toBe("240.00");
    expect(find(items[1], "LineItemAmount")?.text).toBe("2160.00");
    expect(find(items[2], "Description")?.text).toBe("Fachbuch „Gutes Webdesign“ & <Zubehör>");
    expect(find(eb, "TotalGrossAmount")?.text).toBe("3534.78");
    const tax = findAll(find(eb, "Tax")!, "TaxItem").map((t) => [find(t, "TaxPercent")?.text, find(t, "TaxAmount")?.text]);
    expect(tax).toEqual([
      ["20.00", "574.50"],
      ["10.00", "7.98"],
    ]);
  });
});

describe("checks before download", () => {
  test("complete Bund invoice has no problems", () => {
    expect(eInvoiceProblems(AT_BUND, "ebinterface")).toEqual([]);
    expect(eInvoiceProblems(DE_REVERSE_CHARGE, "xrechnung")).toEqual([]);
    expect(eInvoiceProblems(SMALL_BUSINESS, "zugferd")).toEqual([]);
  });

  test("missing Leitweg-ID / Auftragsreferenz / seller data", () => {
    expect(eInvoiceProblems(CH_THIRD_COUNTRY, "xrechnung")).toEqual(["Leitweg-ID fehlt – beim Kunden oder im Beleg eintragen"]);
    expect(eInvoiceProblems({ ...AT_BUND, buyerReference: "", supplierId: "" }, "ebinterface")).toEqual([
      "Auftragsreferenz fehlt (beim Bund Pflicht) – beim Kunden oder im Beleg eintragen",
      "Kunde: Lieferantennummer fehlt (beim Bund Pflicht)",
    ]);
    const noSeller = { ...AT_BUND, seller: { ...AT_BUND.seller, uid: "", taxNumber: "", phone: "", iban: "" } };
    expect(eInvoiceProblems(noSeller, "xrechnung")).toEqual([
      "Einstellungen: UID-Nummer oder Steuernummer fehlt",
      "Einstellungen: IBAN fehlt (Zahlungsanweisung)",
      "Einstellungen: Telefonnummer fehlt (XRechnung-Pflicht)",
    ]);
    expect(eInvoiceProblems({ ...DE_REVERSE_CHARGE, client: { ...DE_REVERSE_CHARGE.client, uid: "" } }, "zugferd")).toEqual([
      "Kunde: Reverse Charge erfordert die UID-Nummer des Kunden",
    ]);
  });

  test("totals that disagree with the items are refused", () => {
    expect(() => buildEInvoiceXml({ ...AT_BUND, grossCents: AT_BUND.grossCents + 1 }, "xrechnung")).toThrow("Summen");
  });
});

describe("ZUGFeRD PDF", () => {
  async function samplePdf() {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.setTitle("Rechnung RE-2026-0001");
    doc.setAuthor("Muster Design e.U.");
    return doc.save();
  }

  test("embeds factur-x.xml as Alternative, with XMP and output intent; original untouched", async () => {
    const original = await samplePdf();
    const copy = new Uint8Array(original);
    const xml = buildEInvoiceXml(AT_BUND, "zugferd");
    const out = await embedFacturX(original, xml, { now: new Date("2026-04-01T10:00:00Z") });

    expect(original).toEqual(copy);
    expect(await extractEmbeddedInvoiceXml(out)).toBe(xml);
    expect((await pdfEmbeddedFiles(out)).map((f) => f.name)).toContain("factur-x.xml");

    const raw = new TextDecoder("latin1").decode(out);
    const markers = ["/AFRelationship /Alternative", "/AF [", "<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>", "<pdfaid:part>3</pdfaid:part>", "/GTS_PDFA1"];
    expect(markers.filter((m) => !raw.includes(m))).toEqual([]);

    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getTitle()).toBe("Rechnung RE-2026-0001");
    expect(reloaded.getPageCount()).toBe(1);
  });
});

test("unit codes and file names", () => {
  expect(["Std.", "Stk.", "Tag", "Woche", "Monat", "Jahr", "Pauschal", "km", "", "Lizenz"].map(unitCode)).toEqual([
    "HUR", "H87", "DAY", "WEE", "MON", "ANN", "LS", "KMT", "C62", "C62",
  ]);
  expect(eInvoiceFileName("RE-2026-0001", "zugferd")).toBe("RE-2026-0001_zugferd.pdf");
  expect(eInvoiceFileName("RE-2026-0001", "xrechnung")).toBe("RE-2026-0001_xrechnung.xml");
});

describe.if(!!XSD_DIR)("official XSDs (NESEV_EINVOICE_XSD_DIR)", () => {
  const schemas = {
    ebinterface: () => "ebinterface-6p1/Invoice.xsd",
    xrechnung: (xml: string) => (xml.includes("<CreditNote") ? "ubl-2.1/maindoc/UBL-CreditNote-2.1.xsd" : "ubl-2.1/maindoc/UBL-Invoice-2.1.xsd"),
    zugferd: () => "cii-16b/CrossIndustryInvoice_100pD16B.xsd",
  };
  for (const [name, input] of Object.entries(SAMPLES)) {
    for (const format of EINVOICE_FORMATS) {
      test(`${name} ${format}`, async () => {
        const xml = buildEInvoiceXml(input, format);
        const proc = Bun.spawn(["xmllint", "--noout", "--schema", join(XSD_DIR!, schemas[format](xml)), "-"], {
          stdin: new TextEncoder().encode(xml),
          stderr: "pipe",
        });
        const err = await new Response(proc.stderr).text();
        expect(await proc.exited, err).toBe(0);
      });
    }
  }
});
