import { DEFAULT_OCR_SETTINGS, type OcrSettings } from "../../shared/receipts";
import { ocrSettingsSchema } from "../../shared/schemas/receipt";
import type { DbOrTx } from "../db/client";
import { settings } from "../db/schema";
import { helperStatus, type HelperStatus } from "../lib/ocr/helper";
import { tesseractStatus, type TesseractStatus } from "../lib/ocr/tesseract";
import { type LlamaCppStatus, llamaCppStatus } from "./receipt-llama";
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

export interface ReceiptComponentStatus {
  platform: string;
  helper: HelperStatus;
  tesseract: TesseractStatus;
  llamacpp: LlamaCppStatus;
}

/** unsaved llama.cpp paths from the settings form ("Verbindung testen"; empty = auto) */
export interface OcrProbe {
  serverPath?: string;
  modelPath?: string;
  mmprojPath?: string;
}

export async function componentStatus(db: DbOrTx, probe: OcrProbe = {}): Promise<ReceiptComponentStatus> {
  const [tesseract, llamacpp] = await Promise.all([tesseractStatus(), llamaCppStatus(getOcrSettings(db), probe)]);
  return { platform: process.platform, helper: helperStatus(), tesseract, llamacpp };
}
