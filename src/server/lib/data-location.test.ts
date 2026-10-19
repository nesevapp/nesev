import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDataDir,
  cloudSyncWarning,
  configDir,
  inspectDataDir,
  missingDataDir,
  readConfig,
  resolveDataDir,
  writeConfig,
} from "./data-location";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "nesev-dataloc-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("configDir / appDataDir", () => {
  test("follow the OS conventions", () => {
    expect(configDir({}, "darwin", "/Users/a")).toBe("/Users/a/Library/Application Support/nesev");
    expect(configDir({}, "linux", "/home/a")).toBe("/home/a/.config/nesev");
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/a")).toBe("/x/nesev");
    expect(configDir({ NESEV_CONFIG_DIR: "/c" }, "darwin", "/Users/a")).toBe("/c");
    expect(appDataDir({}, "darwin", "/Users/a")).toBe("/Users/a/Library/Application Support/nesev/Daten");
    expect(appDataDir({}, "linux", "/home/a")).toBe("/home/a/.local/share/nesev");
  });
});

describe("resolveDataDir", () => {
  test("env beats config beats the checkout's data dir", () => {
    const root = tmp();
    const file = join(root, "cfg", "config.json");
    const checkout = join(root, "checkout-data");
    mkdirSync(checkout);
    expect(resolveDataDir({ env: {}, file, checkoutDir: checkout })).toBeNull();
    writeFileSync(join(checkout, "nesev.db"), "");
    expect(resolveDataDir({ env: {}, file, checkoutDir: checkout })).toEqual({ dir: checkout, source: "checkout" });
    writeConfig({ dataDir: join(root, "books") }, file);
    // configured, but the folder has no database (moved / drive not connected): back to the setup
    expect(resolveDataDir({ env: {}, file, checkoutDir: checkout })).toBeNull();
    expect(missingDataDir({}, file)).toBe(join(root, "books"));
    mkdirSync(join(root, "books"));
    writeFileSync(join(root, "books", "nesev.db"), "");
    expect(missingDataDir({}, file)).toBeNull();
    expect(resolveDataDir({ env: {}, file, checkoutDir: checkout })).toEqual({ dir: join(root, "books"), source: "config" });
    expect(resolveDataDir({ env: { NESEV_DATA_DIR: join(root, "env") }, file, checkoutDir: checkout })).toEqual({
      dir: join(root, "env"),
      source: "env",
    });
  });

  test("NESEV_CONFIG_DIR disables the checkout fallback", () => {
    const root = tmp();
    expect(resolveDataDir({ env: { NESEV_CONFIG_DIR: join(root, "cfg") } })).toBeNull();
  });

  test("ignores a broken or relative config", () => {
    const root = tmp();
    const file = join(root, "config.json");
    writeFileSync(file, "{nope");
    expect(readConfig(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ dataDir: "relative/dir" }));
    expect(resolveDataDir({ env: {}, file, checkoutDir: null })).toBeNull();
  });

  test("writeConfig merges", () => {
    const file = join(tmp(), "config.json");
    writeFileSync(file, JSON.stringify({ other: 1 }));
    writeConfig({ dataDir: "/books" }, file);
    expect(readConfig(file)).toEqual({ other: 1, dataDir: "/books" } as never);
  });
});

describe("inspectDataDir", () => {
  test("new folder below a writable parent is ok", () => {
    const root = tmp();
    const r = inspectDataDir(join(root, "a", "b"), "linux", root);
    expect(r).toMatchObject({ ok: true, exists: false, hasData: false, error: null });
  });

  test("expands ~ and refuses relative paths", () => {
    const home = tmp();
    expect(inspectDataDir("~/nesev", "linux", home).path).toBe(join(home, "nesev"));
    expect(inspectDataDir("nesev", "linux", home)).toMatchObject({ ok: false });
    expect(inspectDataDir("  ", "linux", home)).toMatchObject({ ok: false });
  });

  test("existing data, non-empty folder, file", () => {
    const root = tmp();
    const withData = join(root, "books");
    mkdirSync(withData);
    writeFileSync(join(withData, "nesev.db"), "");
    expect(inspectDataDir(withData, "linux", root)).toMatchObject({ ok: true, hasData: true, warnings: [] });

    const busy = join(root, "busy");
    mkdirSync(busy);
    writeFileSync(join(busy, "Urlaub.jpg"), "");
    const r = inspectDataDir(busy, "linux", root);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(" ")).toContain("nicht leer");

    const file = join(root, "file.txt");
    writeFileSync(file, "");
    expect(inspectDataDir(file, "linux", root)).toMatchObject({ ok: false, error: "Das ist eine Datei, kein Ordner." });
  });
});

describe("cloudSyncWarning", () => {
  test("flags common sync folders", () => {
    const home = tmp();
    expect(cloudSyncWarning(join(home, "Dropbox", "nesev"), "linux", home)).not.toBeNull();
    expect(cloudSyncWarning(join(home, "Library", "CloudStorage", "OneDrive-X", "nesev"), "darwin", home)).not.toBeNull();
    expect(cloudSyncWarning(join(home, "nesev"), "linux", home)).toBeNull();
  });

  test("~/Documents only when iCloud Desktop & Documents is on", () => {
    const home = tmp();
    expect(cloudSyncWarning(join(home, "Documents", "nesev"), "darwin", home)).toBeNull();
    mkdirSync(join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents"), { recursive: true });
    expect(cloudSyncWarning(join(home, "Documents", "nesev"), "darwin", home)).not.toBeNull();
  });
});
