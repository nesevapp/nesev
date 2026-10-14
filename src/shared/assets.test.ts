import { describe, expect, test } from "bun:test";
import {
  afaForYear,
  assetSchedule,
  bookValueAt,
  bookValueAtYearEnd,
  formatAssetNumber,
  parseAssetNumber,
  spreadOverMonths,
} from "./assets";

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const total = (rows: ReturnType<typeof assetSchedule>) => sum(rows.map((r) => r.afaCents + r.disposalCents));

describe("assetSchedule", () => {
  test("laptop 1.500 € over 3 years, in service in the first half: full AfA from the first year", () => {
    const rows = assetSchedule({ costCents: 150000, usefulLifeYears: 3, inServiceDate: "2026-03-10" });
    expect(rows.map((r) => [r.year, r.startCents, r.afaCents, r.endCents])).toEqual([
      [2026, 150000, 50000, 100000],
      [2027, 100000, 50000, 50000],
      [2028, 50000, 50000, 0],
    ]);
  });

  test("30.6. still counts as first half, 1.7. as second half", () => {
    expect(assetSchedule({ costCents: 150000, usefulLifeYears: 3, inServiceDate: "2026-06-30" })[0]!.afaCents).toBe(50000);
    expect(assetSchedule({ costCents: 150000, usefulLifeYears: 3, inServiceDate: "2026-07-01" })[0]!.afaCents).toBe(25000);
  });

  test("second half: half-year AfA first, the extra last year takes the other half", () => {
    const rows = assetSchedule({ costCents: 240000, usefulLifeYears: 3, inServiceDate: "2026-09-15" });
    expect(rows.map((r) => [r.year, r.afaCents])).toEqual([
      [2026, 40000],
      [2027, 80000],
      [2028, 80000],
      [2029, 40000],
    ]);
    expect(rows.at(-1)!.endCents).toBe(0);
  });

  test("PKW over 8 years", () => {
    const rows = assetSchedule({ costCents: 3600000, usefulLifeYears: 8, inServiceDate: "2026-02-01" });
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.afaCents === 450000)).toBe(true);
    const half = assetSchedule({ costCents: 3600000, usefulLifeYears: 8, inServiceDate: "2026-08-01" });
    expect(half).toHaveLength(9);
    expect([half[0]!.afaCents, half[8]!.afaCents]).toEqual([225000, 225000]);
  });

  test("rounding: AfA always sums to the cost, the last year absorbs the remainder", () => {
    for (const costCents of [100001, 123457, 99999999, 133333, 101]) {
      for (const usefulLifeYears of [1, 3, 7, 11, 50]) {
        for (const inServiceDate of ["2026-01-01", "2026-12-31"]) {
          const rows = assetSchedule({ costCents, usefulLifeYears, inServiceDate });
          expect(total(rows)).toBe(costCents);
          expect(rows.every((r) => r.afaCents >= 0 && r.endCents >= 0)).toBe(true);
        }
      }
    }
    const rows = assetSchedule({ costCents: 100001, usefulLifeYears: 3, inServiceDate: "2026-01-15" });
    expect(rows.map((r) => r.afaCents)).toEqual([33334, 33334, 33333]);
  });

  test("disposal mid-life: regular AfA of that year, then the rest written off; nothing afterwards", () => {
    const asset = { costCents: 240000, usefulLifeYears: 3, inServiceDate: "2026-09-15", disposalDate: "2027-04-30" };
    const rows = assetSchedule(asset);
    expect(rows.map((r) => [r.year, r.afaCents, r.disposalCents, r.endCents])).toEqual([
      [2026, 40000, 0, 200000],
      [2027, 80000, 120000, 0],
    ]);
    expect(total(rows)).toBe(240000);
    expect(afaForYear(asset, 2027)).toEqual({ afaCents: 80000, disposalCents: 120000 });
    expect(afaForYear(asset, 2028)).toEqual({ afaCents: 0, disposalCents: 0 });
  });

  test("disposal in the first year and after full depreciation", () => {
    const first = assetSchedule({ costCents: 150000, usefulLifeYears: 3, inServiceDate: "2026-08-01", disposalDate: "2026-11-01" });
    expect(first).toEqual([{ year: 2026, startCents: 150000, afaCents: 25000, disposalCents: 125000, endCents: 0 }]);
    const late = assetSchedule({ costCents: 150000, usefulLifeYears: 3, inServiceDate: "2026-01-01", disposalDate: "2035-01-01" });
    expect(late).toHaveLength(3);
    expect(late.every((r) => r.disposalCents === 0)).toBe(true);
  });
});

describe("book value", () => {
  const asset = { costCents: 240000, usefulLifeYears: 3, inServiceDate: "2026-09-15" };
  test("at year end", () => {
    expect(bookValueAtYearEnd(asset, 2025)).toBe(240000);
    expect(bookValueAtYearEnd(asset, 2026)).toBe(200000);
    expect(bookValueAtYearEnd(asset, 2028)).toBe(40000);
    expect(bookValueAtYearEnd(asset, 2040)).toBe(0);
  });
  test("at a date: AfA is booked on 31.12.", () => {
    expect(bookValueAt(asset, "2026-10-14")).toBe(240000);
    expect(bookValueAt(asset, "2026-12-31")).toBe(200000);
    expect(bookValueAt(asset, "2027-06-01")).toBe(200000);
    expect(bookValueAt({ ...asset, disposalDate: "2027-04-30" }, "2027-12-31")).toBe(0);
  });
});

describe("helpers", () => {
  test("spreadOverMonths puts the remainder into December", () => {
    const m = spreadOverMonths(40000);
    expect(m[0]).toBe(3333);
    expect(m[11]).toBe(40000 - 3333 * 11);
    expect(sum(m)).toBe(40000);
  });
  test("asset numbers", () => {
    expect(formatAssetNumber(1)).toBe("AV-0001");
    expect(parseAssetNumber("AV-0012")).toBe(12);
    expect(parseAssetNumber("av7")).toBe(7);
    expect(parseAssetNumber("K-1")).toBeNull();
  });
});
