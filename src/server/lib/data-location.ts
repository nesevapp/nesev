import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, type Stats, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { APP_ROOT } from "./app-files";

// Where the user's books live. Resolved once per process, in this order:
//   1. NESEV_DATA_DIR (demo, tests, eval, experiments, power users)
//   2. "dataDir" in the per-user config file (written by the first-start setup), see configFile()
//   3. <checkout>/data if it already holds a database (installs from before the setup existed, dev checkouts);
//      skipped when NESEV_CONFIG_DIR is set, so experiments with their own config dir never pick up real data
// Nothing found → the server starts in setup mode and asks (server/setup.ts). No side effects on import.

export type DataDirSource = "env" | "config" | "checkout";
export interface ResolvedDataDir {
  dir: string;
  source: DataDirSource;
}

type Env = Record<string, string | undefined>;

/** Per-user config dir (not the data dir): NESEV_CONFIG_DIR, else the OS convention. */
export function configDir(env: Env = process.env, platform = process.platform, home = homedir()): string {
  if (env.NESEV_CONFIG_DIR) return resolve(env.NESEV_CONFIG_DIR);
  if (platform === "darwin") return join(home, "Library", "Application Support", "nesev");
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "nesev");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "nesev");
}

export function configFile(env: Env = process.env, platform = process.platform, home = homedir()): string {
  return join(configDir(env, platform, home), "config.json");
}

/** The app-data location offered first in the setup (hidden from casual browsing, not cloud-synced by default). */
export function appDataDir(env: Env = process.env, platform = process.platform, home = homedir()): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "nesev", "Daten");
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "nesev", "Daten");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "nesev");
}

/** ~/Documents/nesev (visible in Finder/Explorer, but often synced by iCloud/OneDrive, see cloudSyncWarning). */
export function documentsDataDir(home = homedir()): string {
  return join(home, "Documents", "nesev");
}

/** The checkout's data/ folder (only meaningful when running from source). */
export const CHECKOUT_DATA_DIR = join(APP_ROOT, "data");

interface NesevConfig {
  dataDir?: string;
}

export function readConfig(file = configFile()): NesevConfig {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as NesevConfig) : {};
  } catch {
    return {};
  }
}

/** Merges `patch` into the config file (atomic write). */
export function writeConfig(patch: NesevConfig, file = configFile()): void {
  const next = { ...readConfig(file), ...patch };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, file);
}

export function resolveDataDir(
  {
    env = process.env,
    file = configFile(env),
    checkoutDir = env.NESEV_CONFIG_DIR ? null : CHECKOUT_DATA_DIR,
  }: { env?: Env; file?: string; checkoutDir?: string | null } = {},
): ResolvedDataDir | null {
  if (env.NESEV_DATA_DIR) return { dir: resolve(env.NESEV_DATA_DIR), source: "env" };
  const configured = readConfig(file).dataDir;
  if (configured && isAbsolute(configured)) return { dir: resolve(configured), source: "config" };
  if (checkoutDir && existsSync(join(checkoutDir, "nesev.db"))) return { dir: checkoutDir, source: "checkout" };
  return null;
}

/** "~/x" → absolute; relative paths are refused by the caller (they'd depend on the server's cwd). */
export function expandHome(input: string, home = homedir()): string {
  const t = input.trim();
  if (t === "~") return home;
  if (t.startsWith("~/") || t.startsWith("~\\")) return join(home, t.slice(2));
  return t;
}

const CLOUD_MARKERS = [
  /[\\/]Library[\\/]Mobile Documents[\\/]/i,
  /[\\/]Library[\\/]CloudStorage[\\/]/i,
  /[\\/](Dropbox|OneDrive|Google Drive|GoogleDrive|iCloudDrive|Nextcloud|ownCloud)([\\/ -]|$)/i,
];

/**
 * A warning (German, for the setup UI) if `dir` looks like it's synced by a cloud client. Syncing a live SQLite
 * database (with its -wal/-shm files) can corrupt it. On macOS, ~/Documents counts when iCloud "Desktop & Documents"
 * is on (it then shows up under ~/Library/Mobile Documents/com~apple~CloudDocs/Documents).
 */
export function cloudSyncWarning(dir: string, platform = process.platform, home = homedir()): string | null {
  const abs = resolve(dir);
  const synced =
    CLOUD_MARKERS.some((re) => re.test(abs + "/")) ||
    (platform === "darwin" &&
      (abs === join(home, "Documents") || abs.startsWith(join(home, "Documents") + "/") ||
        abs === join(home, "Desktop") || abs.startsWith(join(home, "Desktop") + "/")) &&
      existsSync(join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents")));
  return synced
    ? "Dieser Ordner wird anscheinend mit einer Cloud synchronisiert (iCloud, OneDrive, Dropbox …). Eine laufende Datenbank kann dabei beschädigt werden. Besser einen Ordner ohne Sync wählen und Backups separat sichern."
    : null;
}

export interface DataDirCheck {
  /** absolute, normalized path */
  path: string;
  exists: boolean;
  /** already holds a nesev database (nesev.db) – choosing it continues with that data */
  hasData: boolean;
  /** usable as data dir (error is null) */
  ok: boolean;
  error: string | null;
  warnings: string[];
}

/** Checks a folder the user typed or picked in the setup (German messages for the UI). Creates nothing. */
export function inspectDataDir(input: string, platform = process.platform, home = homedir()): DataDirCheck {
  const raw = expandHome(input, home);
  const result = (over: Partial<DataDirCheck>): DataDirCheck => ({
    path: raw,
    exists: false,
    hasData: false,
    ok: false,
    error: null,
    warnings: [],
    ...over,
  });
  if (!raw) return result({ error: "Bitte einen Ordner angeben." });
  if (!isAbsolute(raw)) return result({ error: "Bitte den vollständigen Pfad angeben (z. B. /Users/name/nesev oder ~/nesev)." });
  const path = resolve(raw);
  const warnings: string[] = [];
  const cloud = cloudSyncWarning(path, platform, home);
  if (cloud) warnings.push(cloud);
  let info: Stats | null = null;
  try {
    info = statSync(path);
  } catch {}
  if (info && !info.isDirectory()) return result({ path, exists: true, error: "Das ist eine Datei, kein Ordner." });
  if (!info) {
    // created on confirm: the nearest existing parent must be writable
    let parent = dirname(path);
    while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
    if (!writable(parent)) return result({ path, error: `Keine Schreibrechte in ${parent}.`, warnings });
    return result({ path, ok: true, warnings });
  }
  if (!writable(path)) return result({ path, exists: true, error: "Keine Schreibrechte in diesem Ordner.", warnings });
  const hasData = existsSync(join(path, "nesev.db"));
  if (!hasData) {
    const entries = readdirSync(path).filter((e) => !e.startsWith("."));
    if (entries.length > 0)
      warnings.push(
        "Der Ordner ist nicht leer. nesev legt darin seine Dateien an (nesev.db, pdfs/, receipts/ …). Übersichtlicher ist ein eigener, leerer Ordner, z. B. ein Unterordner „nesev“.",
      );
  }
  return result({ path, exists: true, hasData, ok: true, warnings });
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
