import { describe, expect, test } from "bun:test";
import { calcTotals } from "./totals";

describe("calcTotals", () => {
  test("empty", () => {
    const t = calcTotals([], "AT_DOMESTIC");
    expect(t).toMatchObject({ netCents: 0, taxCents: 0, grossCents: 0, taxGroups: [] });
  });

  test("single line 20 %", () => {
    const t = calcTotals([{ quantity: 2000, unitPriceCents: 10000, taxRateBp: 2000 }], "AT_DOMESTIC");
    expect(t.netCents).toBe(20000);
    expect(t.taxCents).toBe(4000);
    expect(t.grossCents).toBe(24000);
  });

  test("groups by rate, sorted desc", () => {
    const t = calcTotals(
      [
        { quantity: 1000, unitPriceCents: 1000, taxRateBp: 1000 },
        { quantity: 1000, unitPriceCents: 5000, taxRateBp: 2000 },
        { quantity: 3000, unitPriceCents: 1000, taxRateBp: 2000 },
        { quantity: 1000, unitPriceCents: 999, taxRateBp: 1300 },
      ],
      "AT_DOMESTIC",
    );
    expect(t.taxGroups).toEqual([
      { rateBp: 2000, netCents: 8000, taxCents: 1600 },
      { rateBp: 1300, netCents: 999, taxCents: 130 },
      { rateBp: 1000, netCents: 1000, taxCents: 100 },
    ]);
    expect(t.netCents).toBe(9999);
    expect(t.taxCents).toBe(1830);
    expect(t.grossCents).toBe(11829);
  });

  test("fractional quantity rounds per line", () => {
    // 1,333 × 0,99 € = 1,31967 → 1,32 €
    const t = calcTotals([{ quantity: 1333, unitPriceCents: 99, taxRateBp: 2000 }], "AT_DOMESTIC");
    expect(t.lines[0].netCents).toBe(132);
    // two such lines: per-line rounding then summing (2 × 132), tax on group sum
    const t2 = calcTotals(
      [
        { quantity: 1333, unitPriceCents: 99, taxRateBp: 2000 },
        { quantity: 1333, unitPriceCents: 99, taxRateBp: 2000 },
      ],
      "AT_DOMESTIC",
    );
    expect(t2.netCents).toBe(264);
    expect(t2.taxCents).toBe(53); // 52.8 → 53
  });

  test("discount per line", () => {
    const t = calcTotals(
      [{ quantity: 3000, unitPriceCents: 3333, taxRateBp: 2000, discountBp: 1000 }],
      "AT_DOMESTIC",
    );
    // 99,99 − 10 % (9,999 → 10,00) = 89,99
    expect(t.lines[0]).toEqual({ grossLineCents: 9999, discountCents: 1000, netCents: 8999, taxRateBp: 2000 });
    expect(t.discountCents).toBe(1000);
    expect(t.taxCents).toBe(1800);
    expect(t.grossCents).toBe(10799);
  });

  test("100 % discount", () => {
    const t = calcTotals([{ quantity: 1000, unitPriceCents: 5000, taxRateBp: 2000, discountBp: 10000 }], "AT_DOMESTIC");
    expect(t.grossCents).toBe(0);
  });

  test.each(["EU_REVERSE_CHARGE", "THIRD_COUNTRY", "SMALL_BUSINESS"] as const)("%s → 0 % tax", (mode) => {
    const t = calcTotals(
      [
        { quantity: 1000, unitPriceCents: 10000, taxRateBp: 2000 },
        { quantity: 1000, unitPriceCents: 5000, taxRateBp: 1000 },
      ],
      mode,
    );
    expect(t.taxCents).toBe(0);
    expect(t.grossCents).toBe(15000);
    expect(t.taxGroups).toEqual([{ rateBp: 0, netCents: 15000, taxCents: 0 }]);
  });

  test("negative amounts round symmetrically", () => {
    const t = calcTotals([{ quantity: 1000, unitPriceCents: -1005, taxRateBp: 2000, discountBp: 5000 }], "AT_DOMESTIC");
    expect(t.lines[0].discountCents).toBe(-503);
    expect(t.netCents).toBe(-502);
    expect(t.taxCents).toBe(-100);
  });
});
