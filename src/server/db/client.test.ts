import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "./client";

const dir = mkdtempSync(join(tmpdir(), "nesev-db-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("createDb transactions", () => {
  test("read-then-write transaction survives a commit from a second connection (no SQLITE_BUSY_SNAPSHOT)", () => {
    const path = join(dir, "two.db");
    const a = createDb(path);
    const b = createDb(path);
    a.run(sql`create table t (x integer)`);
    a.run(sql`insert into t values (1)`);

    let otherErr: unknown = null;
    const count = a.transaction((tx) => {
      const n = tx.all<{ n: number }>(sql`select count(*) as n from t`)[0]!.n;
      // the other process tries to commit in between: with IMMEDIATE it has to wait (and times out quickly here)
      try {
        b.$client.exec("PRAGMA busy_timeout = 50;");
        b.run(sql`insert into t values (2)`);
      } catch (e) {
        otherErr = e;
      }
      tx.run(sql`insert into t values (${n + 10})`);
      return n;
    });
    expect(count).toBe(1);
    expect(String((otherErr as { cause?: unknown } | null)?.cause)).toContain("locked");
    // after the commit, the other connection writes fine
    b.run(sql`insert into t values (2)`);
    expect(a.all<{ n: number }>(sql`select count(*) as n from t`)[0]!.n).toBe(3);
  });

  test("an explicit behavior still wins and nested transactions use savepoints", () => {
    const d = createDb(join(dir, "nested.db"));
    d.run(sql`create table t (x integer)`);
    d.transaction((tx) => {
      tx.run(sql`insert into t values (1)`);
      expect(() =>
        tx.transaction((inner) => {
          inner.run(sql`insert into t values (2)`);
          throw new Error("rollback inner");
        }),
      ).toThrow("rollback inner");
    });
    d.transaction(() => {}, { behavior: "deferred" });
    expect(d.all<{ x: number }>(sql`select x from t`)).toEqual([{ x: 1 }]);
  });
});
