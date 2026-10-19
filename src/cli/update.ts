import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { compareVersions } from "./version";

// `nesev update`: replaces the running release binary with the latest GitHub release for this platform.
// Release assets (scripts/build-binary.ts): nesev-<os>-<arch>.tar.gz (contains `nesev`), SHA256SUMS, VERSION.
// NESEV_RELEASE_URL overrides where they come from (tests: a local HTTP server).

export const DEFAULT_RELEASE_URL = "https://github.com/nesevapp/nesev/releases/latest/download";

export function releaseBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return (env.NESEV_RELEASE_URL || DEFAULT_RELEASE_URL).replace(/\/+$/, "");
}

/** Release target of this machine, e.g. "darwin-arm64"; null if there's no release build for it. */
export function releaseTarget(platform = process.platform, arch = process.arch): string | null {
  if (platform !== "darwin" && platform !== "linux") return null;
  if (arch !== "arm64" && arch !== "x64") return null;
  return `${platform}-${arch}`;
}

export const assetName = (target: string) => `nesev-${target}.tar.gz`;

/** SHA256SUMS lines ("<hex>  <file>" or "<hex> *<file>") → file → hash */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) sums.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return sums;
}

export function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Download fehlgeschlagen (HTTP ${res.status}): ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function latestVersion(base = releaseBaseUrl()): Promise<string> {
  const text = new TextDecoder().decode(await download(`${base}/VERSION`)).trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+/.test(text)) throw new Error(`Unerwartete Versionsangabe: ${text.slice(0, 40)}`);
  return text;
}

export interface UpdateResult {
  from: string;
  to: string;
  updated: boolean;
}

/**
 * Downloads the latest release, verifies its SHA-256 against SHA256SUMS, checks that the new binary runs
 * (`--version`) and atomically replaces `binaryPath` (rename in the same directory).
 */
export async function updateBinary(o: {
  current: string;
  binaryPath: string;
  force?: boolean;
  checkOnly?: boolean;
  base?: string;
  target?: string | null;
  log?: (msg: string) => void;
}): Promise<UpdateResult> {
  const log = o.log ?? (() => {});
  const base = o.base ?? releaseBaseUrl();
  const target = o.target === undefined ? releaseTarget() : o.target;
  if (!target) throw new Error(`Für ${process.platform}-${process.arch} gibt es keine fertige nesev-Version.`);
  const latest = await latestVersion(base);
  const newer = compareVersions(latest, o.current) > 0;
  if (o.checkOnly || (!newer && !o.force)) return { from: o.current, to: latest, updated: false };

  const asset = assetName(target);
  log(`Lade nesev ${latest} (${asset}) …`);
  const [sumsBytes, archive] = await Promise.all([download(`${base}/SHA256SUMS`), download(`${base}/${asset}`)]);
  const expected = parseSums(new TextDecoder().decode(sumsBytes)).get(asset);
  if (!expected) throw new Error(`${asset} fehlt in SHA256SUMS.`);
  const actual = sha256(archive);
  if (actual !== expected) throw new Error(`Prüfsumme stimmt nicht (${asset}): erwartet ${expected}, erhalten ${actual}. Nichts geändert.`);

  const work = mkdtempSync(join(tmpdir(), "nesev-update-"));
  try {
    const archivePath = join(work, asset);
    writeFileSync(archivePath, archive);
    const untar = spawnSync("tar", ["-xzf", archivePath, "-C", work], { encoding: "utf8" });
    if (untar.status !== 0) throw new Error(`Entpacken fehlgeschlagen: ${untar.stderr}`);
    const extracted = join(work, "nesev");
    if (!existsSync(extracted)) throw new Error(`${asset} enthält keine Datei „nesev“.`);
    chmodSync(extracted, 0o755);
    if (process.platform === "darwin") spawnSync("xattr", ["-d", "com.apple.quarantine", extracted], { stdio: "ignore" });
    const check = spawnSync(extracted, ["--version"], { encoding: "utf8", timeout: 60_000 });
    if (check.status !== 0) throw new Error(`Die neue Version startet nicht: ${check.stderr || check.error?.message || ""}`.trim());

    // copy next to the target first, so the final rename is atomic (same file system)
    const staged = join(dirname(o.binaryPath), `.${basename(o.binaryPath)}.update-${process.pid}`);
    try {
      copyFileSync(extracted, staged);
      chmodSync(staged, 0o755);
      renameSync(staged, o.binaryPath);
    } catch (err) {
      rmSync(staged, { force: true });
      throw new Error(`Konnte ${o.binaryPath} nicht ersetzen: ${(err as Error).message}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { from: o.current, to: latest, updated: true };
}
