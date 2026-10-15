import { describe, expect, test } from "bun:test";
import { clientUpdateSchema } from "./client";

describe("partialWithoutDefaults", () => {
  test("omitted fields stay omitted (no defaults injected)", () => {
    expect(clientUpdateSchema.parse({ name: "Neu" })).toEqual({ name: "Neu" });
  });
  test("given fields are still validated", () => {
    expect(clientUpdateSchema.safeParse({ eInvoiceFormat: "pdf" }).success).toBe(false);
    expect(clientUpdateSchema.parse({ eInvoiceFormat: "ebinterface" })).toEqual({ eInvoiceFormat: "ebinterface" });
  });
});
