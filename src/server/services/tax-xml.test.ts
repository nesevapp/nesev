import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePeriod } from "../../shared/tax-report";
import { calcTotals } from "../../shared/totals";
import { createTestDb } from "../db/client";
import { clients, documentItems, documents, expenseLines, expenses, type NewDocument } from "../db/schema";
import { updateSettings } from "./settings";
import { computeUva, computeZm } from "./tax";
import { parseSteuernummer, uvaXml, uvaXmlErrors, wholeEuros, xmlAmount, zmXml, zmXmlErrors } from "./tax-xml";

/**
 * The BMF XSDs aren't in the repo (bmf.gv.at content: all rights reserved, reprint only non-commercially). They are
 * downloaded on first use from bmf.gv.at → FinanzOnline → Informationen für Softwarehersteller → Erklärungen und
 * Anträge into a cache dir, or read from NESEV_FINANZONLINE_XSD_DIR. Offline or without xmllint, the schema checks
 * are skipped (the other assertions still run).
 */
const XSD_URLS: Record<string, string> = {
  "U30_07_2026.xsd": "https://www.bmf.gv.at/dam/jcr:2e90eb5d-ef76-48a8-922b-dbf62cc2f230/BMF_ERKLAERUNGS_UEBERMITTLUNG_U30_07_2026.xsd",
  "U30_01_2022.xsd": "https://www.bmf.gv.at/dam/jcr:5deafd50-12d6-4ac3-a9f7-0e234c690db2/BMF_ERKLAERUNGS_UEBERMITTLUNG_U30_01_2022.xsd",
  "U13_ZM_2025.xsd": "https://www.bmf.gv.at/dam/jcr:7ff03520-deca-4ef8-aa60-b8ff206bb581/BMF_XSD_Schema_Zusammenfassende_Meldung.xsd",
};
const XSD_DIR = process.env.NESEV_FINANZONLINE_XSD_DIR ?? join(import.meta.dir, "..", "..", "..", "node_modules", ".cache", "nesev", "finanzonline");
const XSD_READY = Bun.which("xmllint") ? await fetchXsds() : false;

async function fetchXsds(): Promise<boolean> {
  try {
    mkdirSync(XSD_DIR, { recursive: true });
    for (const [name, url] of Object.entries(XSD_URLS)) {
      const file = join(XSD_DIR, name);
      if (existsSync(file)) continue;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!res.ok || !new TextDecoder().decode(bytes.subarray(0, 200)).includes("<xs:schema")) throw new Error(`${url}: HTTP ${res.status}`);
      writeFileSync(file, bytes);
    }
    return true;
  } catch (e) {
    console.warn(`[tax-xml.test] FinanzOnline XSDs not available, skipping schema validation (${e instanceof Error ? e.message : e})`);
    return false;
  }
}
const NOW = new Date(2026, 9, 15, 9, 5, 7);
const TODAY = "2026-10-15";
const FASTNR = { ok: true, fastnr: "123456789" } as const;

function setup() {
  const db = createTestDb();
  updateSettings(db, { taxNumber: "12 345/6789", uid: "ATU12345678" });
  const at = db.insert(clients).values({ number: 1, name: "Wien GmbH", country: "AT" }).returning().get();
  const de = db.insert(clients).values({ number: 2, name: "Berlin GmbH", country: "DE", uid: "DE 123 456 789" }).returning().get();
  const fr = db.insert(clients).values({ number: 3, name: "Paris SAS", country: "FR", uid: "FR12345678901" }).returning().get();
  let seq = 0;
  const doc = (lines: { net: number; rate?: number }[], over: Partial<NewDocument> = {}) => {
    const taxMode = over.taxMode ?? "AT_DOMESTIC";
    const items = lines.map((l, i) => ({ position: i, quantity: 1000, unitPriceCents: l.net, taxRateBp: l.rate ?? 2000 }));
    const t = calcTotals(items, taxMode);
    const row = db
      .insert(documents)
      .values({ type: "invoice", status: "final", number: `RE-${++seq}`, clientId: at.id, issueDate: "2026-09-10", taxMode, netCents: t.netCents, taxCents: t.taxCents, grossCents: t.grossCents, ...over })
      .returning()
      .get();
    db.insert(documentItems).values(items.map((i) => ({ ...i, documentId: row.id }))).run();
    return row;
  };
  const expense = (vatTreatment: string, net: number, rate = 2000) => {
    const row = db.insert(expenses).values({ number: `ER-${++seq}`, supplierName: "Lieferant", issueDate: "2026-09-15", vatTreatment }).returning().get();
    db.insert(expenseLines).values({ expenseId: row.id, position: 0, category: "software_abos", netCents: net, taxRateBp: rate, taxCents: Math.round((net * rate) / 10000) }).run();
  };
  return { db, at, de, fr, doc, expense };
}

/** xmllint --schema; null when xmllint or the XSDs aren't available. */
function validate(xml: string, xsd: string): string | null {
  if (!XSD_READY) return null;
  const dir = mkdtempSync(join(tmpdir(), "nesev-xsd-"));
  try {
    const file = join(dir, "out.xml");
    writeFileSync(file, xml, "latin1");
    const res = Bun.spawnSync(["xmllint", "--noout", "--schema", join(XSD_DIR, xsd), file]);
    return res.exitCode === 0 ? "ok" : res.stderr.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("parseSteuernummer", () => {
  test("accepts common notations", () => {
    for (const s of ["12 345/6789", "12-345/6789", "123456789", " St.Nr. 12 345/6789 ", "12 3456789"]) {
      expect(parseSteuernummer(s)).toEqual({ ok: true, fastnr: "123456789" });
    }
  });
  test("rejects with a German message", () => {
    const empty = parseSteuernummer("");
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toContain("Keine Steuernummer");
    const short = parseSteuernummer("345/6789");
    if (!short.ok) expect(short.error).toContain("7 Ziffern");
    else throw new Error("expected error");
    expect(parseSteuernummer("ATU12345678").ok).toBe(false);
    expect(parseSteuernummer("00 345/6789").ok).toBe(false);
    expect(parseSteuernummer("99 345/6789").ok).toBe(false);
  });
});

describe("amount formats", () => {
  test("xmlAmount and wholeEuros", () => {
    expect(xmlAmount(123456)).toBe("1234.56");
    expect(xmlAmount(-5)).toBe("-0.05");
    expect(xmlAmount(0)).toBe("0.00");
    expect(wholeEuros(123450)).toBe(1235);
    expect(wholeEuros(123449)).toBe(1234);
    expect(wholeEuros(-150)).toBe(-2);
  });
});

describe("UVA XML (U30)", () => {
  test("monthly UVA with domestic revenue, credit note, reverse charge and ig. Erwerb", () => {
    const { db, doc, expense } = setup();
    const inv = doc([{ net: 100000 }, { net: 50000, rate: 1000 }]);
    doc([{ net: 10000 }], { type: "credit_note", number: "GS-1", parentId: inv.id, issueDate: "2026-09-20" });
    expense("domestic", 20000);
    expense("reverse_charge", 5000);
    expense("ig_acquisition", 30000);
    const r = computeUva(db, parsePeriod("2026-09")!);
    expect(uvaXmlErrors(r, FASTNR, TODAY)).toEqual([]);
    const xml = uvaXml(r, { fastnr: "123456789", now: NOW });
    expect(xml).toMatchSnapshot();
    expect(xml).toContain('<KZ000 type="kz">1400.00</KZ000>');
    expect(xml).toContain('<KZ022 type="kz">900.00</KZ022>');
    expect(xml).toContain('<KZ029 type="kz">500.00</KZ029>');
    expect(xml).toContain('<KZ057 type="kz">10.00</KZ057>');
    expect(xml).toContain('<KZ070 type="kz">300.00</KZ070>');
    expect(xml).toContain('<KZ072 type="kz">300.00</KZ072>');
    expect(xml).toContain('<KZ060 type="kz">40.00</KZ060>');
    expect(xml).not.toContain("KZ095");
    for (const xsd of ["U30_07_2026.xsd", "U30_01_2022.xsd"]) {
      const res = validate(xml, xsd);
      if (res !== null) expect(res).toBe("ok");
    }
  });

  test("quarter: ZRVON/ZRBIS span the quarter; empty period still has KZ000 = 0", () => {
    const { db } = setup();
    const r = computeUva(db, parsePeriod("2026-Q2")!);
    const xml = uvaXml(r, { fastnr: "123456789", now: NOW });
    expect(xml).toContain('<ZRVON type="jahrmonat">2026-04</ZRVON>');
    expect(xml).toContain('<ZRBIS type="jahrmonat">2026-06</ZRBIS>');
    expect(xml).toContain('<KZ000 type="kz">0.00</KZ000>');
    expect(xml).not.toContain("<VORSTEUER>");
    const res = validate(xml, "U30_07_2026.xsd");
    if (res !== null) expect(res).toBe("ok");
  });

  test("credit note exceeding revenue: negative KZ 090 validates", () => {
    const { db, doc } = setup();
    const inv = doc([{ net: 10000 }], { issueDate: "2026-08-01" });
    doc([{ net: 10000 }], { type: "credit_note", number: "GS-1", parentId: inv.id });
    const r = computeUva(db, parsePeriod("2026-09")!);
    expect(uvaXmlErrors(r, FASTNR, TODAY)).toEqual([]);
    const xml = uvaXml(r, { fastnr: "123456789", now: NOW });
    expect(xml).toContain('<KZ090 type="kz">-20.00</KZ090>');
    const res = validate(xml, "U30_07_2026.xsd");
    if (res !== null) expect(res).toBe("ok");
  });

  test("errors: Steuernummer, open or yearly period", () => {
    const { db } = setup();
    const bad = parseSteuernummer("123");
    expect(uvaXmlErrors(computeUva(db, parsePeriod("2026-09")!), bad, TODAY)[0]).toContain("Ziffern");
    expect(uvaXmlErrors(computeUva(db, parsePeriod("2026-10")!), FASTNR, TODAY).join()).toContain("noch nicht abgeschlossen");
    expect(uvaXmlErrors(computeUva(db, parsePeriod("2026-Q4")!), FASTNR, TODAY).join()).toContain("noch nicht abgeschlossen");
    expect(uvaXmlErrors(computeUva(db, parsePeriod("2025")!), FASTNR, TODAY).join()).toContain("nicht für ein ganzes Jahr");
    expect(uvaXmlErrors(computeUva(db, parsePeriod("2020-01")!), FASTNR, TODAY).join()).toContain("fünf Jahre");
  });
});

describe("ZM XML (U13)", () => {
  test("one line per UID, whole euros, SOLEI for services", () => {
    const { db, doc, de, fr } = setup();
    doc([{ net: 100049 }], { clientId: de.id, taxMode: "EU_REVERSE_CHARGE" });
    doc([{ net: 50000 }], { clientId: de.id, taxMode: "EU_REVERSE_CHARGE", issueDate: "2026-08-01" });
    const inv = doc([{ net: 20000 }], { clientId: fr.id, taxMode: "EU_REVERSE_CHARGE" });
    doc([{ net: 5050 }], { clientId: fr.id, taxMode: "EU_REVERSE_CHARGE", type: "credit_note", number: "GS-1", parentId: inv.id });
    const r = computeZm(db, parsePeriod("2026-Q3")!);
    expect(zmXmlErrors(r, FASTNR, "ATU12345678", TODAY)).toEqual([]);
    const xml = zmXml(r, { fastnr: "123456789", now: NOW });
    expect(xml).toMatchSnapshot();
    expect(xml).toContain("<UID_MS>DE123456789</UID_MS>\n\t\t\t<SUM_BGL type=\"kz\">1500</SUM_BGL>\n\t\t\t<SOLEI>J</SOLEI>");
    expect(xml).toContain("<UID_MS>FR12345678901</UID_MS>\n\t\t\t<SUM_BGL type=\"kz\">150</SUM_BGL>"); // 149,50 rounds up
    expect(xml).not.toContain("DREIECK");
    const res = validate(xml, "U13_ZM_2025.xsd");
    if (res !== null) expect(res).toBe("ok");
  });

  test("negative sum (credit note in a later period) is reported as a correction", () => {
    const { db, doc, de } = setup();
    const inv = doc([{ net: 100000 }], { clientId: de.id, taxMode: "EU_REVERSE_CHARGE", issueDate: "2026-06-01" });
    doc([{ net: 20000 }], { clientId: de.id, taxMode: "EU_REVERSE_CHARGE", type: "credit_note", number: "GS-1", parentId: inv.id });
    const xml = zmXml(computeZm(db, parsePeriod("2026-09")!), { fastnr: "123456789", now: NOW });
    expect(xml).toContain('<SUM_BGL type="kz">-200</SUM_BGL>');
    const res = validate(xml, "U13_ZM_2025.xsd");
    if (res !== null) expect(res).toBe("ok");
  });

  test("errors: missing UIDs, no own UID, empty period", () => {
    const { db, doc } = setup();
    const noUid = db.insert(clients).values({ number: 9, name: "Ohne UID", country: "IT" }).returning().get();
    doc([{ net: 1000 }], { clientId: noUid.id, taxMode: "EU_REVERSE_CHARGE" });
    const errors = zmXmlErrors(computeZm(db, parsePeriod("2026-09")!), FASTNR, "", TODAY);
    expect(errors.join("\n")).toContain("Ohne UID: UID-Nummer fehlt");
    expect(errors.join("\n")).toContain("eigene österreichische UID");
    expect(zmXmlErrors(computeZm(db, parsePeriod("2026-08")!), FASTNR, "ATU12345678", TODAY).join()).toContain("Keine Meldezeilen");
  });
});
