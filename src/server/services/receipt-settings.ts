import { DEFAULT_OCR_SETTINGS, isLoopbackUrl, type OcrProvider, type OcrSettings } from "../../shared/receipts";
import { ocrSettingsSchema } from "../../shared/schemas/receipt";
import type { DbOrTx } from "../db/client";
import { settings } from "../db/schema";
import { helperStatus, type HelperStatus } from "../lib/ocr/helper";
import { tesseractStatus, type TesseractStatus } from "../lib/ocr/tesseract";
import {
  type FetchFn,
  hasModel,
  LlmError,
  listModels,
  modelMissingMessage,
  type OllamaModel,
  ollamaVersion,
} from "./receipt-ollama";
import { type LlamaCppStatus, llamaCppStatus } from "./receipt-llama";
import { listOpenAiModels, resolveOpenAiModel } from "./receipt-openai";
import { getSettings } from "./settings";

// "Belegerkennung" settings live in settings.ocr_settings (JSON; null → defaults).

export function getOcrSettings(db: DbOrTx): OcrSettings {
  const parsed = ocrSettingsSchema.safeParse(getSettings(db).ocrSettings ?? {});
  return parsed.success ? parsed.data : DEFAULT_OCR_SETTINGS;
}

export function updateOcrSettings(db: DbOrTx, data: OcrSettings): OcrSettings {
  getSettings(db); // creates the singleton row if missing
  db.update(settings).set({ ocrSettings: data }).run();
  return getOcrSettings(db);
}

export interface OllamaStatus {
  url: string;
  reachable: boolean;
  version?: string | null;
  error?: string;
  models: OllamaModel[];
  /** the configured text / vision model is installed */
  modelPresent: boolean;
  visionModelPresent: boolean;
  /** German hint for the active model when it is missing */
  modelHint?: string;
}

export interface OpenAiStatus {
  url: string;
  reachable: boolean;
  error?: string;
  /** ids from GET /v1/models (Unsloth Studio: the models loaded in the app) */
  models: string[];
  /** model an analysis would use now (configured, or the first loaded one) */
  activeModel?: string;
  /** German hint when no / not the configured model is loaded */
  modelHint?: string;
}

export interface ReceiptComponentStatus {
  platform: string;
  helper: HelperStatus;
  tesseract: TesseractStatus;
  provider: OcrProvider;
  /** only the active provider is probed; the others are null */
  ollama: OllamaStatus | null;
  openai: OpenAiStatus | null;
  llamacpp: LlamaCppStatus | null;
}

/** unsaved values from the settings form ("Verbindung testen") */
export interface OcrProbe {
  provider?: OcrProvider;
  url?: string;
  apiKey?: string;
  model?: string;
  /** llama.cpp paths */
  serverPath?: string;
  modelPath?: string;
  mmprojPath?: string;
}

export async function ollamaStatus(config: OcrSettings, url = config.ollamaUrl, fetchFn: FetchFn = fetch): Promise<OllamaStatus> {
  const base = url.replace(/\/+$/, "");
  const empty = { url: base, models: [], modelPresent: false, visionModelPresent: false };
  if (!isLoopbackUrl(base)) return { ...empty, reachable: false, error: "Nur lokale Adressen (localhost / 127.0.0.1) erlaubt" };
  try {
    const models = await listModels(base, fetchFn);
    const active = config.mode === "vision" ? config.visionModel : config.model;
    return {
      ...empty,
      reachable: true,
      version: await ollamaVersion(base, fetchFn),
      models,
      modelPresent: hasModel(models, config.model),
      visionModelPresent: hasModel(models, config.visionModel),
      ...(hasModel(models, active) ? {} : { modelHint: modelMissingMessage(active) }),
    };
  } catch (err) {
    return { ...empty, reachable: false, error: err instanceof LlmError ? err.message : String(err) };
  }
}

export async function openAiStatus(config: OcrSettings, url = config.openaiUrl, fetchFn: FetchFn = fetch): Promise<OpenAiStatus> {
  const base = url.replace(/\/+$/, "");
  if (!isLoopbackUrl(base)) return { url: base, models: [], reachable: false, error: "Nur lokale Adressen (localhost / 127.0.0.1) erlaubt" };
  let models: string[];
  try {
    models = await listOpenAiModels(base, config.openaiApiKey, fetchFn);
  } catch (err) {
    return { url: base, models: [], reachable: false, error: err instanceof LlmError ? err.message : String(err) };
  }
  try {
    return { url: base, models, reachable: true, activeModel: resolveOpenAiModel(models, config.openaiModel) };
  } catch (err) {
    return { url: base, models, reachable: true, modelHint: (err as Error).message };
  }
}

export async function componentStatus(db: DbOrTx, probe: OcrProbe = {}, fetchFn: FetchFn = fetch): Promise<ReceiptComponentStatus> {
  const saved = getOcrSettings(db);
  const provider = probe.provider ?? saved.provider;
  const config: OcrSettings = {
    ...saved,
    provider,
    ...(provider === "openai" && probe.apiKey !== undefined ? { openaiApiKey: probe.apiKey } : {}),
    ...(provider === "openai" && probe.model !== undefined ? { openaiModel: probe.model } : {}),
  };
  const [tesseract, ollama, openai, llamacpp] = await Promise.all([
    tesseractStatus(),
    provider === "ollama" ? ollamaStatus(config, probe.url || config.ollamaUrl, fetchFn) : null,
    provider === "openai" ? openAiStatus(config, probe.url || config.openaiUrl, fetchFn) : null,
    provider === "llamacpp"
      ? llamaCppStatus(config, { serverPath: probe.serverPath, modelPath: probe.modelPath, mmprojPath: probe.mmprojPath })
      : null,
  ]);
  return { platform: process.platform, helper: helperStatus(), tesseract, provider, ollama, openai, llamacpp };
}
