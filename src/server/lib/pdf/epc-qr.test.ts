import { describe, expect, test } from "bun:test";
import { EPC_MAX_BYTES, epcAmount, epcQrPayload } from "./epc-qr";

const base = { name: "Muster GmbH", iban: "AT61 1904 3002 3457 3201", bic: "BKAUATWW", amountCents: 31980, reference: "RE-2026-0001" };
const bytes = (s: string) => new TextEncoder().encode(s).length;
const fields = (s: string) => s.split("\n");

describe("epcAmount", () => {
  test("formats integer cents with two decimals", () => {
    expect(epcAmount(12345)).toBe("EUR123.45");
    expect(epcAmount(1)).toBe("EUR0.01");
    expect(epcAmount(100)).toBe("EUR1.00");
    expect(epcAmount(99_999_999_999)).toBe("EUR999999999.99");
  });
});

describe("epcQrPayload", () => {
  test("version 002, UTF-8, SCT with unstructured text", () => {
    expect(epcQrPayload(base)).toBe("BCD\n002\n1\nSCT\nBKAUATWW\nMuster GmbH\nAT611904300234573201\nEUR319.80\n\n\nRE-2026-0001");
  });

  test("BIC is optional; an invalid one is left out", () => {
    expect(fields(epcQrPayload({ ...base, bic: "" }))[4]).toBe("");
    expect(fields(epcQrPayload({ ...base, bic: "bkau atww xxx" }))[4]).toBe("BKAUATWWXXX");
    expect(fields(epcQrPayload({ ...base, bic: "BKAU" }))[4]).toBe("");
  });

  test("empty without a valid IBAN, a name or a payable amount", () => {
    expect(epcQrPayload({ ...base, iban: "" })).toBe("");
    expect(epcQrPayload({ ...base, iban: "AT61" })).toBe("");
    expect(epcQrPayload({ ...base, iban: "1234567890" })).toBe("");
    expect(epcQrPayload({ ...base, name: "  " })).toBe("");
    expect(epcQrPayload({ ...base, amountCents: 0 })).toBe("");
    expect(epcQrPayload({ ...base, amountCents: -500 })).toBe("");
    expect(epcQrPayload({ ...base, amountCents: 100_000_000_000 })).toBe("");
  });

  test("drops trailing empty fields (draft without number)", () => {
    expect(epcQrPayload({ ...base, reference: "" })).toBe("BCD\n002\n1\nSCT\nBKAUATWW\nMuster GmbH\nAT611904300234573201\nEUR319.80");
  });

  test("line breaks and control characters never split a field", () => {
    const p = epcQrPayload({ ...base, name: "Muster\nGmbH\t & Co", reference: "RE-1\r\nzweite Zeile" });
    expect(fields(p)).toHaveLength(11);
    expect(fields(p)[5]).toBe("Muster GmbH & Co");
    expect(fields(p)[10]).toBe("RE-1 zweite Zeile");
  });

  test("name is cut to 70 and text to 140 characters", () => {
    const p = epcQrPayload({ ...base, name: "N".repeat(100), reference: "T".repeat(200) });
    expect(fields(p)[5]).toBe("N".repeat(70));
    expect(fields(p)[10]).toBe("T".repeat(140));
    expect(bytes(p)).toBeLessThanOrEqual(EPC_MAX_BYTES);
  });

  test("keeps umlauts and cuts multi-byte text to stay within 331 bytes", () => {
    const p = epcQrPayload({ ...base, bic: "BKAUATWWXXX", name: "Ä".repeat(80), reference: "Ü".repeat(200) });
    expect(bytes(p)).toBeLessThanOrEqual(EPC_MAX_BYTES);
    expect(fields(p)[5]).toBe("Ä".repeat(70)); // the text is shortened first
    expect(fields(p)[10]!.length).toBeGreaterThan(0);
    expect(fields(p)[10]).toMatch(/^Ü+$/);
  });

  test("shortens the name too when the text alone is not enough, without splitting characters", () => {
    const p = epcQrPayload({ ...base, bic: "BKAUATWWXXX", name: "😀".repeat(70), reference: "😀".repeat(140) });
    expect(bytes(p)).toBeLessThanOrEqual(EPC_MAX_BYTES);
    expect(fields(p)).toHaveLength(8); // text gone, trailing empty fields dropped
    expect(fields(p)[5]).toMatch(/^(😀)+$/u);
    expect(p).not.toContain("�");
  });
});
