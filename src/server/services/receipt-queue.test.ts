import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { analysisListStatus } from "../../shared/receipts";
import { createTestDb } from "../db/client";
import { receiptAnalyses } from "../db/schema";
import { AbortedError } from "../lib/ocr/run";
import { createDraftsFromFiles, createExpense, setExpenseAttachment } from "./expenses";
import type { AnalyzeOutput } from "./receipt-pipeline";
import {
  cancelAnalysis,
  enqueueAnalyses,
  latestAnalysis,
  markApplied,
  queueOverview,
  ReceiptWorker,
  recoverStaleRuns,
  type RunFn,
} from "./receipt-queue";

const dataDir = mkdtempSync(join(tmpdir(), "nesev-receipt-queue-test-"));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const pdf = (name = "beleg.pdf") => new File(["%PDF-1.4 test"], name, { type: "application/pdf" });

const output = (over: Partial<AnalyzeOutput> = {}): AnalyzeOutput => ({
  status: "done",
  textSource: "pdf_text",
  text: "Beleg",
  model: "qwen3.5:4b",
  error: "",
  usedModel: true,
  result: { fields: { grossCents: { value: 100, confidence: 0.9, source: "llm" } }, warnings: [] },
  ...over,
});

async function setup() {
  const db = createTestDb();
  const drafts = await createDraftsFromFiles(db, [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")], dataDir);
  return { db, ids: drafts.map((d) => d.id) };
}

describe("receipt analysis queue", () => {
  test("uploading receipts does not queue or run anything", async () => {
    const { db, ids } = await setup();
    await setExpenseAttachment(db, ids[0]!, pdf("replaced.pdf"), dataDir);
    expect(db.select().from(receiptAnalyses).all()).toEqual([]);
    expect(queueOverview(db)).toEqual({ items: [], queued: 0, running: 0 });
  });

  test("enqueue skips expenses without receipt and ones already queued", async () => {
    const { db, ids } = await setup();
    const noReceipt = createExpense(db, { supplierName: "Ohne Beleg" });
    const first = enqueueAnalyses(db, [ids[0]!, ids[1]!, noReceipt.id, 9999]);
    expect(first.queued).toEqual([ids[0]!, ids[1]!]);
    expect(first.skipped).toEqual([
      { expenseId: noReceipt.id, reason: "kein Beleg" },
      { expenseId: 9999, reason: "Ausgabe nicht gefunden" },
    ]);
    const again = enqueueAnalyses(db, [ids[0]!]);
    expect(again.queued).toEqual([]);
    expect(again.skipped[0]!.reason).toBe("bereits in Warteschlange");
    expect(queueOverview(db).queued).toBe(2);
  });

  test("worker runs one at a time in queue order; keep_alive hint on the last one; unload at batch end", async () => {
    const { db, ids } = await setup();
    enqueueAnalyses(db, ids);
    const order: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const lastFlags: boolean[] = [];
    const run: RunFn = async (_db, row, ctx) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(row.expenseId);
      lastFlags.push(ctx.lastInBatch);
      await Bun.sleep(5);
      concurrent--;
      return output(row.expenseId === ids[1] ? { status: "failed", error: "Ollama läuft nicht – starte es mit `ollama serve`" } : {});
    };
    const batches: Set<string>[] = [];
    const worker = new ReceiptWorker(db, run, async (models) => void batches.push(models));
    worker.kick();
    worker.kick(); // no second loop
    await worker.idle();

    expect(order).toEqual(ids);
    expect(maxConcurrent).toBe(1);
    expect(lastFlags).toEqual([false, false, true]);
    expect(batches).toEqual([new Set(["qwen3.5:4b"])]);

    const a = latestAnalysis(db, ids[0]!)!;
    expect(a.status).toBe("done");
    expect(a.result?.fields.grossCents?.value).toBe(100);
    expect(a.startedAt).not.toBeNull();
    expect(a.finishedAt).not.toBeNull();
    const failed = latestAnalysis(db, ids[1]!)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("ollama serve");

    const items = queueOverview(db).items;
    expect(items.map(analysisListStatus)).toEqual(["ready", "failed", "ready"]);
  });

  test("cancel a queued run and the running one", async () => {
    const { db, ids } = await setup();
    enqueueAnalyses(db, ids);
    const third = latestAnalysis(db, ids[2]!)!;
    expect(cancelAnalysis(db, third.id).status).toBe("cancelled");

    let worker!: ReceiptWorker;
    const run: RunFn = (_db, row, { signal }) =>
      new Promise((resolve, reject) => {
        if (row.expenseId === ids[0]) {
          // cancelled while running
          signal.addEventListener("abort", () => reject(new AbortedError()));
          queueMicrotask(() => {
            cancelAnalysis(db, row.id);
            worker.cancel(row.id);
          });
        } else resolve(output());
      });
    worker = new ReceiptWorker(db, run);
    worker.kick();
    await worker.idle();

    expect(latestAnalysis(db, ids[0]!)!.status).toBe("cancelled");
    expect(latestAnalysis(db, ids[1]!)!.status).toBe("done");
    expect(latestAnalysis(db, ids[2]!)!.status).toBe("cancelled");
  });

  test("a result arriving after cancel is discarded", async () => {
    const { db, ids } = await setup();
    enqueueAnalyses(db, [ids[0]!]);
    const worker = new ReceiptWorker(db, async (_db, row) => {
      cancelAnalysis(db, row.id); // user cancelled, but the step didn't observe the signal
      return output();
    });
    worker.kick();
    await worker.idle();
    expect(latestAnalysis(db, ids[0]!)!.status).toBe("cancelled");
  });

  test("unexpected errors fail the run with the message", async () => {
    const { db, ids } = await setup();
    enqueueAnalyses(db, [ids[0]!]);
    const worker = new ReceiptWorker(db, async () => {
      throw new Error("Keine OCR verfügbar");
    });
    worker.kick();
    await worker.idle();
    const a = latestAnalysis(db, ids[0]!)!;
    expect(a.status).toBe("failed");
    expect(a.error).toBe("Keine OCR verfügbar");
  });

  test("server restart: running runs go back to the queue", async () => {
    const { db, ids } = await setup();
    enqueueAnalyses(db, [ids[0]!]);
    db.update(receiptAnalyses).set({ status: "running", startedAt: "2026-10-14T10:00:00.000Z" }).run();
    expect(recoverStaleRuns(db)).toBe(1);
    const a = latestAnalysis(db, ids[0]!)!;
    expect(a.status).toBe("queued");
    expect(a.startedAt).toBeNull();
  });

  test("replaced receipt invalidates the result; applied; re-analysis allowed", async () => {
    const { db, ids } = await setup();
    const id = ids[0]!;
    enqueueAnalyses(db, [id]);
    const worker = new ReceiptWorker(db, async () => output());
    worker.kick();
    await worker.idle();
    const done = latestAnalysis(db, id)!;
    expect(done.stale).toBe(false);
    expect(markApplied(db, done.id).appliedAt).not.toBeNull();
    expect(analysisListStatus(queueOverview(db).items[0])).toBe("applied");

    await setExpenseAttachment(db, id, pdf("neu.pdf"), dataDir);
    expect(latestAnalysis(db, id)!.stale).toBe(true);
    expect(analysisListStatus(queueOverview(db).items[0])).toBe("none");
    expect(enqueueAnalyses(db, [id]).queued).toEqual([id]);
    expect(db.select().from(receiptAnalyses).where(eq(receiptAnalyses.expenseId, id)).all()).toHaveLength(2);
  });
});
