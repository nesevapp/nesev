import { describe, expect, test } from "bun:test";
import { DEFAULT_TAX_NOTES, defaultTaxMode, isEuCountry, taxNoteFor } from "./tax";

const regular = { smallBusiness: false };

describe("defaultTaxMode", () => {
  test("AT client → AT_DOMESTIC (UID irrelevant)", () => {
    expect(defaultTaxMode({ country: "AT" }, regular)).toBe("AT_DOMESTIC");
    expect(defaultTaxMode({ country: "at", uid: "ATU12345678" }, regular)).toBe("AT_DOMESTIC");
  });
  test("EU client with UID → reverse charge", () => {
    expect(defaultTaxMode({ country: "DE", uid: "DE123456789" }, regular)).toBe("EU_REVERSE_CHARGE");
  });
  test("EU client without UID (B2C) → AT_DOMESTIC", () => {
    expect(defaultTaxMode({ country: "DE", uid: "" }, regular)).toBe("AT_DOMESTIC");
    expect(defaultTaxMode({ country: "IT", uid: "  " }, regular)).toBe("AT_DOMESTIC");
  });
  test("non-EU → THIRD_COUNTRY", () => {
    expect(defaultTaxMode({ country: "CH" }, regular)).toBe("THIRD_COUNTRY");
    expect(defaultTaxMode({ country: "CH", uid: "CHE-123.456.789" }, regular)).toBe("THIRD_COUNTRY");
    expect(defaultTaxMode({ country: "US" }, regular)).toBe("THIRD_COUNTRY");
  });
  test("small business: domestic and B2C supplies stay Kleinunternehmer, also against a client default", () => {
    const ku = { smallBusiness: true, uid: "ATU12345678" };
    expect(defaultTaxMode({ country: "AT", uid: "ATU87654321", type: "company" }, ku)).toBe("SMALL_BUSINESS");
    expect(defaultTaxMode({ country: "DE", uid: "" }, ku)).toBe("SMALL_BUSINESS");
    expect(defaultTaxMode({ country: "CH", type: "person" }, ku)).toBe("SMALL_BUSINESS");
    expect(defaultTaxMode({ country: "DE", uid: "DE1", defaultTaxMode: "AT_DOMESTIC" }, ku)).toBe("EU_REVERSE_CHARGE");
    expect(defaultTaxMode({ country: "AT", defaultTaxMode: "AT_DOMESTIC" }, ku)).toBe("SMALL_BUSINESS");
  });
  test("small business: B2B services abroad (§ 3a Abs. 6) → reverse charge / Drittland", () => {
    const ku = { smallBusiness: true, uid: "ATU12345678" };
    expect(defaultTaxMode({ country: "DE", uid: "DE123456789", type: "company" }, ku)).toBe("EU_REVERSE_CHARGE");
    expect(defaultTaxMode({ country: "CH", type: "company" }, ku)).toBe("THIRD_COUNTRY");
    expect(defaultTaxMode({ country: "US", uid: "12-3456789" }, ku)).toBe("THIRD_COUNTRY");
    expect(defaultTaxMode({ country: "AT", defaultTaxMode: "THIRD_COUNTRY" }, ku)).toBe("THIRD_COUNTRY");
  });
  test("small business without own UID: no reverse charge by default", () => {
    expect(defaultTaxMode({ country: "DE", uid: "DE123456789" }, { smallBusiness: true })).toBe("SMALL_BUSINESS");
    expect(defaultTaxMode({ country: "DE", uid: "DE123456789" }, { smallBusiness: true, uid: " " })).toBe("SMALL_BUSINESS");
    expect(defaultTaxMode({ country: "CH", type: "company" }, { smallBusiness: true })).toBe("THIRD_COUNTRY");
  });
  test("explicit client default wins over country", () => {
    expect(defaultTaxMode({ country: "AT", defaultTaxMode: "THIRD_COUNTRY" }, regular)).toBe("THIRD_COUNTRY");
  });
});

test("isEuCountry", () => {
  expect(isEuCountry("DE")).toBe(true);
  expect(isEuCountry("ch")).toBe(false);
  expect(isEuCountry("GB")).toBe(false);
});

test("taxNoteFor", () => {
  expect(taxNoteFor("AT_DOMESTIC", DEFAULT_TAX_NOTES)).toBeNull();
  expect(taxNoteFor("EU_REVERSE_CHARGE", DEFAULT_TAX_NOTES)).toContain("Reverse Charge");
  expect(taxNoteFor("THIRD_COUNTRY", { ...DEFAULT_TAX_NOTES, taxNoteThirdCountry: "X" })).toBe("X");
  expect(taxNoteFor("SMALL_BUSINESS", DEFAULT_TAX_NOTES)).toContain("§ 6 Abs. 1 Z 27");
});
