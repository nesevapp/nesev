import { DEFAULT_OCR_SETTINGS, isLoopbackUrl, type OcrSettings } from "../../shared/receipts";
import { ocrSettingsSchema } from "../../shared/schemas/receipt";
import type { DbOrTx } from "../db/client";
import { settings } from "../db/schema";
import { helperStatus, type HelperStatus } from "../lib/ocr/helper";
import { tesseractStatus, type TesseractStatus } from "../lib/ocr/tesseract";
import {
  type FetchFn,
  hasModel,
  listModels,
  modelMissingMessage,
  OllamaError,
  type OllamaModel,
  ollamaVersion,
} from "./receipt-ollama";
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

export interface ReceiptComponentStatus {
  platform: string;
  helper: HelperStatus;
  tesseract: TesseractStatus;
  ollama: OllamaStatus;
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
    return { ...empty, reachable: false, error: err instanceof OllamaError ? err.message : String(err) };
  }
}

export async function componentStatus(db: DbOrTx, ollamaUrl?: string): Promise<ReceiptComponentStatus> {
  const config = getOcrSettings(db);
  const [tesseract, ollama] = await Promise.all([tesseractStatus(), ollamaStatus(config, ollamaUrl || config.ollamaUrl)]);
  return { platform: process.platform, helper: helperStatus(), tesseract, ollama };
}
