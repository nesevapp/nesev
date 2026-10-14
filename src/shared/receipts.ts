// Receipt analysis (Belegerkennung) — shared by server and web.
//
// Analyses never run on upload: the user queues them explicitly (per expense or in bulk). The server works
// through the queue one at a time and stores one receipt_analyses row per run (newest per expense wins).
// Results are suggestions only; the editor fills fields on request and nothing is saved until the user saves.
//
// Pipeline per receipt (first step that yields good text wins):
//   xml       embedded ZUGFeRD / Factur-X / XRechnung invoice in the PDF → exact fields, no model
//   pdf_text  PDF text layer
//   vision    Apple Vision OCR (macOS helper) of images / scanned PDFs
//   tesseract Tesseract CLI fallback
// Then field extraction by a local model (structured JSON output) plus a rule-based extractor, which also
// covers the case that the model server isn't running. Providers: Ollama (native API) or any OpenAI-compatible
// server (Unsloth Studio, LM Studio, llama-server). Validation (sums, rates, UID, IBAN, dates) happens in code.

import {
  EXPENSE_CATEGORY_KEYS,
  type ExpenseCategoryKey,
  expenseTaxCents,
  getExpenseCategory,
  isSelfAssessed,
  netFromGross,
  type VatTreatment,
} from "./expenses";

export const ANALYSIS_STATUSES = ["queued", "running", "done", "failed", "cancelled"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const TEXT_SOURCES = ["xml", "pdf_text", "vision", "tesseract"] as const;
export type TextSource = (typeof TEXT_SOURCES)[number];

export const TEXT_SOURCE_LABELS: Record<TextSource, string> = {
  xml: "E-Rechnung (XML im PDF)",
  pdf_text: "PDF-Textebene",
  vision: "Apple Vision OCR",
  tesseract: "Tesseract OCR",
};

// --- settings --------------------------------------------------------------------------------------

export const OCR_MODES = ["text", "vision"] as const;
export type OcrMode = (typeof OCR_MODES)[number];
export const OCR_ENGINES = ["vision", "tesseract"] as const;
export type OcrEngine = (typeof OCR_ENGINES)[number];
/** "ollama": Ollama's native API; "openai": OpenAI-compatible /v1 API (Unsloth Studio, LM Studio, llama-server) */
export const OCR_PROVIDERS = ["ollama", "openai"] as const;
export type OcrProvider = (typeof OCR_PROVIDERS)[number];

export const OCR_PROVIDER_LABELS: Record<OcrProvider, string> = {
  ollama: "Ollama",
  openai: "OpenAI-kompatibel (Unsloth Studio)",
};

/** Stored in settings.ocr_settings (null → defaults). */
export interface OcrSettings {
  /** run the local LLM at all; off = rule-based extraction only */
  llmEnabled: boolean;
  /** which local model server to talk to */
  provider: OcrProvider;
  /** Ollama base URL; only loopback addresses are accepted (nothing leaves the machine) */
  ollamaUrl: string;
  /** OpenAI-compatible base URL incl. /v1 (loopback only, like ollamaUrl) */
  openaiUrl: string;
  /** Bearer token, e.g. Unsloth Studio's `sk-unsloth-…` (empty = no auth header); never logged */
  openaiApiKey: string;
  /** model id for both modes; empty = the first model from GET /v1/models (i.e. the one loaded in Studio) */
  openaiModel: string;
  /** "text": text model on the extracted text; "vision": vision model on the page images */
  mode: OcrMode;
  /** Ollama model for mode "text" */
  model: string;
  /** Ollama model for mode "vision" */
  visionModel: string;
  /** OCR engine for images and scanned PDFs */
  ocrEngine: OcrEngine;
  /** Ollama only: unload the model (keep_alive 0) after the last receipt of a batch */
  unloadAfterBatch: boolean;
}

export const DEFAULT_OCR_SETTINGS: OcrSettings = {
  llmEnabled: true,
  provider: "ollama",
  ollamaUrl: "http://127.0.0.1:11434",
  openaiUrl: "http://127.0.0.1:8888/v1",
  openaiApiKey: "",
  openaiModel: "",
  mode: "text",
  model: "qwen3.5:4b",
  visionModel: "qwen3.5:4b",
  ocrEngine: "vision",
  unloadAfterBatch: true,
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Only local model servers: http(s)://localhost|127.x.x.x|[::1]. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return LOOPBACK_HOSTS.has(u.hostname) || /^127\.\d+\.\d+\.\d+$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** Short display name of a model id: OpenAI-compatible servers may report a file path ("/…/gemma-4-E2B-it-Q4.gguf"). */
export function modelLabel(id: string): string {
  return id.includes("/") ? id.split("/").filter(Boolean).at(-1)!.replace(/\.gguf$/i, "") : id;
}

// --- result ----------------------------------------------------------------------------------------

/** where a suggested value came from */
export type FieldSource = "xml" | "llm" | "rules" | "supplier";

export const FIELD_SOURCE_LABELS: Record<FieldSource, string> = {
  xml: "E-Rechnung",
  llm: "KI-Modell",
  rules: "Regeln",
  supplier: "Bekannter Lieferant",
};

export interface FieldSuggestion<T> {
  value: T;
  /** 0..1 after validation */
  confidence: number;
  source: FieldSource;
  /** validation remark, e.g. "Prüfziffer ungültig" */
  note?: string;
}

/** one row of the receipt's tax breakdown (amounts in cents, as printed on the receipt) */
export interface TaxLineSuggestion {
  taxRateBp: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
}

export interface ReceiptFields {
  supplierName?: FieldSuggestion<string>;
  supplierUid?: FieldSuggestion<string>;
  supplierCountry?: FieldSuggestion<string>;
  supplierInvoiceNumber?: FieldSuggestion<string>;
  issueDate?: FieldSuggestion<string>;
  dueDate?: FieldSuggestion<string>;
  /** ISO 4217, e.g. "EUR" */
  currency?: FieldSuggestion<string>;
  grossCents?: FieldSuggestion<number>;
  iban?: FieldSuggestion<string>;
  description?: FieldSuggestion<string>;
  category?: FieldSuggestion<ExpenseCategoryKey>;
  vatTreatment?: FieldSuggestion<VatTreatment>;
  taxLines?: FieldSuggestion<TaxLineSuggestion[]>;
}

export type ReceiptFieldKey = keyof ReceiptFields;

/** Stored in receipt_analyses.result. */
export interface ReceiptExtraction {
  fields: ReceiptFields;
  /** validation and pipeline remarks (German) */
  warnings: string[];
  /** previous expenses of the same supplier were found */
  matchedSupplier?: { name: string; by: "uid" | "name"; count: number };
  /** page count of the receipt */
  pageCount?: number;
  /** milliseconds per step */
  timings?: { text?: number; ocr?: number; llm?: number; total?: number };
  /** the model step was skipped or failed; the fields come from rules only */
  llmSkipped?: boolean;
}

export const RECEIPT_FIELD_LABELS: Record<ReceiptFieldKey, string> = {
  supplierName: "Lieferant",
  supplierUid: "UID-Nummer",
  supplierCountry: "Land",
  supplierInvoiceNumber: "Rechnungsnummer",
  issueDate: "Rechnungsdatum",
  dueDate: "Fällig am",
  currency: "Währung",
  grossCents: "Gesamtbetrag",
  iban: "IBAN",
  description: "Beschreibung",
  category: "Kategorie",
  vatTreatment: "Umsatzsteuer",
  taxLines: "Steueraufteilung",
};

export function isCategoryKey(key: unknown): key is ExpenseCategoryKey {
  return typeof key === "string" && (EXPENSE_CATEGORY_KEYS as readonly string[]).includes(key);
}

export const DESCRIPTION_MAX_WORDS = 6;
export const DESCRIPTION_MAX_CHARS = 60;

/** words that make no sense at the end of a shortened description */
const DANGLING_WORDS = new Set(["und", "oder", "für", "fuer", "mit", "von", "vom", "zu", "zur", "zum", "im", "in", "an", "am", "auf", "bei", "aus", "der", "die", "das", "des", "dem", "den", "ein", "eine", "einer", "inkl", "inkl.", "zzgl", "zzgl.", "lt", "lt.", "gem", "gem.", "&", "-", "–", "/", "+"]);

/**
 * Short form of a receipt description for the expense line (models like to write sentences):
 * first sentence/line, at most DESCRIPTION_MAX_WORDS words and DESCRIPTION_MAX_CHARS characters,
 * cut at word boundaries, without trailing connectors or punctuation.
 */
export function shortDescription(text: string): string {
  // first line / sentence / clause, without a parenthetical; "." after numbers or short abbreviations ("inkl.") is no sentence end
  const firstLine = text.trim().split(/\r?\n/)[0]!.replace(/\s+/g, " ");
  const s = firstLine.split(/(?<=[a-zäöüß]{5})\.\s|[;:]\s|\s\(/i)[0]!.trim();
  let words = s.split(" ").filter(Boolean).slice(0, DESCRIPTION_MAX_WORDS);
  while (words.length > 1 && words.join(" ").length > DESCRIPTION_MAX_CHARS) words.pop();
  const strip = (w: string) => w.replace(/[,.;:!?)\]–—-]+$/, "");
  while (words.length > 1 && (DANGLING_WORDS.has(words.at(-1)!.toLowerCase()) || !strip(words.at(-1)!))) words.pop();
  let out = words.map((w, i) => (i === words.length - 1 ? strip(w) : w)).join(" ").replace(/,$/, "");
  if (out.length > DESCRIPTION_MAX_CHARS) out = out.slice(0, DESCRIPTION_MAX_CHARS).trim();
  return out;
}

export type ConfidenceLevel = "high" | "medium" | "low";

export function confidenceLevel(confidence: number): ConfidenceLevel {
  return confidence >= 0.8 ? "high" : confidence >= 0.5 ? "medium" : "low";
}

/**
 * Expense lines for the suggested tax breakdown: one line per rate with the suggested category.
 * Self-assessed treatments (reverse charge / ig. Erwerb): the receipt shows no VAT, so a 0 % row becomes
 * the Austrian standard rate with the self-assessed tax. Without a breakdown, the gross total becomes one
 * line at 20 % (or 0 % for "none").
 */
export function suggestedLines(
  fields: ReceiptFields,
  treatment: VatTreatment,
): { category: ExpenseCategoryKey; description: string; netCents: number; taxRateBp: number; taxCents: number; deductibleBp: number }[] {
  const category = fields.category?.value ?? "sonstiges";
  const deductibleBp = getExpenseCategory(category)?.defaultDeductibleBp ?? 10000;
  const description = fields.description?.value ?? "";
  const rows = fields.taxLines?.value ?? [];
  const toLine = (netCents: number, taxRateBp: number, taxCents: number) => ({
    category,
    description: rows.length > 1 ? "" : description,
    netCents,
    taxRateBp,
    taxCents,
    deductibleBp,
  });

  if (treatment === "none") {
    const total = rows.length ? rows.reduce((s, r) => s + r.grossCents, 0) : (fields.grossCents?.value ?? 0);
    return total ? [toLine(total, 0, 0)] : [];
  }
  if (isSelfAssessed(treatment)) {
    const net = rows.length ? rows.reduce((s, r) => s + r.netCents, 0) : (fields.grossCents?.value ?? 0);
    return net ? [toLine(net, 2000, expenseTaxCents(net, 2000))] : [];
  }
  if (rows.length) return rows.map((r) => toLine(r.netCents, r.taxRateBp, r.taxCents));
  const gross = fields.grossCents?.value;
  if (!gross) return [];
  const { netCents, taxCents } = netFromGross(gross, 2000);
  return [toLine(netCents, 2000, taxCents)];
}

// --- queue / list status -----------------------------------------------------------------------------

/** status shown on the expense list */
export type AnalysisListStatus = "none" | "queued" | "running" | "ready" | "applied" | "failed" | "cancelled";

export const ANALYSIS_LIST_STATUS_LABELS: Record<AnalysisListStatus, string> = {
  none: "nicht analysiert",
  queued: "in Warteschlange",
  running: "läuft",
  ready: "Vorschläge bereit",
  applied: "übernommen",
  failed: "fehlgeschlagen",
  cancelled: "abgebrochen",
};

/** Latest analysis of an expense as listed by GET /api/receipts/queue. */
export interface AnalysisQueueItem {
  analysisId: number;
  expenseId: number;
  status: AnalysisStatus;
  /** the receipt was replaced or removed after this analysis */
  stale: boolean;
  appliedAt: string | null;
  /** failed runs may still carry rule-based results */
  hasResult: boolean;
  error: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function analysisListStatus(item: AnalysisQueueItem | undefined): AnalysisListStatus {
  if (!item) return "none";
  if (item.status === "queued" || item.status === "running") return item.status;
  if (item.stale) return "none";
  if (item.status === "done") return item.appliedAt ? "applied" : "ready";
  return item.status;
}
