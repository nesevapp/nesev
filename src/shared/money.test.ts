import { describe, expect, test } from "bun:test";
import { formatBp, formatCents, formatQuantity, parseMoneyToCents, parseQuantity } from "./money";
import { formatDocumentNumber } from "./documents";

const nbsp = (s: string) => s.replace(/\s/g, " ");

describe("money", () => {
  test("formatCents de-AT", () => {
    expect(nbsp(formatCents(123456))).toBe("€ 1.234,56");
    expect(nbsp(formatCents(-5))).toBe("-€ 0,05");
  });
  test("parseMoneyToCents", () => {
    expect(parseMoneyToCents("1.234,56")).toBe(123456);
    expect(parseMoneyToCents("1234,5")).toBe(123450);
    expect(parseMoneyToCents("12")).toBe(1200);
    expect(parseMoneyToCents("12.5")).toBe(1250);
    expect(parseMoneyToCents("1.500")).toBe(150000);
    expect(parseMoneyToCents("€ 9,99")).toBe(999);
    expect(parseMoneyToCents("-3,10")).toBe(-310);
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents("")).toBeNull();
  });
  test("quantity", () => {
    expect(parseQuantity("1,5")).toBe(1500);
    expect(parseQuantity("0,333")).toBe(333);
    expect(formatQuantity(1500)).toBe("1,5");
    expect(formatQuantity(2000)).toBe("2");
  });
  test("basis points", () => {
    expect(nbsp(formatBp(2000))).toBe("20 %");
    expect(nbsp(formatBp(550))).toBe("5,5 %");
  });
});

test("formatDocumentNumber", () => {
  expect(formatDocumentNumber("offer", 2026, 1)).toBe("AN-2026-0001");
  expect(formatDocumentNumber("invoice", 2026, 42)).toBe("RE-2026-0042");
  expect(formatDocumentNumber("credit_note", 2027, 12345)).toBe("GS-2027-12345");
});
