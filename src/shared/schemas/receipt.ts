import { z } from "./zod";
import { DEFAULT_OCR_SETTINGS, OCR_ENGINES, OCR_MODES } from "../receipts";

/** empty, absolute ("/…") or home-relative ("~/…") local file path */
const localPath = (ext?: RegExp, message = "Ungültiger Pfad") =>
  z
    .string()
    .trim()
    .max(1000)
    .refine((s) => s === "" || ((s.startsWith("/") || s.startsWith("~/")) && !s.includes("\0")), "Absoluter Pfad erwartet (/… oder ~/…)")
    .refine((s) => s === "" || !ext || ext.test(s), message);

const GGUF = /\.gguf$/i;

/**
 * PUT /api/receipts/settings; also parses the stored JSON (missing keys → defaults). z.object strips unknown
 * keys, so settings saved by older versions (other model servers, other field names) still parse.
 */
export const ocrSettingsSchema = z.object({
  llmEnabled: z.boolean().default(DEFAULT_OCR_SETTINGS.llmEnabled),
  mode: z.enum(OCR_MODES).default(DEFAULT_OCR_SETTINGS.mode),
  ocrEngine: z.enum(OCR_ENGINES).default(DEFAULT_OCR_SETTINGS.ocrEngine),
  unloadAfterBatch: z.boolean().default(DEFAULT_OCR_SETTINGS.unloadAfterBatch),
  llamaServerPath: localPath().default(DEFAULT_OCR_SETTINGS.llamaServerPath),
  llamaModelPath: localPath(GGUF, "GGUF-Datei erwartet (.gguf)").default(DEFAULT_OCR_SETTINGS.llamaModelPath),
  llamaMmprojPath: localPath(GGUF, "GGUF-Datei erwartet (.gguf)").default(DEFAULT_OCR_SETTINGS.llamaMmprojPath),
  llamaContextSize: z.coerce
    .number()
    .int("Ganze Zahl erwartet")
    .min(1024, "Mindestens 1024")
    .max(262_144, "Höchstens 262144")
    .default(DEFAULT_OCR_SETTINGS.llamaContextSize),
});

export const analyzeRequestSchema = z.object({
  expenseIds: z.array(z.number().int().positive()).min(1).max(500),
});

/** GET /api/receipts/status: test unsaved values from the settings form (missing → saved settings) */
export const ocrProbeQuerySchema = z.object({
  /** unsaved llama.cpp paths from the form (empty = auto) */
  serverPath: z.string().trim().max(1000).optional(),
  modelPath: z.string().trim().max(1000).optional(),
  mmprojPath: z.string().trim().max(1000).optional(),
});

/** POST /api/receipts/llamacpp/test: unsaved form values (missing → saved settings) */
export const llamaTestSchema = z.object({
  serverPath: z.string().trim().max(1000).optional(),
  modelPath: z.string().trim().max(1000).optional(),
  mmprojPath: z.string().trim().max(1000).optional(),
  contextSize: z.number().int().min(1024).max(262_144).optional(),
});

export type OcrSettingsInput = z.input<typeof ocrSettingsSchema>;
export type LlamaTestRequest = z.infer<typeof llamaTestSchema>;
export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;
