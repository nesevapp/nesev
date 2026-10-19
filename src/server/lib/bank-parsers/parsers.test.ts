import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { csvMappingSchema } from "../../../shared/bank";
import { detectDelimiter, detectEncoding, parseAmount, parseDate, splitCsv } from "./csv";
import { BankParseError, importHashes, parseBankFile } from "./index";

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));

describe("camt.053", () => {
  const r = parseBankFile(fixture("camt053.xml"));

  test("reads booked entries, splits batches, skips pending", () => {
    expect(r.format).toBe("camt053");
    expect(r.accountIban).toBe("AT611904300234573201");
    expect(r.openingBalanceCents).toBe(100000);
    expect(r.closingBalanceCents).toBe(240540);
    expect(r.transactions.map((t) => t.amountCents)).toEqual([120000, -9460, 10000, 20000, 0]);
  });

  test("credit: debtor as counterparty, unstructured remittance, entities decoded", () => {
    const t = r.transactions[0]!;
    expect(t).toMatchObject({
      bookingDate: "2026-03-05",
      valueDate: "2026-03-05",
      currency: "EUR",
      counterpartyName: "Müller & Söhne GmbH",
      counterpartyIban: "DE89370400440532013000",
      purpose: "Rechnung RE 2026 0001 Danke",
      reference: "2026030500001",
    });
  });

  test("debit: creditor (Pty/Nm), DtTm booking date, structured reference", () => {
    const t = r.transactions[1]!;
    expect(t).toMatchObject({
      bookingDate: "2026-03-10",
      valueDate: "2026-03-11",
      counterpartyName: "A1 Telekom Austria AG",
      counterpartyIban: "AT571200000512345678",
      purpose: "RF18539007547034",
      reference: "2026031000007",
    });
  });

  test("batch details keep their own parties", () => {
    expect(r.transactions[2]).toMatchObject({ counterpartyName: "Anna Beispiel", purpose: "RE-2026-0002 Teilzahlung", reference: "B-1" });
    expect(r.transactions[3]).toMatchObject({ counterpartyName: "Berta Beispiel", purpose: "RE20260003", reference: "B-2" });
    expect(r.transactions[4]!.purpose).toBe("Kontoführung");
  });
});

describe("CSV presets", () => {
  test("N26 (current export)", () => {
    const r = parseBankFile(fixture("n26.csv"));
    expect(r.csv?.detectedPreset).toBe("n26");
    expect(r.errors).toEqual([]);
    expect(r.transactions).toHaveLength(3);
    expect(r.transactions[0]).toMatchObject({
      bookingDate: "2026-03-02",
      amountCents: 120000,
      counterpartyName: "Müller GmbH",
      counterpartyIban: "DE89370400440532013000",
      purpose: "RE-2026-0001",
    });
    expect(r.transactions[1]!.amountCents).toBe(-2345);
  });

  test("N26 (older export)", () => {
    const r = parseBankFile(fixture("n26-old.csv"));
    expect(r.csv?.detectedPreset).toBe("n26");
    expect(r.transactions[0]).toMatchObject({ bookingDate: "2025-12-30", amountCents: -1290, counterpartyName: "Hofer" });
  });

  test("Revolut: completed only, fee subtracted, completion date", () => {
    const r = parseBankFile(fixture("revolut.csv"));
    expect(r.csv?.detectedPreset).toBe("revolut");
    expect(r.csv?.filtered).toBe(1);
    expect(r.transactions.map((t) => [t.bookingDate, t.amountCents])).toEqual([
      ["2026-03-02", -1999],
      ["2026-03-04", 50000],
      ["2026-03-05", -10050],
    ]);
    expect(r.transactions[1]!.counterpartyName).toBe("Payment from Huber KG");
  });

  test("Wise: DD-MM-YYYY, payer/payee/merchant name", () => {
    const r = parseBankFile(fixture("wise.csv"));
    expect(r.csv?.detectedPreset).toBe("wise");
    expect(r.transactions.map((t) => [t.bookingDate, t.amountCents, t.counterpartyName])).toEqual([
      ["2026-03-07", 85000, "Kunde AG"],
      ["2026-03-08", -1520, "Notion Labs"],
      ["2026-03-09", -30000, "Vermieter GmbH"],
    ]);
    expect(r.transactions[0]!.purpose).toBe("RE-2026-0004 Received money from Kunde AG with reference RE-2026-0004");
    expect(r.transactions[2]!.counterpartyIban).toBe("AT126000000098765432");
  });

  test("Raiffeisen ELBA: header-less, Windows-1252, decimal comma, IBAN from text", () => {
    const bytes = fixture("elba.csv");
    expect(detectEncoding(bytes)).toBe("windows-1252");
    const r = parseBankFile(bytes);
    expect(r.csv?.detectedPreset).toBe("elba");
    expect(r.csv?.mapping.encoding).toBe("windows-1252");
    expect(r.transactions.map((t) => t.amountCents)).toEqual([125000, -3490, -102055]);
    expect(r.transactions[0]!.purpose).toContain("Österreichische Firma GmbH");
    expect(r.transactions[0]!.counterpartyIban).toBe("AT483200000012345864");
    expect(r.transactions[2]!.valueDate).toBe("2026-03-05");
  });

  test("George JSON", () => {
    const r = parseBankFile(fixture("george.json"));
    expect(r.format).toBe("george-json");
    expect(r.transactions).toEqual([
      {
        bookingDate: "2026-03-12",
        valueDate: "2026-03-12",
        amountCents: 48000,
        currency: "EUR",
        counterpartyName: "Kunde Beta OG",
        counterpartyIban: "AT621490000087654321",
        purpose: "RE-2026-0005",
        reference: "209912345678AT1",
      },
      {
        bookingDate: "2026-03-13",
        valueDate: "2026-03-14",
        amountCents: -8850,
        currency: "EUR",
        counterpartyName: "Wiener Stadtwerke",
        counterpartyIban: "AT611100000123456789",
        purpose: "Strom Kd 4711",
        reference: "209912345679AT1",
      },
    ]);
  });
});

describe("George JSON dates", () => {
  const parse = (booking: unknown) => {
    const json = JSON.stringify([{ booking, amount: { value: 100, precision: 2, currency: "EUR" } }]);
    return parseBankFile(new TextEncoder().encode(json)).transactions[0]?.bookingDate;
  };

  test("epoch millis and zoned timestamps are Vienna calendar days", () => {
    // midnight 01.01.2026 in Vienna = 2025-12-31T23:00Z
    expect(parse(Date.UTC(2025, 11, 31, 23, 0))).toBe("2026-01-01");
    expect(parse("2025-12-31T23:00:00.000Z")).toBe("2026-01-01");
    // summer time (UTC+2): 22:30 UTC is already the next day
    expect(parse(Date.UTC(2026, 6, 14, 22, 30))).toBe("2026-07-15");
    expect(parse("2026-07-14T22:30:00Z")).toBe("2026-07-15");
    // George's own local offsets and plain dates stay as written
    expect(parse("2026-01-02T00:00:00.000+0100")).toBe("2026-01-02");
    expect(parse("2026-03-29T00:00:00.000+01:00")).toBe("2026-03-29");
    expect(parse("2026-01-02")).toBe("2026-01-02");
    expect(parse("2026-01-02T00:00:00")).toBe("2026-01-02");
    expect(parse(Number.NaN)).toBeUndefined();
  });
});

describe("generic CSV mapping", () => {
  test("guesses columns of an unknown Windows-1252 export with decimal comma", () => {
    const r = parseBankFile(fixture("generic-1252.csv"));
    expect(r.csv?.detectedPreset).toBeNull();
    const m = r.csv!.mapping;
    expect(m).toMatchObject({ preset: "generic", encoding: "windows-1252", delimiter: ";", decimal: ",", hasHeader: true });
    expect(r.csv!.columns[2]).toBe("Auftraggeber/Empfänger");
    expect(r.transactions).toEqual([
      {
        bookingDate: "2026-03-10",
        valueDate: "2026-03-10",
        amountCents: 149999,
        currency: "EUR",
        counterpartyName: "Gärtner & Co KG",
        counterpartyIban: "AT126000000098765432",
        purpose: "Zahlung RE-2026-0007 – danke",
        reference: "",
      },
      expect.objectContaining({ amountCents: -24900, counterpartyName: "Büro Möbel Stöckl" }),
    ]);
  });

  test("explicit mapping: skip rows, debit/credit columns, US dates", () => {
    const csv = [
      "Export Musterbank",
      "Date|Text|Debit|Credit",
      "03/14/2026|Kunde X RE-2026-0009|  |1,234.50",
      "03/15/2026|Miete|800.00|",
    ].join("\n");
    const mapping = csvMappingSchema.parse({
      delimiter: "|",
      encoding: "utf-8",
      skipRows: 1,
      hasHeader: true,
      decimal: ".",
      dateFormat: "MM/DD/YYYY",
      bookingDate: 0,
      debit: 2,
      credit: 3,
      purpose: [1],
    });
    const r = parseBankFile(new TextEncoder().encode(csv), { mapping });
    expect(r.errors).toEqual([]);
    expect(r.transactions.map((t) => [t.bookingDate, t.amountCents, t.purpose])).toEqual([
      ["2026-03-14", 123450, "Kunde X RE-2026-0009"],
      ["2026-03-15", -80000, "Miete"],
    ]);
  });

  test("reports unreadable rows with line numbers", () => {
    const csv = "Datum;Betrag;Text\n01.03.2026;12,00;ok\nkein Datum;1,00;x\n02.03.2026;abc;y\n";
    const r = parseBankFile(new TextEncoder().encode(csv));
    expect(r.transactions).toHaveLength(1);
    expect(r.errors.map((e) => e.line)).toEqual([3, 4]);
  });

  test("remembers a saved mapping when the header matches", () => {
    const first = parseBankFile(fixture("generic-1252.csv"));
    const saved = { ...first.csv!.mapping, purpose: [4, 2] };
    const again = parseBankFile(fixture("generic-1252.csv"), { savedMapping: saved });
    expect(again.csv?.usedSavedMapping).toBe(true);
    expect(again.transactions[0]!.purpose).toBe("Zahlung RE-2026-0007 – danke Gärtner & Co KG");
  });

  test("rejects empty and non-camt XML files", () => {
    expect(() => parseBankFile(new Uint8Array())).toThrow(BankParseError);
    expect(() => parseBankFile(new TextEncoder().encode("<html></html>"))).toThrow(BankParseError);
  });
});

describe("CSV primitives", () => {
  test("amounts", () => {
    expect(parseAmount("1.234,56", ",")).toBe(123456);
    expect(parseAmount("-1.234,56 €", ",")).toBe(-123456);
    expect(parseAmount("12,50-", ",")).toBe(-1250);
    expect(parseAmount("+5", ",")).toBe(500);
    expect(parseAmount("1,234.5", ".")).toBe(123450);
    expect(parseAmount("(3.00)", ".")).toBe(-300);
    expect(parseAmount("−7,10", ",")).toBe(-710);
    expect(parseAmount("abc", ",")).toBeNull();
    expect(parseAmount("", ",")).toBeNull();
  });

  test("dates", () => {
    expect(parseDate("1.3.2026", "DD.MM.YYYY")).toBe("2026-03-01");
    expect(parseDate("2026-03-01 10:00:00", "YYYY-MM-DD")).toBe("2026-03-01");
    expect(parseDate("01.03.26", "DD.MM.YY")).toBe("2026-03-01");
    expect(parseDate("13/31/2026", "DD/MM/YYYY")).toBeNull();
  });

  test("quoted cells and delimiter detection", () => {
    expect(splitCsv('a;"b;c";"d ""e"""\n"multi\nline";2', ";")).toEqual([
      ["a", "b;c", 'd "e"'],
      ["multi\nline", "2"],
    ]);
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter('a;b;c\n1;"2,5";3')).toBe(";");
  });
});

describe("import hashes", () => {
  test("stable, distinct for identical same-day rows", () => {
    const r = parseBankFile(fixture("n26.csv"));
    const h = importHashes(r.transactions);
    expect(new Set(h).size).toBe(3);
    expect(importHashes(parseBankFile(fixture("n26.csv")).transactions)).toEqual(h);
    // the overlapping part of a later export yields the same keys
    expect(importHashes(r.transactions.slice(1))).toEqual([h[1], h[2]]);
  });
});

describe("xml entities", () => {
  test("character references outside Unicode are kept as text instead of throwing", async () => {
    const { parseXml } = await import("./xml");
    const text = (xml: string) => parseXml(xml).children[0]!.text;
    expect(text("<a>&#x41;&#66;&amp;</a>")).toBe("AB&");
    expect(text("<a>&#x110000;</a>")).toBe("&#x110000;");
    expect(text("<a>&#99999999999;</a>")).toBe("&#99999999999;");
    expect(text("<a>&#xDFFF;</a>")).toBe("&#xDFFF;");
  });
});
