import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { clientCreateSchema, formatClientNumber, parseClientNumber } from "../../shared/schemas/client";
import { createTestDb, type Db } from "../db/client";
import { documents } from "../db/schema";
import {
  clientSnapshot,
  createClient,
  deleteClient,
  getClient,
  listClients,
  nextClientNumber,
  setClientArchived,
  updateClient,
} from "./clients";

const input = (data: Record<string, unknown>) => clientCreateSchema.parse({ type: "company", ...data });

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof HTTPException) return err.status;
    throw err;
  }
  return undefined;
}

function seed(db: Db) {
  return [
    createClient(db, input({ name: "Alpha GmbH", city: "Wien", country: "AT", email: "office@alpha.at" })),
    createClient(db, input({ name: "beta AG", city: "Zürich", country: "CH", contactPerson: "Hans Muster" })),
    createClient(db, input({ type: "person", name: "Carla 100% Test_", city: "München", country: "DE" })),
  ];
}

describe("client numbers", () => {
  test("format and parse", () => {
    expect(formatClientNumber(1)).toBe("K-0001");
    expect(formatClientNumber(12345)).toBe("K-12345");
    expect(parseClientNumber("K-0012")).toBe(12);
    expect(parseClientNumber("k12")).toBe(12);
    expect(parseClientNumber(" 0012 ")).toBe(12);
    expect(parseClientNumber("Alpha")).toBeNull();
  });

  test("auto-assigns max + 1, explicit numbers must be unique", () => {
    const db = createTestDb();
    expect(nextClientNumber(db)).toBe(1);
    expect(createClient(db, input({ name: "A" })).number).toBe(1);
    expect(createClient(db, input({ name: "B", number: 10 })).number).toBe(10);
    expect(createClient(db, input({ name: "C" })).number).toBe(11);
    expect(statusOf(() => createClient(db, input({ name: "D", number: 10 })))).toBe(409);
  });
});

describe("listClients", () => {
  test("sorted by name, case-insensitive", () => {
    const db = createTestDb();
    seed(db);
    expect(listClients(db).map((c) => c.name)).toEqual(["Alpha GmbH", "beta AG", "Carla 100% Test_"]);
  });

  test("search by name, contact person, email, city and number", () => {
    const db = createTestDb();
    const [alpha, beta, carla] = seed(db);
    const ids = (q: string) => listClients(db, { q }).map((c) => c.id);
    expect(ids("ALPHA")).toEqual([alpha.id]);
    expect(ids("muster")).toEqual([beta.id]);
    expect(ids("office@")).toEqual([alpha.id]);
    expect(ids("wien")).toEqual([alpha.id]);
    expect(ids("K-0003")).toEqual([carla.id]);
    expect(ids("2")).toEqual([beta.id]);
    // LIKE wildcards are matched literally
    expect(ids("%")).toEqual([carla.id]);
    expect(ids("_")).toEqual([carla.id]);
    expect(ids("nothing")).toEqual([]);
  });

  test("archived and country filters, limit", () => {
    const db = createTestDb();
    const [alpha, beta, carla] = seed(db);
    setClientArchived(db, beta.id, true);
    expect(listClients(db).map((c) => c.id)).toEqual([alpha.id, carla.id]);
    expect(listClients(db, { archived: "archived" }).map((c) => c.id)).toEqual([beta.id]);
    expect(listClients(db, { archived: "all" })).toHaveLength(3);
    expect(listClients(db, { country: "de" }).map((c) => c.id)).toEqual([carla.id]);
    expect(listClients(db, { country: "CH" })).toEqual([]);
    expect(listClients(db, { limit: 1 })).toHaveLength(1);
  });
});

describe("update / archive / delete", () => {
  test("update fields and number", () => {
    const db = createTestDb();
    const [alpha, beta] = seed(db);
    const updated = updateClient(db, alpha.id, { city: "Graz", defaultTaxMode: "AT_DOMESTIC", number: 50 });
    expect(updated).toMatchObject({ city: "Graz", defaultTaxMode: "AT_DOMESTIC", number: 50, name: "Alpha GmbH" });
    expect(updateClient(db, alpha.id, { number: 50 }).number).toBe(50); // own number is fine
    expect(statusOf(() => updateClient(db, beta.id, { number: 50 }))).toBe(409);
    expect(statusOf(() => updateClient(db, 999, { city: "x" }))).toBe(404);
  });

  test("archive and unarchive", () => {
    const db = createTestDb();
    const [alpha] = seed(db);
    expect(setClientArchived(db, alpha.id, true).archivedAt).toBeString();
    expect(setClientArchived(db, alpha.id, false).archivedAt).toBeNull();
  });

  test("delete only without documents", () => {
    const db = createTestDb();
    const [alpha, beta] = seed(db);
    db.insert(documents).values({ type: "invoice", clientId: alpha.id, issueDate: "2026-01-01", taxMode: "AT_DOMESTIC" }).run();
    expect(statusOf(() => deleteClient(db, alpha.id))).toBe(409);
    expect(getClient(db, alpha.id)).toBeDefined();
    deleteClient(db, beta.id);
    expect(getClient(db, beta.id)).toBeUndefined();
    expect(statusOf(() => deleteClient(db, beta.id))).toBe(404);
  });
});

test("clientSnapshot", () => {
  const db = createTestDb();
  const [alpha] = seed(db);
  expect(clientSnapshot(alpha)).toEqual({
    clientId: alpha.id,
    number: 1,
    type: "company",
    name: "Alpha GmbH",
    contactPerson: "",
    street: "",
    addressExtra: "",
    zip: "",
    city: "Wien",
    country: "AT",
    uid: "",
    email: "office@alpha.at",
  });
});
