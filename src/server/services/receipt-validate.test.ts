import { describe, expect, test } from "bun:test";
import { type FieldSuggestion, type ReceiptFields, suggestedLines } from "../../shared/receipts";
import { createTestDb } from "../db/client";
import { createExpense } from "./expenses";
import { supplierHistory } from "./receipt-pipeline";
import { mergeFields, validateFields } from "./receipt-validate";

const f = <T>(value: T, confidence = 0.7, source: FieldSuggestion<T>["source"] = "llm"): FieldSuggestion<T> => ({
  value,
  confidence,
  source,
});
const TODAY = "2026-10-14";

describe("validateFields", () => {
  test("consistent breakdown and total raise the confidence", () => {
    const { fields, warnings } = validateFields(
      {
        grossCents: f(1711),
        taxLines: f([
          { taxRateBp: 1000, netCents: 603, taxCents: 60, grossCents: 663 },
          { taxRateBp: 2000, netCents: 873, taxCents: 175, grossCents: 1048 },
        ]),
      },
      TODAY,
    );
    expect(warnings).toEqual([]);
    expect(fields.grossCents!.confidence).toBeCloseTo(0.85);
    expect(fields.taxLines!.confidence).toBeCloseTo(0.85);
  });

  test("sum mismatch and wrong tax lower the confidence", () => {
    const { fields, warnings } = validateFields(
      { grossCents: f(5000), taxLines: f([{ taxRateBp: 2000, netCents: 4000, taxCents: 500, grossCents: 4500 }]) },
      TODAY,
    );
    expect(warnings.some((w) => w.includes("passt nicht zum Satz"))).toBe(true);
    expect(warnings.some((w) => w.includes("≠ Gesamtbetrag"))).toBe(true);
    expect(fields.taxLines!.confidence).toBeLessThan(0.3);
    expect(fields.grossCents!.confidence).toBeLessThan(0.5);
  });

  test("non-Austrian rate is flagged", () => {
    const { fields, warnings } = validateFields(
      { taxLines: f([{ taxRateBp: 1900, netCents: 10000, taxCents: 1900, grossCents: 11900 }]) },
      TODAY,
    );
    expect(warnings[0]).toContain("19 %");
    expect(fields.taxLines!.confidence).toBeLessThan(0.5);
  });

  test("UID and IBAN check digits, country vs. UID", () => {
    const { fields } = validateFields(
      { supplierUid: f("ATU12345678"), iban: f("AT611904300234573202"), supplierCountry: f("DE") },
      TODAY,
    );
    expect(fields.supplierUid!.confidence).toBeLessThan(0.3);
    expect(fields.supplierUid!.note).toContain("ungültig");
    expect(fields.iban!.confidence).toBeLessThan(0.3);
    expect(fields.supplierCountry!.note).toContain("AT");
    const ok = validateFields({ supplierUid: f("ATU12345675") }, TODAY).fields;
    expect(ok.supplierUid!.confidence).toBeCloseTo(0.8);
  });

  test("implausible dates", () => {
    const { fields } = validateFields({ issueDate: f("2031-01-01"), dueDate: f("2030-01-01") }, TODAY);
    expect(fields.issueDate!.note).toContain("unplausibel");
    expect(fields.dueDate!.note).toContain("Fälligkeit");
  });

  test("foreign currency warning", () => {
    const { warnings } = validateFields({ currency: f("USD"), grossCents: f(2000) }, TODAY);
    expect(warnings[0]).toContain("USD");
  });
});

describe("mergeFields", () => {
  test("agreement boosts, disagreement notes the other value", () => {
    const merged = mergeFields(
      { grossCents: f(1711, 0.8), supplierInvoiceNumber: f("Bon 4711", 0.9), supplierName: f("BILLA AG Filiale 1234 Wien", 0.9) },
      {
        grossCents: f(1711, 0.65, "rules"),
        supplierInvoiceNumber: f("4711", 0.5, "rules"),
        supplierName: f("BILLA AG", 0.65, "rules"),
        iban: f("AT611904300234573201", 0.85, "rules"),
      },
    );
    expect(merged.grossCents!.confidence).toBeCloseTo(0.9);
    expect(merged.supplierInvoiceNumber!.value).toBe("Bon 4711");
    expect(merged.supplierInvoiceNumber!.note).toBe("Regeln: 4711");
    expect(merged.supplierName!.value).toBe("BILLA AG");
    expect(merged.iban!.source).toBe("rules");
  });
});

describe("suggestedLines", () => {
  const fields: ReceiptFields = {
    category: f("bewirtung"),
    description: f("Geschäftsessen"),
    grossCents: f(6980),
    taxLines: f([
      { taxRateBp: 1000, netCents: 4636, taxCents: 464, grossCents: 5100 },
      { taxRateBp: 2000, netCents: 1567, taxCents: 313, grossCents: 1880 },
    ]),
  };

  test("one line per rate for domestic receipts", () => {
    expect(suggestedLines(fields, "domestic")).toEqual([
      { category: "bewirtung", description: "", netCents: 4636, taxRateBp: 1000, taxCents: 464, deductibleBp: 10000 },
      { category: "bewirtung", description: "", netCents: 1567, taxRateBp: 2000, taxCents: 313, deductibleBp: 10000 },
    ]);
  });

  test("reverse charge: net at 20 % self-assessed", () => {
    const rc: ReceiptFields = { category: f("software_abos"), taxLines: f([{ taxRateBp: 0, netCents: 4900, taxCents: 0, grossCents: 4900 }]) };
    expect(suggestedLines(rc, "reverse_charge")).toEqual([
      { category: "software_abos", description: "", netCents: 4900, taxRateBp: 2000, taxCents: 980, deductibleBp: 10000 },
    ]);
  });

  test("gross only → one 20 % line; none → 0 %", () => {
    expect(suggestedLines({ grossCents: f(12000) }, "domestic")[0]).toMatchObject({ netCents: 10000, taxCents: 2000 });
    expect(suggestedLines({ grossCents: f(12000) }, "none")[0]).toMatchObject({ netCents: 12000, taxRateBp: 0 });
    expect(suggestedLines({}, "domestic")).toEqual([]);
  });
});

describe("mergeFields arithmetic", () => {
  const rows = [
    { taxRateBp: 1000, netCents: 4636, taxCents: 464, grossCents: 5100 },
    { taxRateBp: 2000, netCents: 1567, taxCents: 313, grossCents: 1880 },
  ];
  test("swapped rates from the model lose against a consistent breakdown", () => {
    const swapped = [
      { taxRateBp: 1000, netCents: 1567, taxCents: 313, grossCents: 1880 },
      { taxRateBp: 2000, netCents: 4636, taxCents: 464, grossCents: 5100 },
    ];
    const merged = mergeFields({ taxLines: f(swapped, 0.9) }, { taxLines: f(rows, 0.7, "rules") });
    expect(merged.taxLines!.value).toEqual(rows);
    expect(merged.taxLines!.source).toBe("rules");
  });

  test("the total that matches the breakdown wins (not the cash tendered)", () => {
    const merged = mergeFields(
      { grossCents: f(2000, 0.9), taxLines: f(rows, 0.9) },
      { grossCents: f(6980, 0.65, "rules"), taxLines: f(rows, 0.7, "rules") },
    );
    expect(merged.grossCents!.value).toBe(6980);
  });
});

describe("mergeFields GWG limit", () => {
  const laptop = [{ taxRateBp: 2000, netCents: 120000, taxCents: 24000, grossCents: 144000 }];
  test("a model's hardware_gwg above 1.000 € net becomes anlagen after the merge", () => {
    const merged = mergeFields(
      { category: f("hardware_gwg" as const, 0.6), taxLines: f(laptop, 0.8), grossCents: f(144000, 0.8) },
      { category: f("buero" as const, 0.45, "rules") },
    );
    expect(merged.category?.value).toBe("anlagen");
    expect(merged.category?.note).toContain("GWG");
  });

  test("Kleinunternehmer compare the gross amount", () => {
    const row = [{ taxRateBp: 2000, netCents: 90000, taxCents: 18000, grossCents: 108000 }];
    const model = { category: f("hardware_gwg" as const, 0.6), taxLines: f(row, 0.8) };
    expect(mergeFields(model, {}).category?.value).toBe("hardware_gwg");
    expect(mergeFields(model, {}, { smallBusiness: true }).category?.value).toBe("anlagen");
  });

  test("up to the limit and other categories stay", () => {
    const row = [{ taxRateBp: 2000, netCents: 100000, taxCents: 20000, grossCents: 120000 }];
    expect(mergeFields({ category: f("hardware_gwg" as const, 0.6), taxLines: f(row) }, {}).category?.value).toBe("hardware_gwg");
    expect(mergeFields({ category: f("buero" as const, 0.6), taxLines: f(laptop) }, {}).category?.value).toBe("buero");
  });
});

describe("supplierHistory GWG limit", () => {
  test("the supplier's usual hardware_gwg becomes anlagen above the limit", () => {
    const db = createTestDb();
    createExpense(db, {
      supplierName: "Computer Huber",
      supplierCountry: "AT",
      vatTreatment: "domestic",
      issueDate: "2026-05-01",
      lines: [{ category: "hardware_gwg", description: "", netCents: 50000, taxRateBp: 2000, taxCents: 10000, deductibleBp: 10000 }],
    });
    const row = (net: number) => [{ taxRateBp: 2000, netCents: net, taxCents: net / 5, grossCents: net * 1.2 }];
    const big = supplierHistory(db, { supplierName: f("Computer Huber"), taxLines: f(row(150000)) });
    expect(big.fields.category).toMatchObject({ value: "anlagen", source: "supplier" });
    const small = supplierHistory(db, { supplierName: f("Computer Huber"), taxLines: f(row(90000)) });
    expect(small.fields.category?.value).toBe("hardware_gwg");
    expect(supplierHistory(db, { supplierName: f("Computer Huber"), taxLines: f(row(90000)) }, true).fields.category?.value).toBe("anlagen");
  });
});
