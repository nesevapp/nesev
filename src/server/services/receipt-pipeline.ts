import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, sql } from "drizzle-orm";
import type { VatTreatment } from "../../shared/expenses";
import type { OcrSettings, ReceiptExtraction, ReceiptFields, TextSource } from "../../shared/receipts";
import { isCategoryKey } from "../../shared/receipts";
import type { DbOrTx } from "../db/client";
import { expenses } from "../db/schema";
import { extractEmbeddedInvoiceXml, parseEInvoiceXml } from "../lib/ocr/einvoice";
import {
  helperStatus,
  type HelperOcrResult,
  type HelperRenderResult,
  type HelperTextResult,
  runHelper,
} from "../lib/ocr/helper";
import { observationsToText } from "../lib/ocr/layout";
import { AbortedError, runCommand } from "../lib/ocr/run";
import { tesseractImage, tesseractStatus } from "../lib/ocr/tesseract";
import { supplierSuggestions } from "./expenses";
import { extractWithRules, type RulesContext } from "./receipt-heuristics";
import {
  extractWithOllama,
  type FetchFn,
  hasModel,
  LlmError,
  listModels,
  modelMissingMessage,
  OllamaError,
  type PromptContext,
} from "./receipt-ollama";
import { extractWithOpenAi, listOpenAiModels, resolveOpenAiModel } from "./receipt-openai";
import { normalizeSupplierName, normalizeUid } from "./receipt-parse";
import { mergeFields, validateFields } from "./receipt-validate";

// One receipt → text (XML / PDF text layer / OCR) → fields (model + rules) → supplier history → validation.

/** Text extraction backends; injectable for tests. */
export interface ReceiptTools {
  /** PDF text layer per page; null when no extractor is available */
  pdfText(file: string, signal?: AbortSignal): Promise<HelperTextResult | null>;
  /** OCR of an image or scanned PDF */
  ocr(file: string, engine: OcrSettings["ocrEngine"], signal?: AbortSignal): Promise<{ text: string; source: TextSource; pageCount: number; warnings: string[] }>;
  /** page images as base64 PNG (vision mode) */
  pageImages(file: string, signal?: AbortSignal): Promise<string[]>;
}

export interface AnalyzeInput {
  /** absolute path of the receipt */
  file: string;
  settings: OcrSettings;
  /** Ollama keep_alive for this request (0 = unload right after); ignored by the OpenAI-compatible provider */
  keepAlive: number | string;
  context: RulesContext & PromptContext;
  signal?: AbortSignal;
  db: DbOrTx;
  tools?: ReceiptTools;
  fetchFn?: FetchFn;
  today?: string;
}

export interface AnalyzeOutput {
  status: "done" | "failed";
  textSource: TextSource | null;
  text: string;
  result: ReceiptExtraction;
  /** model id used, or configured when the model step failed before choosing one ("" when none) */
  model: string;
  error: string;
  /** a model request was sent (the worker unloads it after the batch) */
  usedModel: boolean;
}

const MAX_PAGES = 5;

/** enough text to work with: some letters and at least one amount-like number */
export function meaningfulText(text: string): boolean {
  const letters = (text.match(/[A-Za-zÄÖÜäöüß]/g) ?? []).length;
  return letters >= 20 && /\d/.test(text);
}

function isPdf(file: string, head: Uint8Array): boolean {
  return file.toLowerCase().endsWith(".pdf") || new TextDecoder().decode(head.slice(0, 5)) === "%PDF-";
}

export const defaultTools: ReceiptTools = {
  async pdfText(file, signal) {
    if (helperStatus().available) {
      return runHelper<HelperTextResult>(["text", file, "--max-pages", String(MAX_PAGES)], { signal });
    }
    if (Bun.which("pdftotext")) {
      const out = await runCommand(["pdftotext", "-layout", "-l", String(MAX_PAGES), file, "-"], { signal });
      const pages = out.split("\f").filter((p) => p.trim());
      return { pageCount: pages.length, pages };
    }
    return null;
  },

  async ocr(file, engine, signal) {
    const warnings: string[] = [];
    const helper = helperStatus();
    if (engine === "vision" && helper.available) {
      const res = await runHelper<HelperOcrResult>(["ocr", file, "--langs", "de-DE,en-US", "--dpi", "300", "--max-pages", String(MAX_PAGES)], {
        signal,
        timeoutMs: 300_000,
      });
      return { text: res.pages.map((p) => observationsToText(p.lines)).join("\n\n"), source: "vision", pageCount: res.pageCount, warnings };
    }
    if (engine === "vision") warnings.push(`Apple Vision nicht verfügbar (${helper.error ?? "OCR-Helfer fehlt"}) – Tesseract verwendet`);
    const tess = await tesseractStatus();
    if (!tess.available) throw new Error("Keine OCR verfügbar: Apple Vision (macOS) oder Tesseract (`brew install tesseract`) wird benötigt");
    if (!tess.hasGerman) warnings.push("Tesseract: deutsche Sprachdaten (deu) fehlen – `brew install tesseract-lang`");
    // Tesseract needs page images; the helper renders PDFs (and normalizes WebP/JPG orientation)
    if (!helper.available) {
      if (file.toLowerCase().endsWith(".pdf")) throw new Error("Gescannte PDFs brauchen den OCR-Helfer (macOS) zum Rendern");
      return { text: await tesseractImage(file, tess.languages, signal), source: "tesseract", pageCount: 1, warnings };
    }
    const dir = mkdtempSync(join(tmpdir(), "nesev-ocr-"));
    try {
      const rendered = await runHelper<HelperRenderResult>(["render", file, dir, "--dpi", "300", "--max-pages", String(MAX_PAGES)], { signal });
      const texts: string[] = [];
      for (const page of rendered.files) texts.push(await tesseractImage(page, tess.languages, signal));
      return { text: texts.join("\n\n"), source: "tesseract", pageCount: rendered.pageCount, warnings };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  async pageImages(file, signal) {
    const dir = mkdtempSync(join(tmpdir(), "nesev-pages-"));
    try {
      const rendered = await runHelper<HelperRenderResult>(["render", file, dir, "--dpi", "150", "--max-pages", "3"], { signal });
      return Promise.all(rendered.files.map(async (f) => Buffer.from(await Bun.file(f).arrayBuffer()).toString("base64")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

const elapsed = (start: number) => Math.round(performance.now() - start);

export async function analyzeReceipt(input: AnalyzeInput): Promise<AnalyzeOutput> {
  const tools = input.tools ?? defaultTools;
  const { settings, signal } = input;
  const started = performance.now();
  const timings: NonNullable<ReceiptExtraction["timings"]> = {};
  const warnings: string[] = [];
  const checkAborted = () => {
    if (signal?.aborted) throw new AbortedError();
  };

  const bytes = new Uint8Array(await Bun.file(input.file).arrayBuffer());
  const pdf = isPdf(input.file, bytes);
  let text = "";
  let textSource: TextSource | null = null;
  let pageCount: number | undefined;

  // 1. embedded e-invoice
  let t = performance.now();
  if (pdf) {
    const xml = await extractEmbeddedInvoiceXml(bytes);
    const parsed = xml ? parseEInvoiceXml(xml) : null;
    if (parsed) {
      const layer = await tools.pdfText(input.file, signal).catch(() => null);
      text = `${parsed.summary}\n\n${layer?.pages.join("\n\n") ?? ""}`.trim();
      // the XML has no expense category: take the keyword guess from the text
      const category = extractWithRules(text, input.context).fields.category;
      const history = supplierHistory(input.db, category ? { ...parsed.fields, category } : parsed.fields);
      const v = validateFields(history.fields, input.today);
      timings.text = elapsed(t);
      timings.total = elapsed(started);
      return {
        status: "done",
        textSource: "xml",
        text,
        model: "",
        error: "",
        usedModel: false,
        result: {
          fields: v.fields,
          warnings: [...parsed.warnings, ...v.warnings],
          matchedSupplier: history.matched,
          pageCount: layer?.pageCount,
          timings,
        },
      };
    }
  }

  // 2. PDF text layer
  if (pdf) {
    try {
      const layer = await tools.pdfText(input.file, signal);
      if (layer) {
        pageCount = layer.pageCount;
        const joined = layer.pages.join("\n\n").trim();
        if (meaningfulText(joined)) {
          text = joined;
          textSource = "pdf_text";
        }
      }
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      warnings.push(`PDF-Text konnte nicht gelesen werden: ${(err as Error).message}`);
    }
    timings.text = elapsed(t);
  }
  checkAborted();

  // 3. OCR
  if (!textSource) {
    t = performance.now();
    const ocr = await tools.ocr(input.file, settings.ocrEngine, signal);
    timings.ocr = elapsed(t);
    text = ocr.text.trim();
    textSource = ocr.source;
    pageCount = ocr.pageCount;
    warnings.push(...ocr.warnings);
  }
  checkAborted();
  if (!text.trim()) {
    return {
      status: "failed",
      textSource,
      text,
      model: "",
      error: "Kein Text erkannt – Beleg unlesbar?",
      usedModel: false,
      result: { fields: {}, warnings, pageCount, timings: { ...timings, total: elapsed(started) }, llmSkipped: true },
    };
  }

  // 4. rules (always) + local model
  const rules = extractWithRules(text, input.context);
  warnings.push(...rules.warnings);
  let fields = rules.fields;
  let error = "";
  let llmSkipped = true;
  const step: ModelStep = { model: activeModel(settings), usedModel: false };
  if (settings.llmEnabled) {
    t = performance.now();
    try {
      const llm = await runModel(input, text, tools, step);
      fields = mergeFields(llm.fields, rules.fields);
      if (llm.warning) warnings.push(llm.warning);
      llmSkipped = false;
    } catch (err) {
      if (signal?.aborted) throw new AbortedError();
      if (!(err instanceof LlmError)) throw err;
      error = err.message;
      warnings.push("Nur regelbasierte Erkennung – Felder bitte besonders sorgfältig prüfen");
    }
    timings.llm = elapsed(t);
  }

  // 5. supplier history + validation
  const history = supplierHistory(input.db, fields);
  const v = validateFields(history.fields, input.today);
  timings.total = elapsed(started);
  return {
    status: error ? "failed" : "done",
    textSource,
    text,
    model: settings.llmEnabled ? step.model : "",
    error,
    usedModel: step.usedModel,
    result: {
      fields: v.fields,
      warnings: [...warnings, ...v.warnings],
      matchedSupplier: history.matched,
      pageCount,
      timings,
      llmSkipped,
    },
  };
}

/** model step progress: the model id actually used, and whether a request was sent (→ unload after batch) */
interface ModelStep {
  model: string;
  usedModel: boolean;
}

/** configured model of the active provider ("" for OpenAI-compatible = first loaded model) */
function activeModel(settings: OcrSettings): string {
  if (settings.provider === "openai") return settings.openaiModel;
  return settings.mode === "vision" ? settings.visionModel : settings.model;
}

/** Field extraction by the configured provider. Throws LlmError (→ rules-only result) when it can't run. */
async function runModel(input: AnalyzeInput, text: string, tools: ReceiptTools, step: ModelStep) {
  const { settings, signal } = input;
  const fetchFn = input.fetchFn ?? fetch;
  const pageImages = () => (settings.mode === "vision" ? tools.pageImages(input.file, signal) : Promise.resolve(undefined));
  if (settings.provider === "openai") {
    const loaded = await listOpenAiModels(settings.openaiUrl, settings.openaiApiKey, fetchFn, signal);
    step.model = resolveOpenAiModel(loaded, settings.openaiModel);
    const images = await pageImages();
    step.usedModel = true;
    return extractWithOpenAi({
      baseUrl: settings.openaiUrl,
      apiKey: settings.openaiApiKey,
      model: step.model,
      text,
      images,
      context: input.context,
      signal,
      fetchFn,
    });
  }
  const models = await listModels(settings.ollamaUrl, fetchFn, signal);
  if (!hasModel(models, step.model)) throw new OllamaError(modelMissingMessage(step.model), "model_missing");
  const images = await pageImages();
  step.usedModel = true;
  return extractWithOllama({
    baseUrl: settings.ollamaUrl,
    model: step.model,
    text,
    images,
    context: input.context,
    keepAlive: input.keepAlive,
    signal,
    fetchFn,
  });
}

/**
 * Known supplier (same UID, or same normalized name): use the name as previously entered and prefer the
 * category, VAT treatment and country of the latest expense (reuses the expenses' supplier suggestions).
 */
export function supplierHistory(
  db: DbOrTx,
  input: ReceiptFields,
): { fields: ReceiptFields; matched?: ReceiptExtraction["matchedSupplier"] } {
  const fields = { ...input };
  let name: string | undefined;
  let by: "uid" | "name" = "name";
  const uid = fields.supplierUid?.value ? normalizeUid(fields.supplierUid.value) : "";
  if (uid) {
    const row = db
      .select({ name: expenses.supplierName })
      .from(expenses)
      .where(sql`replace(replace(upper(${expenses.supplierUid}), ' ', ''), '-', '') = ${uid} and ${expenses.supplierName} <> ''`)
      .orderBy(desc(expenses.issueDate), desc(expenses.id))
      .limit(1)
      .get();
    if (row) {
      name = row.name;
      by = "uid";
    }
  }
  const candidateName = name ?? fields.supplierName?.value;
  if (!candidateName) return { fields };
  const wanted = normalizeSupplierName(candidateName);
  if (wanted.length < 3) return { fields };
  const term = candidateName.trim().split(/\s+/)[0]!;
  const suggestion = supplierSuggestions(db, term, 50).find((s) => {
    const n = normalizeSupplierName(s.name);
    return by === "uid" ? s.name === name : n === wanted || (n.length >= 4 && (n.startsWith(wanted) || wanted.startsWith(n)));
  });
  if (!suggestion) return { fields };

  const note = "wie bei früheren Ausgaben";
  const fromHistory = <T>(value: T, confidence: number) => ({ value, confidence, source: "supplier" as const, note });
  fields.supplierName = fromHistory(suggestion.name, by === "uid" ? 0.95 : 0.9);
  if (suggestion.uid && !fields.supplierUid) fields.supplierUid = fromHistory(suggestion.uid, 0.8);
  if (fields.supplierCountry?.source !== "xml") fields.supplierCountry = fromHistory(suggestion.country, 0.85);
  if (fields.vatTreatment?.source !== "xml") fields.vatTreatment = fromHistory<VatTreatment>(suggestion.vatTreatment, 0.85);
  if (suggestion.category && isCategoryKey(suggestion.category)) fields.category = fromHistory(suggestion.category, 0.85);
  return { fields, matched: { name: suggestion.name, by, count: suggestion.count } };
}
