import { join } from "node:path";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { AnalysisQueueItem, AnalysisStatus, ReceiptExtraction, TextSource } from "../../shared/receipts";
import type { DbOrTx } from "../db/client";
import { expenses, type ReceiptAnalysis, receiptAnalyses } from "../db/schema";
import { DATA_DIR } from "../lib/paths";
import { AbortedError } from "../lib/ocr/run";
import { analyzeReceipt, type AnalyzeOutput } from "./receipt-pipeline";
import { unloadModel } from "./receipt-ollama";
import { getOcrSettings } from "./receipt-settings";
import { getSettings } from "./settings";

// Queue of receipt analyses. Uploading never enqueues anything; the user queues runs explicitly and a single
// in-process worker handles them one at a time. Cancelling a queued run removes it from the queue; cancelling
// the running one aborts its subprocess / model request.

export type AnalysisDTO = Omit<ReceiptAnalysis, "status" | "textSource" | "result"> & {
  status: AnalysisStatus;
  textSource: TextSource | null;
  result: ReceiptExtraction | null;
  /** the expense's receipt changed since this analysis */
  stale: boolean;
};

const now = () => new Date().toISOString();

function toDTO(row: ReceiptAnalysis, currentAttachment: string | null): AnalysisDTO {
  return {
    ...row,
    status: row.status as AnalysisStatus,
    textSource: row.textSource as TextSource | null,
    result: (row.result as ReceiptExtraction | null) ?? null,
    stale: row.attachmentPath !== currentAttachment,
  };
}

export interface EnqueueResult {
  queued: number[];
  skipped: { expenseId: number; reason: string }[];
}

/** Queues one run per expense; skips expenses without receipt and ones already queued or running. */
export function enqueueAnalyses(db: DbOrTx, expenseIds: readonly number[]): EnqueueResult {
  const result: EnqueueResult = { queued: [], skipped: [] };
  db.transaction((tx) => {
    for (const expenseId of new Set(expenseIds)) {
      const expense = tx
        .select({ id: expenses.id, attachmentPath: expenses.attachmentPath })
        .from(expenses)
        .where(eq(expenses.id, expenseId))
        .get();
      if (!expense) {
        result.skipped.push({ expenseId, reason: "Ausgabe nicht gefunden" });
        continue;
      }
      if (!expense.attachmentPath) {
        result.skipped.push({ expenseId, reason: "kein Beleg" });
        continue;
      }
      const active = tx
        .select({ id: receiptAnalyses.id })
        .from(receiptAnalyses)
        .where(and(eq(receiptAnalyses.expenseId, expenseId), inArray(receiptAnalyses.status, ["queued", "running"])))
        .get();
      if (active) {
        result.skipped.push({ expenseId, reason: "bereits in Warteschlange" });
        continue;
      }
      tx.insert(receiptAnalyses).values({ expenseId, status: "queued", attachmentPath: expense.attachmentPath }).run();
      result.queued.push(expenseId);
    }
  });
  return result;
}

export function getAnalysis(db: DbOrTx, id: number): ReceiptAnalysis | undefined {
  return db.select().from(receiptAnalyses).where(eq(receiptAnalyses.id, id)).get();
}

/** Newest analysis of an expense (any status), or null. */
export function latestAnalysis(db: DbOrTx, expenseId: number): AnalysisDTO | null {
  const expense = db.select({ attachmentPath: expenses.attachmentPath }).from(expenses).where(eq(expenses.id, expenseId)).get();
  if (!expense) throw new HTTPException(404, { message: "Ausgabe nicht gefunden" });
  const row = db
    .select()
    .from(receiptAnalyses)
    .where(eq(receiptAnalyses.expenseId, expenseId))
    .orderBy(desc(receiptAnalyses.id))
    .limit(1)
    .get();
  return row ? toDTO(row, expense.attachmentPath) : null;
}

export interface QueueOverview {
  /** latest analysis per expense */
  items: AnalysisQueueItem[];
  queued: number;
  running: number;
}

export function queueOverview(db: DbOrTx): QueueOverview {
  const rows = db
    .select({
      analysisId: receiptAnalyses.id,
      expenseId: receiptAnalyses.expenseId,
      status: receiptAnalyses.status,
      analysedPath: receiptAnalyses.attachmentPath,
      currentPath: expenses.attachmentPath,
      appliedAt: receiptAnalyses.appliedAt,
      hasResult: sql<number>`${receiptAnalyses.result} is not null`,
      error: receiptAnalyses.error,
      createdAt: receiptAnalyses.createdAt,
      startedAt: receiptAnalyses.startedAt,
      finishedAt: receiptAnalyses.finishedAt,
    })
    .from(receiptAnalyses)
    .innerJoin(expenses, eq(expenses.id, receiptAnalyses.expenseId))
    .where(
      sql`${receiptAnalyses.id} = (select max(ra.id) from receipt_analyses ra where ra.expense_id = ${receiptAnalyses.expenseId})`,
    )
    .orderBy(asc(receiptAnalyses.id))
    .all();
  const items: AnalysisQueueItem[] = rows.map(({ analysedPath, currentPath, hasResult, ...r }) => ({
    ...r,
    status: r.status as AnalysisStatus,
    stale: analysedPath !== currentPath,
    hasResult: !!hasResult,
  }));
  return {
    items,
    queued: items.filter((i) => i.status === "queued").length,
    running: items.filter((i) => i.status === "running").length,
  };
}

export function countQueued(db: DbOrTx): number {
  return db.select({ n: sql<number>`count(*)` }).from(receiptAnalyses).where(eq(receiptAnalyses.status, "queued")).get()?.n ?? 0;
}

/** Marks a queued or running analysis as cancelled (the worker aborts a running one). */
export function cancelAnalysis(db: DbOrTx, id: number): ReceiptAnalysis {
  const row = getAnalysis(db, id);
  if (!row) throw new HTTPException(404, { message: "Analyse nicht gefunden" });
  if (row.status !== "queued" && row.status !== "running") return row;
  return db
    .update(receiptAnalyses)
    .set({ status: "cancelled", finishedAt: now(), error: "Abgebrochen" })
    .where(eq(receiptAnalyses.id, id))
    .returning()
    .get();
}

/** Called after the user saved the expense with applied suggestions. */
export function markApplied(db: DbOrTx, id: number): ReceiptAnalysis {
  const row = getAnalysis(db, id);
  if (!row) throw new HTTPException(404, { message: "Analyse nicht gefunden" });
  return db.update(receiptAnalyses).set({ appliedAt: now() }).where(eq(receiptAnalyses.id, id)).returning().get();
}

/** Server start: runs interrupted by a restart go back to the queue. Returns the number reset. */
export function recoverStaleRuns(db: DbOrTx): number {
  return db
    .update(receiptAnalyses)
    .set({ status: "queued", startedAt: null })
    .where(eq(receiptAnalyses.status, "running"))
    .returning({ id: receiptAnalyses.id })
    .all().length;
}

/** Oldest queued run → running (with the expense's current receipt). */
export function claimNext(db: DbOrTx): ReceiptAnalysis | undefined {
  return db.transaction((tx) => {
    const next = tx
      .select({ id: receiptAnalyses.id, current: expenses.attachmentPath })
      .from(receiptAnalyses)
      .innerJoin(expenses, eq(expenses.id, receiptAnalyses.expenseId))
      .where(eq(receiptAnalyses.status, "queued"))
      .orderBy(asc(receiptAnalyses.id))
      .limit(1)
      .get();
    if (!next) return undefined;
    return tx
      .update(receiptAnalyses)
      .set({ status: "running", startedAt: now(), attachmentPath: next.current, error: "" })
      .where(eq(receiptAnalyses.id, next.id))
      .returning()
      .get();
  });
}

/** Stores the outcome unless the run was cancelled (or deleted) meanwhile. */
export function finishRun(db: DbOrTx, id: number, out: AnalyzeOutput): boolean {
  const updated = db
    .update(receiptAnalyses)
    .set({
      status: out.status,
      textSource: out.textSource,
      text: out.text,
      result: out.result,
      model: out.model,
      error: out.error,
      finishedAt: now(),
    })
    .where(and(eq(receiptAnalyses.id, id), eq(receiptAnalyses.status, "running")))
    .returning({ id: receiptAnalyses.id })
    .all();
  return updated.length > 0;
}

export function failRun(db: DbOrTx, id: number, error: string): void {
  db.update(receiptAnalyses)
    .set({ status: "failed", error, finishedAt: now() })
    .where(and(eq(receiptAnalyses.id, id), eq(receiptAnalyses.status, "running")))
    .run();
}

// --- worker --------------------------------------------------------------------------------------------

export interface RunContext {
  signal: AbortSignal;
  /** no further runs are queued: the model may be unloaded right after this one */
  lastInBatch: boolean;
}

export type RunFn = (db: DbOrTx, row: ReceiptAnalysis, ctx: RunContext) => Promise<AnalyzeOutput>;

export class ReceiptWorker {
  private loop: Promise<void> | null = null;
  private current: { id: number; controller: AbortController } | null = null;

  constructor(
    private readonly db: DbOrTx,
    private readonly run: RunFn,
    /** after the queue ran empty; `usedModels` = models that received a request */
    private readonly onBatchEnd?: (usedModels: Set<string>) => Promise<void>,
  ) {}

  get busy(): boolean {
    return this.loop !== null;
  }

  /** Starts processing if idle. Never called on upload — only after an explicit enqueue. */
  kick(): void {
    this.loop ??= this.process().finally(() => {
      this.loop = null;
      // something was queued between the last claim and the loop ending
      if (countQueued(this.db) > 0) this.kick();
    });
  }

  /** Resolves once the queue is empty (tests). */
  async idle(): Promise<void> {
    while (this.loop) await this.loop;
  }

  cancel(id: number): void {
    if (this.current?.id === id) this.current.controller.abort();
  }

  private async process(): Promise<void> {
    const usedModels = new Set<string>();
    for (;;) {
      const row = claimNext(this.db);
      if (!row) break;
      const controller = new AbortController();
      this.current = { id: row.id, controller };
      try {
        const out = await this.run(this.db, row, { signal: controller.signal, lastInBatch: countQueued(this.db) === 0 });
        if (out.usedModel && out.model) usedModels.add(out.model);
        finishRun(this.db, row.id, out);
      } catch (err) {
        if (!(err instanceof AbortedError) && !controller.signal.aborted) {
          console.error(`receipt analysis ${row.id} failed`, err);
          failRun(this.db, row.id, (err as Error).message || "Analyse fehlgeschlagen");
        }
      } finally {
        this.current = null;
      }
    }
    if (this.onBatchEnd) await this.onBatchEnd(usedModels).catch(() => {});
  }
}

/** The production run: current receipt file, OCR settings, own company data as context. */
export const runAnalysis: RunFn = async (db, row, { signal, lastInBatch }) => {
  if (!row.attachmentPath) throw new Error("Kein Beleg vorhanden");
  const settings = getOcrSettings(db);
  const company = getSettings(db);
  return analyzeReceipt({
    file: join(DATA_DIR, row.attachmentPath),
    settings,
    keepAlive: settings.unloadAfterBatch && lastInBatch ? 0 : "10m",
    context: { ownName: company.companyName, ownUid: company.uid, ownIban: company.iban },
    signal,
    db,
  });
};

const WORKER_KEY = Symbol.for("nesev.receiptWorker");

/** Process-wide worker (kept across `bun --hot` reloads). */
export function getReceiptWorker(db: DbOrTx): ReceiptWorker {
  const g = globalThis as { [WORKER_KEY]?: ReceiptWorker };
  g[WORKER_KEY] ??= new ReceiptWorker(db, runAnalysis, async (models) => {
    const settings = getOcrSettings(db);
    if (!settings.unloadAfterBatch) return;
    for (const model of models) await unloadModel(settings.ollamaUrl, model);
  });
  return g[WORKER_KEY];
}

const INIT_KEY = Symbol.for("nesev.receiptWorkerInit");

/** Once per process: requeue runs interrupted by a restart and continue the user's queue. */
export function initReceiptQueue(db: DbOrTx): void {
  const g = globalThis as { [INIT_KEY]?: boolean };
  if (g[INIT_KEY]) return;
  g[INIT_KEY] = true;
  recoverStaleRuns(db);
  if (countQueued(db) > 0) getReceiptWorker(db).kick();
}
