import { expect, test } from "bun:test";
import { createTestDb } from "../db/client";
import { nextNumber, peekNextNumber } from "./numbering";

test("sequences per type and year", () => {
  const db = createTestDb();
  expect(peekNextNumber(db, "invoice", 2026)).toBe("RE-2026-0001");
  expect(nextNumber(db, "invoice", 2026).number).toBe("RE-2026-0001");
  expect(nextNumber(db, "invoice", 2026).number).toBe("RE-2026-0002");
  expect(nextNumber(db, "offer", 2026).number).toBe("AN-2026-0001");
  expect(nextNumber(db, "invoice", 2027).number).toBe("RE-2027-0001");
  expect(nextNumber(db, "credit_note", 2026)).toEqual({ seq: 1, number: "GS-2026-0001" });
  expect(peekNextNumber(db, "invoice", 2026)).toBe("RE-2026-0003");
});

test("gapless: rolled-back transaction does not consume a number", () => {
  const db = createTestDb();
  nextNumber(db, "invoice", 2026);
  expect(() =>
    db.transaction((tx) => {
      expect(nextNumber(tx, "invoice", 2026).seq).toBe(2);
      throw new Error("finalize failed");
    }),
  ).toThrow("finalize failed");
  expect(nextNumber(db, "invoice", 2026).seq).toBe(2);
});
