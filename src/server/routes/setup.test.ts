import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, resolveDataDir } from "../lib/data-location";
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

  test("stores the update-check choice", async () => {
    setSetupCompleteHook(async () => {});
    await post("/complete", { path: join(root, "books"), updateCheck: false });
    expect(readConfig(join(root, "cfg", "config.json")).updateCheck).toBe(false);
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

describe("POST /restore", () => {
  const upload = (path: string, file: File) => {
    const form = new FormData();
    form.set("path", path);
    form.set("file", file);
    return setup.request("/restore", { method: "POST", body: form });
  };

  test("refuses a non-backup and a folder that already has data; nothing is configured", async () => {
    setSetupCompleteHook(async () => {});
    const res = await upload(join(root, "books"), new File(["nope"], "x.zip"));
    expect(res.status).toBe(422);
    expect(resolveDataDir()).toBeNull();

    const withData = join(root, "existing");
    await post("/complete", { path: withData });
    setSetupCompleteHook(async () => {});
    expect((await upload(withData, new File(["nope"], "x.zip"))).status).toBe(400);
  });
});
