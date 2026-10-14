import { describe, expect, test } from "bun:test";
import { docStatusLabel, eurosToCents, euroAmount, money, percent, qty, toMilli } from "./format";

describe("eurosToCents", () => {
  test("numbers are euros", () => {
    expect(eurosToCents(12.5)).toBe(1250);
    expect(eurosToCents(1234.56)).toBe(123456);
    expect(eurosToCents(0.1 + 0.2)).toBe(30);
    expect(eurosToCents(-5)).toBe(-500);
    expect(eurosToCents(Number.NaN)).toBeNull();
  });

  test("German and English decimal strings", () => {
    expect(eurosToCents("1.234,56")).toBe(123456);
    expect(eurosToCents("1234,56")).toBe(123456);
    expect(eurosToCents("1234.56")).toBe(123456);
    expect(eurosToCents("1,234.56")).toBe(123456);
    expect(eurosToCents("€ 12,50")).toBe(1250);
    expect(eurosToCents("12")).toBe(1200);
    expect(eurosToCents("1.500")).toBe(150000);
    expect(eurosToCents("abc")).toBeNull();
  });

  test("euroAmount schema transforms to cents and rejects garbage", () => {
    expect(euroAmount.parse("99,90")).toBe(9990);
    expect(euroAmount.parse(99.9)).toBe(9990);
    const bad = euroAmount.safeParse("zwölf");
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe("Ungültiger Betrag: zwölf");
  });
});

test("money, quantities, rates", () => {
  expect(money(123456)).toEqual({ cents: 123456, formatted: expect.stringMatching(/^€\s1\.234,56$/) });
  expect(qty(1500)).toBe(1.5);
  expect(toMilli(1.5)).toBe(1500);
  expect(percent(2000)).toBe(20);
});

test("status labels include derived states", () => {
  expect(docStatusLabel({ status: "sent" })).toBe("Versendet");
  expect(docStatusLabel({ status: "sent", overdue: true })).toBe("Überfällig");
  expect(docStatusLabel({ status: "final", partial: true })).toBe("Finalisiert (teilbezahlt)");
});
