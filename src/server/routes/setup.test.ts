import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDataDir } from "../lib/data-location";
import setup, { setSetupCompleteHook } from "./setup";

// The setup routes read NESEV_CONFIG_DIR at request time; nothing here opens a DB.
let root: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nesev-setup-"));
  saved = { NESEV_CONFIG_DIR: process.env.NESEV_CONFIG_DIR, NESEV_DATA_DIR: process.env.NESEV_DATA_DIR };
  process.env.NESEV_CONFIG_DIR = join(root, "cfg");
  delete process.env.NESEV_DATA_DIR;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  setSetupCompleteHook(null);
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  setup.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /complete", () => {
  test("a new folder is resolved as the data dir by the time the app loads", async () => {
    const dir = join(root, "books");
    let resolvedInHook: ReturnType<typeof resolveDataDir> | undefined;
    setSetupCompleteHook(async () => {
      resolvedInHook = resolveDataDir();
    });
    const res = await post("/complete", { path: dir });
    expect(res.status).toBe(200);
    expect(resolvedInHook).toEqual({ dir, source: "config" });
    expect(existsSync(join(dir, "nesev.db"))).toBe(true);
  });

  test("409 once set up, 400 for an unusable path", async () => {
    expect((await post("/complete", { path: join(root, "x") })).status).toBe(409);
    setSetupCompleteHook(async () => {});
    expect((await post("/complete", { path: "relative" })).status).toBe(400);
  });
});

describe("GET /status", () => {
  test("not configured → suggestions; configured folder gone → missingDataDir", async () => {
    let s = (await (await setup.request("/status")).json()) as { configured: boolean; missingDataDir: string | null };
    expect(s.configured).toBe(false);
    expect(s.missingDataDir).toBeNull();
    setSetupCompleteHook(async () => {});
    const dir = join(root, "books");
    await post("/complete", { path: dir });
    rmSync(dir, { recursive: true });
    s = (await (await setup.request("/status")).json()) as typeof s;
    expect(s).toMatchObject({ configured: false, missingDataDir: dir });
  });
});
