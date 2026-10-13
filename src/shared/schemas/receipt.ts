import { z } from "./zod";
import { DEFAULT_OCR_SETTINGS, isLoopbackUrl, OCR_ENGINES, OCR_MODES } from "../receipts";

const modelName = z
  .string()
  .trim()
  .min(1, "Modellname fehlt")
  .max(100)
  .regex(/^[A-Za-z0-9._:/-]+$/, "Ungültiger Modellname");

/** PUT /api/receipts/settings; also parses the stored JSON (missing keys → defaults). */
export const ocrSettingsSchema = z.object({
  llmEnabled: z.boolean().default(DEFAULT_OCR_SETTINGS.llmEnabled),
  ollamaUrl: z
    .string()
    .trim()
    .max(200)
    .transform((s) => s.replace(/\/+$/, ""))
    .refine(isLoopbackUrl, "Nur lokale Adressen (localhost / 127.0.0.1) – Belege verlassen den Rechner nicht")
    .default(DEFAULT_OCR_SETTINGS.ollamaUrl),
  mode: z.enum(OCR_MODES).default(DEFAULT_OCR_SETTINGS.mode),
  model: modelName.default(DEFAULT_OCR_SETTINGS.model),
  visionModel: modelName.default(DEFAULT_OCR_SETTINGS.visionModel),
  ocrEngine: z.enum(OCR_ENGINES).default(DEFAULT_OCR_SETTINGS.ocrEngine),
  unloadAfterBatch: z.boolean().default(DEFAULT_OCR_SETTINGS.unloadAfterBatch),
});

export const analyzeRequestSchema = z.object({
  expenseIds: z.array(z.number().int().positive()).min(1).max(500),
});

export const ollamaProbeQuerySchema = z.object({
  /** test an unsaved URL from the settings form */
  ollamaUrl: z.string().trim().max(200).optional(),
});

export type OcrSettingsInput = z.input<typeof ocrSettingsSchema>;
export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;
