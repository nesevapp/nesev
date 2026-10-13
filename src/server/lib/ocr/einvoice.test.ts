import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "@pdfme/pdf-lib";
import { extractEmbeddedInvoiceXml, parseEInvoiceXml, parseXml } from "./einvoice";

const fixture = (name: string) => Bun.file(join(import.meta.dir, "fixtures", name)).text();

async function pdfWith(attachment?: { name: string; xml: string }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText("Rechnung", { x: 50, y: 800, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  if (attachment) await doc.attach(new TextEncoder().encode(attachment.xml), attachment.name, { mimeType: "text/xml" });
  return doc.save();
}

describe("e-invoice XML", () => {
  test("ZUGFeRD / Factur-X (CII)", async () => {
    const r = parseEInvoiceXml(await fixture("factur-x.xml"))!;
    expect(r.format).toBe("cii");
    const f = r.fields;
    expect(f.supplierName?.value).toBe("Steuerberatung Huber & Partner OG");
    expect(f.supplierUid?.value).toBe("ATU00000000");
    expect(f.supplierCountry?.value).toBe("AT");
    expect(f.supplierInvoiceNumber?.value).toBe("2026-118");
    expect(f.issueDate?.value).toBe("2026-09-21");
    expect(f.dueDate?.value).toBe("2026-10-05");
    expect(f.grossCents?.value).toBe(54000);
    expect(f.iban?.value).toBe("AT611904300234573201");
    expect(f.taxLines?.value).toEqual([{ taxRateBp: 2000, netCents: 45000, taxCents: 9000, grossCents: 54000 }]);
    expect(f.vatTreatment?.value).toBe("domestic");
    expect(f.supplierName?.source).toBe("xml");
  });

  test("XRechnung UBL with reverse charge (AE)", async () => {
    const f = parseEInvoiceXml(await fixture("xrechnung-ubl.xml"))!.fields;
    expect(f.supplierName?.value).toBe("Muster Hosting GmbH");
    expect(f.supplierUid?.value).toBe("DE000000000");
    expect(f.supplierCountry?.value).toBe("DE");
    expect(f.supplierInvoiceNumber?.value).toBe("DE-4711");
    expect(f.issueDate?.value).toBe("2026-08-14");
    expect(f.dueDate?.value).toBe("2026-08-28");
    expect(f.grossCents?.value).toBe(12000);
    expect(f.iban?.value).toBe("DE89370400440532013000");
    expect(f.taxLines?.value).toEqual([{ taxRateBp: 0, netCents: 12000, taxCents: 0, grossCents: 12000 }]);
    expect(f.vatTreatment?.value).toBe("reverse_charge");
    expect(f.description?.value).toBe("Managed Server & Backup");
  });

  test("other XML is ignored", () => {
    expect(parseEInvoiceXml("<Document><Foo/></Document>")).toBeNull();
    expect(parseXml("<a x='1'><b>t&amp;u</b><![CDATA[<raw>]]></a>").children[0]!.children[0]!.text).toBe("t&u");
  });

  test("finds the XML embedded in a PDF/A-3", async () => {
    const xml = await fixture("factur-x.xml");
    expect(await extractEmbeddedInvoiceXml(await pdfWith({ name: "factur-x.xml", xml }))).toBe(xml);
    // any name works when the content is CII
    expect(await extractEmbeddedInvoiceXml(await pdfWith({ name: "rechnung.xml", xml }))).toBe(xml);
    expect(await extractEmbeddedInvoiceXml(await pdfWith())).toBeNull();
    expect(await extractEmbeddedInvoiceXml(new TextEncoder().encode("not a pdf"))).toBeNull();
  });
});
