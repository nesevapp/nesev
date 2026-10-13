import { and, asc, count, eq, isNotNull, isNull, max, ne, or, type SQL, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { HTTPException } from "hono/http-exception";
import {
  type ClientCreate,
  type ClientUpdate,
  CLIENT_ARCHIVED_FILTERS,
  formatClientNumber,
  parseClientNumber,
} from "../../shared/schemas/client";
import type { ClientSnapshot } from "../../shared/types";
import type { DbOrTx } from "../db/client";
import { type Client, clients, documents } from "../db/schema";

export interface ClientListFilter {
  q?: string;
  archived?: (typeof CLIENT_ARCHIVED_FILTERS)[number];
  country?: string;
  limit?: number;
}

/** Case-insensitive (ASCII) substring match with %/_ escaped. */
function contains(column: AnySQLiteColumn, term: string): SQL {
  const pattern = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}

function searchCondition(q: string): SQL | undefined {
  const term = q.trim();
  if (!term) return undefined;
  const conditions = [
    contains(clients.name, term),
    contains(clients.contactPerson, term),
    contains(clients.email, term),
    contains(clients.city, term),
  ];
  const number = parseClientNumber(term);
  if (number !== null) conditions.push(eq(clients.number, number));
  return or(...conditions);
}

/** Clients sorted by name. Defaults to active (non-archived) clients. */
export function listClients(db: DbOrTx, filter: ClientListFilter = {}): Client[] {
  const archived = filter.archived ?? "active";
  const where = and(
    filter.q ? searchCondition(filter.q) : undefined,
    archived === "active" ? isNull(clients.archivedAt) : archived === "archived" ? isNotNull(clients.archivedAt) : undefined,
    filter.country ? eq(clients.country, filter.country.toUpperCase()) : undefined,
  );
  const query = db
    .select()
    .from(clients)
    .where(where)
    .orderBy(sql`${clients.name} COLLATE NOCASE`, asc(clients.number));
  return filter.limit ? query.limit(filter.limit).all() : query.all();
}

export function getClient(db: DbOrTx, id: number): Client | undefined {
  return db.select().from(clients).where(eq(clients.id, id)).get();
}

/** Like getClient, but throws a 404 HTTPException when missing. */
export function requireClient(db: DbOrTx, id: number): Client {
  const client = getClient(db, id);
  if (!client) throw new HTTPException(404, { message: "Kunde nicht gefunden" });
  return client;
}

/** max(number) + 1 — client numbers are not gapless, only unique. */
export function nextClientNumber(db: DbOrTx): number {
  const row = db.select({ last: max(clients.number) }).from(clients).get();
  return (row?.last ?? 0) + 1;
}

function assertNumberFree(db: DbOrTx, number: number, exceptId?: number) {
  const taken = db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.number, number), exceptId ? ne(clients.id, exceptId) : undefined))
    .get();
  if (taken) throw new HTTPException(409, { message: `Kundennummer ${formatClientNumber(number)} ist bereits vergeben` });
}

export function createClient(db: DbOrTx, data: ClientCreate): Client {
  return db.transaction((tx) => {
    const { number, ...rest } = data;
    if (number !== undefined) assertNumberFree(tx, number);
    return tx
      .insert(clients)
      .values({ ...rest, number: number ?? nextClientNumber(tx) })
      .returning()
      .get();
  });
}

export function updateClient(db: DbOrTx, id: number, data: ClientUpdate): Client {
  return db.transaction((tx) => {
    requireClient(tx, id);
    if (data.number !== undefined) assertNumberFree(tx, data.number, id);
    if (Object.keys(data).length === 0) return requireClient(tx, id);
    return tx.update(clients).set(data).where(eq(clients.id, id)).returning().get();
  });
}

export function setClientArchived(db: DbOrTx, id: number, archived: boolean): Client {
  const client = requireClient(db, id);
  if (archived === (client.archivedAt !== null)) return client;
  return db
    .update(clients)
    .set({ archivedAt: archived ? new Date().toISOString() : null })
    .where(eq(clients.id, id))
    .returning()
    .get();
}

export function countClientDocuments(db: DbOrTx, id: number): number {
  return db.select({ n: count() }).from(documents).where(eq(documents.clientId, id)).get()?.n ?? 0;
}

/** Deletes a client that no document references; otherwise 409 (archive instead). */
export function deleteClient(db: DbOrTx, id: number): void {
  db.transaction((tx) => {
    requireClient(tx, id);
    const n = countClientDocuments(tx, id);
    if (n > 0) {
      throw new HTTPException(409, {
        message: `Kunde wird in ${n === 1 ? "einem Beleg" : `${n} Belegen`} verwendet und kann nicht gelöscht werden. Bitte stattdessen archivieren.`,
      });
    }
    tx.delete(clients).where(eq(clients.id, id)).run();
  });
}

/** Client data to freeze onto a document at finalize time. */
export function clientSnapshot(c: Client): ClientSnapshot {
  return {
    clientId: c.id,
    number: c.number,
    type: c.type,
    name: c.name,
    contactPerson: c.contactPerson,
    street: c.street,
    addressExtra: c.addressExtra,
    zip: c.zip,
    city: c.city,
    country: c.country,
    uid: c.uid,
    email: c.email,
  };
}
