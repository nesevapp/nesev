import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../paths";
import { CommandError, runCommand } from "./run";

// The Swift helper (nesev-ocr.swift: PDF text layer, Apple Vision OCR, page rendering) is compiled once
// with swiftc into <DATA_DIR>/bin/nesev-ocr-<source hash>; a changed source gets a fresh binary.

const SOURCE = join(import.meta.dir, "nesev-ocr.swift");

export interface HelperStatus {
  /** macOS with swiftc installed */
  available: boolean;
  compiled: boolean;
  path: string | null;
  error?: string;
}

function sourceHash(): string {
  return Bun.hash(readFileSync(SOURCE)).toString(16).padStart(16, "0").slice(0, 12);
}

function binDir(dataDir: string) {
  return join(dataDir, "bin");
}

export function helperPath(dataDir = DATA_DIR): string {
  return join(binDir(dataDir), `nesev-ocr-${sourceHash()}`);
}

export function helperAvailable(): boolean {
  return process.platform === "darwin" && !!Bun.which("swiftc");
}

export function helperStatus(dataDir = DATA_DIR): HelperStatus {
  const path = helperPath(dataDir);
  const compiled = existsSync(path);
  if (compiled) return { available: true, compiled, path };
  if (process.platform !== "darwin") return { available: false, compiled, path: null, error: "Nur unter macOS verfügbar" };
  if (!Bun.which("swiftc")) {
    return { available: false, compiled, path: null, error: "swiftc fehlt – Xcode Command Line Tools installieren" };
  }
  return { available: true, compiled, path: null };
}

let building: Promise<string> | null = null;

/** Path of the compiled helper; compiles it first if needed (takes a few seconds once). */
export function ensureHelper(dataDir = DATA_DIR): Promise<string> {
  const path = helperPath(dataDir);
  if (existsSync(path)) return Promise.resolve(path);
  const status = helperStatus(dataDir);
  if (!status.available) return Promise.reject(new CommandError(status.error ?? "OCR-Helfer nicht verfügbar"));
  building ??= (async () => {
    mkdirSync(binDir(dataDir), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      await runCommand(["swiftc", "-O", SOURCE, "-o", tmp], { timeoutMs: 300_000 });
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new CommandError(`OCR-Helfer konnte nicht kompiliert werden: ${(err as Error).message}`);
    }
    renameSync(tmp, path);
    // drop binaries of older sources
    for (const f of readdirSync(binDir(dataDir))) {
      if (f.startsWith("nesev-ocr-") && join(binDir(dataDir), f) !== path) rmSync(join(binDir(dataDir), f), { force: true });
    }
    return path;
  })().finally(() => {
    building = null;
  });
  return building;
}

export interface HelperTextResult {
  pageCount: number;
  pages: string[];
}

export interface OcrObservation {
  text: string;
  confidence: number;
  /** normalized [x, y, w, h], origin top-left */
  box: [number, number, number, number];
}

export interface HelperOcrResult {
  engine: "vision";
  pageCount: number;
  pages: { page: number; width: number; height: number; lines: OcrObservation[] }[];
}

export interface HelperRenderResult {
  pageCount: number;
  files: string[];
}

export async function runHelper<T>(
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number; dataDir?: string } = {},
): Promise<T> {
  const bin = await ensureHelper(opts.dataDir);
  const out = await runCommand([bin, ...args], opts);
  return JSON.parse(out) as T;
}
