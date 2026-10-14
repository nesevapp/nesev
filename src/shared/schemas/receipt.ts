import { z } from "./zod";
import { DEFAULT_OCR_SETTINGS, isLoopbackUrl, OCR_ENGINES, OCR_MODES, OCR_PROVIDERS } from "../receipts";

const modelName = z
  .string()
  .trim()
  .min(1, "Modellname fehlt")
  .max(100)
  .regex(/^[A-Za-z0-9._:/-]+$/, "Ungültiger Modellname");

const localUrl = z
  .string()
  .trim()
  .max(200)
  .transform((s) => s.replace(/\/+$/, ""))
  .refine(isLoopbackUrl, "Nur lokale Adressen (localhost / 127.0.0.1) – Belege verlassen den Rechner nicht");

/** empty, absolute ("/…") or home-relative ("~/…") local file path */
const localPath = (ext?: RegExp, message = "Ungültiger Pfad") =>
  z
    .string()
    .trim()
    .max(1000)
    .refine((s) => s === "" || ((s.startsWith("/") || s.startsWith("~/")) && !s.includes("\0")), "Absoluter Pfad erwartet (/… oder ~/…)")
    .refine((s) => s === "" || !ext || ext.test(s), message);

const GGUF = /\.gguf$/i;

/** PUT /api/receipts/settings; also parses the stored JSON (missing keys → defaults). */
export const ocrSettingsSchema = z.object({
  llmEnabled: z.boolean().default(DEFAULT_OCR_SETTINGS.llmEnabled),
  provider: z.enum(OCR_PROVIDERS).default(DEFAULT_OCR_SETTINGS.provider),
  ollamaUrl: localUrl.default(DEFAULT_OCR_SETTINGS.ollamaUrl),
  openaiUrl: localUrl.default(DEFAULT_OCR_SETTINGS.openaiUrl),
  openaiApiKey: z
    .string()
    .trim()
    .max(500)
    .regex(/^[\x21-\x7e]*$/, "Ungültiger API-Key (keine Leerzeichen)")
    .default(DEFAULT_OCR_SETTINGS.openaiApiKey),
  openaiModel: z
    .string()
    .trim()
    .max(200)
    .regex(/^[\x21-\x7e]*$/, "Ungültiger Modellname")
    .default(DEFAULT_OCR_SETTINGS.openaiModel),
  mode: z.enum(OCR_MODES).default(DEFAULT_OCR_SETTINGS.mode),
  model: modelName.default(DEFAULT_OCR_SETTINGS.model),
  visionModel: modelName.default(DEFAULT_OCR_SETTINGS.visionModel),
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
  provider: z.enum(OCR_PROVIDERS).optional(),
  url: z.string().trim().max(200).optional(),
  apiKey: z.string().trim().max(500).optional(),
  model: z.string().trim().max(200).optional(),
  /** llama.cpp: unsaved paths from the form (empty = auto) */
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
