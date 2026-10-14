import { join } from "node:path";
import type { OcrSettings } from "../../shared/receipts";
import { AbortedError } from "../lib/ocr/run";
import {
  BINARY_SOURCE_LABELS,
  type BinarySource,
  discoverModels,
  expandHome,
  findLlamaServer,
  findMmproj,
  type FsDeps,
  type GgufModel,
  modelAlias,
  nodeFs,
} from "../lib/llama/paths";
import {
  configKey,
  defaultDeps,
  installExitHandlers,
  type LlamaConfig,
  type LlamaEndpoint,
  LlamaServerError,
  LlamaServerManager,
  type LlamaServerState,
  reapOrphan,
  unregister,
} from "../lib/llama/server";
import { DATA_DIR } from "../lib/paths";
import { LlmError } from "./receipt-ollama";
import { extractWithOpenAi } from "./receipt-openai";

// llama.cpp provider ("von nesev gestartet"): settings → llama-server config, the process-wide server manager,
// status for the settings page and the explicit "Testen" run. The analysis itself goes through the
// OpenAI-compatible client against the server nesev started (see receipt-pipeline.ts).

export class LlamaCppError extends LlmError {}

export const llamaDownloadHint = () =>
  "Modell herunterladen: in Unsloth Studio laden oder einmal `llama-server -hf unsloth/Qwen3.5-4B-GGUF:Q4_K_M` ausführen (danach mit Strg+C beenden) – die Datei landet in ~/.cache/huggingface/hub";
export const llamaNoModelMessage = () => "Kein Modell gewählt – in den Einstellungen unter Belegerkennung eine GGUF-Datei auswählen";
export const llamaNoVisionMessage = () =>
  "Vision-Modus braucht eine mmproj-Datei (keine neben dem Modell gefunden) – mmproj-Pfad eintragen oder Modus „Text“ wählen";

/** paths from the form that override the saved settings ("Verbindung testen" / "Testen") */
export interface LlamaOverrides {
  serverPath?: string;
  modelPath?: string;
  mmprojPath?: string;
  contextSize?: number;
}

export interface ResolvedLlama {
  binary: { path: string; source: BinarySource } | { path: null; error: string };
  model: string;
  /** configured, or auto-detected next to the model (auto = true) */
  mmproj: string | null;
  mmprojAuto: boolean;
  contextSize: number;
}

export function resolveLlama(settings: OcrSettings, o: LlamaOverrides = {}, fs: FsDeps = nodeFs): ResolvedLlama {
  const model = expandHome(o.modelPath ?? settings.llamaModelPath, fs.home);
  const configuredMmproj = expandHome(o.mmprojPath ?? settings.llamaMmprojPath, fs.home);
  const auto = !configuredMmproj && model ? findMmproj(model, fs) : null;
  return {
    binary: findLlamaServer(o.serverPath ?? settings.llamaServerPath, fs),
    model,
    mmproj: configuredMmproj || auto,
    mmprojAuto: !configuredMmproj && !!auto,
    contextSize: o.contextSize ?? settings.llamaContextSize,
  };
}

/** Config to start llama-server with; throws LlamaCppError (→ rules-only) when something is missing. */
export function llamaConfigFor(settings: OcrSettings, o: LlamaOverrides = {}, fs: FsDeps = nodeFs): LlamaConfig {
  const r = resolveLlama(settings, o, fs);
  if (r.binary.path === null) throw new LlamaCppError(r.binary.error, "unreachable");
  if (!r.model) throw new LlamaCppError(llamaNoModelMessage(), "model_missing");
  if (!fs.isFile(r.model)) throw new LlamaCppError(`Modelldatei nicht gefunden: ${r.model}`, "model_missing");
  if (settings.mode === "vision" && !r.mmproj) throw new LlamaCppError(llamaNoVisionMessage(), "no_vision");
  // text mode never loads the projector (saves memory and load time)
  return { binary: r.binary.path, model: r.model, mmproj: settings.mode === "vision" ? r.mmproj : null, contextSize: r.contextSize };
}

/** The manager's errors as LlmError (rules-only result with a German warning). */
export function toLlmError(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  if (err instanceof LlamaServerError) return new LlamaCppError(err.message, err.kind === "model_missing" ? "model_missing" : "unreachable");
  if (err instanceof AbortedError) return new LlamaCppError("llama-server wurde gestoppt (Einstellungen geändert?)", "unreachable");
  return new LlamaCppError(`llama-server: ${(err as Error).message}`, "unreachable");
}

// --- process-wide server -----------------------------------------------------------------------------------

const MANAGER_KEY = Symbol.for("nesev.llamaServer");

/** The worker's llama-server (one per process, kept across `bun --hot` reloads). */
export function getLlamaServer(): LlamaServerManager {
  const g = globalThis as { [MANAGER_KEY]?: LlamaServerManager };
  if (!g[MANAGER_KEY]) {
    const pidFile = join(DATA_DIR, "llama-server.pid");
    installExitHandlers();
    g[MANAGER_KEY] = new LlamaServerManager(defaultDeps(pidFile));
    void reapOrphan(pidFile).then((pid) => {
      if (pid) console.log(`llama-server ${pid} einer früheren nesev-Instanz gestoppt`);
    });
  }
  return g[MANAGER_KEY];
}

/** A running server that no longer matches the settings is stopped (unless a batch is using it). */
export async function syncLlamaServer(settings: OcrSettings, workerBusy: boolean, manager = getLlamaServer()): Promise<void> {
  const active = manager.activeKey();
  if (!active || workerBusy) return;
  let wanted: string | null = null;
  if (settings.llmEnabled && settings.provider === "llamacpp") {
    try {
      wanted = configKey(llamaConfigFor(settings));
    } catch {
      wanted = null;
    }
  }
  if (wanted !== active) await manager.stop();
}

// --- status ------------------------------------------------------------------------------------------------

export interface LlamaCppStatus {
  binary: { path: string | null; source: string | null; version: string | null; error?: string };
  model: { path: string; label: string; exists: boolean; sizeBytes: number | null; hint?: string };
  mmproj: { path: string | null; auto: boolean; exists: boolean };
  /** the vision mode can run (a projector is available) */
  vision: boolean;
  contextSize: number;
  server: LlamaServerState;
  /** GGUFs found on disk (count; the list comes from GET /llamacpp/models) */
  discovered: number;
}

const versionCache = new Map<string, { mtime: number; version: string | null }>();

/** First "version: …" line of `llama-server --version` (cached per binary + mtime). */
export async function llamaVersion(binary: string): Promise<string | null> {
  const mtime = Bun.file(binary).lastModified;
  const cached = versionCache.get(binary);
  if (cached?.mtime === mtime) return cached.version;
  let version: string | null = null;
  try {
    const proc = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    version = /version:\s*(.+)/.exec(`${out}\n${err}`)?.[1]?.trim() ?? null;
  } catch {
    version = null;
  }
  versionCache.set(binary, { mtime, version });
  return version;
}

export async function llamaCppStatus(
  settings: OcrSettings,
  o: LlamaOverrides = {},
  fs: FsDeps = nodeFs,
  manager: LlamaServerManager = getLlamaServer(),
  models: GgufModel[] = discoverModels(fs),
): Promise<LlamaCppStatus> {
  const r = resolveLlama(settings, o, fs);
  const exists = !!r.model && fs.isFile(r.model);
  const hint = !r.model ? (models.length ? llamaNoModelMessage() : llamaDownloadHint()) : !exists ? `Datei nicht gefunden – ${llamaDownloadHint()}` : undefined;
  return {
    binary:
      r.binary.path === null
        ? { path: null, source: null, version: null, error: r.binary.error }
        : { path: r.binary.path, source: BINARY_SOURCE_LABELS[r.binary.source], version: await llamaVersion(r.binary.path) },
    model: { path: r.model, label: r.model ? modelAlias(r.model) : "", exists, sizeBytes: exists ? fs.size(r.model) : null, ...(hint ? { hint } : {}) },
    mmproj: { path: r.mmproj, auto: r.mmprojAuto, exists: !!r.mmproj && fs.isFile(r.mmproj) },
    vision: !!r.mmproj && fs.isFile(r.mmproj),
    contextSize: r.contextSize,
    server: manager.state(),
    discovered: models.length,
  };
}

// --- explicit test ("Testen" in the settings) ---------------------------------------------------------------

const SAMPLE_RECEIPT = `Musterbau GmbH
Hauptstraße 1, 1010 Wien
UID: ATU12345675
Rechnung Nr. 2026-042   Datum: 03.10.2026
1 x Druckerpapier A4  20,00
Netto 20,00  USt 20 % 4,00
Gesamt EUR 24,00`;

export interface LlamaTestResult {
  model: string;
  version: string | null;
  port: number;
  /** server start incl. model load */
  startMs: number;
  /** one extraction of a short sample receipt */
  extractMs: number;
  supplierName: string | null;
  grossCents: number | null;
}

/**
 * Starts a separate llama-server, extracts a sample receipt and stops it again. Only on explicit click; the
 * worker's server is untouched (the caller refuses while a batch runs).
 */
export async function testLlama(settings: OcrSettings, o: LlamaOverrides, signal?: AbortSignal): Promise<LlamaTestResult> {
  const config = llamaConfigFor({ ...settings, mode: "text" }, o);
  installExitHandlers();
  const manager = new LlamaServerManager(defaultDeps(null));
  try {
    let endpoint: LlamaEndpoint;
    try {
      endpoint = await manager.ensure(config, signal);
    } catch (err) {
      throw toLlmError(err);
    }
    const res = await extractWithOpenAi({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: endpoint.model,
      text: SAMPLE_RECEIPT,
      signal,
      timeoutMs: 120_000,
    });
    return {
      model: endpoint.model,
      version: await llamaVersion(config.binary),
      port: endpoint.port,
      startMs: endpoint.startMs,
      extractMs: res.durationMs,
      supplierName: res.fields.supplierName?.value ?? null,
      grossCents: res.fields.grossCents?.value ?? null,
    };
  } finally {
    await manager.stop();
    unregister(manager);
  }
}
