import { describe, expect, test } from "bun:test";
import { unzipSync } from "fflate";
import type { DocumentItemInput } from "../../shared/schemas/document";
import { createTestDb, type Db } from "../db/client";
import { clients } from "../db/schema";
import { createCreditNote, createDocument, finalizeDocument, updateDocument } from "./documents";
import { clientsCsv, csvAmount, documentsCsv, documentsZip, exportSummary, rangeLabel, toCsv } from "./export";

const item = (over: Partial<DocumentItemInput> = {}): DocumentItemInput => ({
  title: "Beratung",
  description: "",
  quantity: 1000,
  unit: "h",
  unitPriceCents: 10000,
  taxRateBp: 2000,
  discountBp: 0,
  ...over,
});

function setup() {
  const db = createTestDb();
  const client = db
    .insert(clients)
    .values({ number: 7, name: 'Muster; "Test" GmbH', country: "AT", uid: "ATU12345678" })
    .returning()
    .get();
  return { db, client };
}

function invoice(db: Db, clientId: number, issueDate: string, items: DocumentItemInput[]) {
  const doc = createDocument(db, {
    type: "invoice",
    clientId,
    issueDate,
    servicePeriodStart: "2026-07-01",
    servicePeriodEnd: "2026-07-31",
    items,
  });
  return finalizeDocument(db, doc.id);
}

/** Strip BOM, split CRLF lines, split ";" (test data avoids quoted separators except the client name). */
function parse(csv: string) {
  return csv
    .slice(1)
    .trimEnd()
    .split("\r\n")
    .map((l) => l.replace('"Muster; ""Test"" GmbH"', "CLIENT").split(";"));
}

const Q3 = { from: "2026-07-01", to: "2026-09-30" };

describe("formatting", () => {
  test("amounts use decimal comma, no grouping", () => {
    expect(csvAmount(123456)).toBe("1234,56");
    expect(csvAmount(-5)).toBe("-0,05");
    expect(csvAmount(0)).toBe("0,00");
    expect(csvAmount(-100000)).toBe("-1000,00");
  });

  test("BOM, ';' separator, CRLF, quoting", () => {
    const csv = toCsv(["a", "b"], [["x;y", 'say "hi"'], ["line\nbreak", "plain"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe('﻿a;b\r\n"x;y";"say ""hi"""\r\n"line\nbreak";plain\r\n');
  });

  test("range labels", () => {
    expect(rangeLabel({ from: "2026-07-01", to: "2026-09-30" })).toBe("2026-Q3");
    expect(rangeLabel({ from: "2026-02-01", to: "2026-02-28" })).toBe("2026-02");
    expect(rangeLabel({ from: "2026-01-01", to: "2026-12-31" })).toBe("2026");
    expect(rangeLabel({ from: "2026-07-01", to: "2026-08-15" })).toBe("2026-07-01_2026-08-15");
  });
});

describe("documents CSV", () => {
  test("header, dates, multi-rate split, drafts and other ranges excluded", () => {
    const { db, client } = setup();
    invoice(db, client.id, "2026-08-03", [
      item({ quantity: 2000, unitPriceCents: 10000, taxRateBp: 2000 }), // 200,00 @ 20 %
      item({ unitPriceCents: 5050, taxRateBp: 1000 }), // 50,50 @ 10 %
    ]);
    createDocument(db, { type: "invoice", clientId: client.id, issueDate: "2026-08-04", items: [item()] }); // draft
    invoice(db, client.id, "2026-10-01", [item()]); // outside Q3
    createDocument(db, { type: "offer", clientId: client.id, issueDate: "2026-08-05", items: [item()] });

    const rows = parse(documentsCsv(db, Q3));
    expect(rows[0]!.join(";")).toBe(
      "Belegnr;Typ;Datum;Leistungszeitraum;Kunde;Kundennr;Land;UID Kunde;Steuermodus;Netto;USt-Satz;USt;Brutto;Fällig;Bezahlt am;Bezugsbeleg",
    );
    expect(rows).toHaveLength(3);
    const [a, b] = [rows[1]!, rows[2]!];
    expect(a.slice(0, 9)).toEqual([
      "RE-2026-0001",
      "Rechnung",
      "03.08.2026",
      "01.07.2026 – 31.07.2026",
      "CLIENT",
      "K-0007",
      "AT",
      "ATU12345678",
      "Inland (AT)",
    ]);
    expect(a.slice(9, 13)).toEqual(["200,00", "20", "40,00", "240,00"]);
    expect(b[0]).toBe("RE-2026-0001");
    expect(b.slice(9, 13)).toEqual(["50,50", "10", "5,05", "55,55"]);
    expect(a[13]).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  test("credit notes are negative and reference their invoice", () => {
    const { db, client } = setup();
    const inv = invoice(db, client.id, "2026-07-10", [item({ unitPriceCents: 12345 })]);
    const draft = createCreditNote(db, inv.id);
    updateDocument(db, draft.id, { issueDate: "2026-07-20" });
    finalizeDocument(db, draft.id);

    const rows = parse(documentsCsv(db, Q3)).slice(1);
    expect(rows).toHaveLength(2);
    const gs = rows[1]!;
    expect(gs[0]).toBe("GS-2026-0001");
    expect(gs[1]).toBe("Gutschrift");
    expect(gs.slice(9, 13)).toEqual(["-123,45", "20", "-24,69", "-148,14"]);
    expect(gs[15]).toBe("RE-2026-0001");

    return exportSummary(db, Q3).then((s) => {
      expect(s).toMatchObject({ invoices: 1, creditNotes: 1, netCents: 0, grossCents: 0, label: "2026-Q3" });
    });
  });

  test("zip contains the CSV and one PDF per document", async () => {
    const { db, client } = setup();
    invoice(db, client.id, "2026-07-10", [item()]);
    const zip = await documentsZip(db, Q3, async () => new TextEncoder().encode("%PDF-fake"));
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(["belege-2026-Q3.csv", "pdfs/RE-2026-0001.pdf"]);
    expect(new TextDecoder().decode(files["pdfs/RE-2026-0001.pdf"])).toBe("%PDF-fake");
  });
});

test("clients CSV", () => {
  const { db } = setup();
  const rows = parse(clientsCsv(db));
  expect(rows[0]![0]).toBe("Kundennr");
  expect(rows[1]!.slice(0, 3)).toEqual(["K-0007", "Firma", "CLIENT"]);
});
