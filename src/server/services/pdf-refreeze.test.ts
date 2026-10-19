import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/client";
import { clients, documents, reminders } from "../db/schema";
import { createDocument, finalizeDocument, setPdfPath } from "./documents";
import { ensureDefaultTemplates } from "./pdf";
import { refreezeMissingPdfs } from "./pdf-refreeze";
import { createReminder, finalizeReminder } from "./reminders";
import { updateSettings } from "./settings";

function setup() {
  const db = createTestDb();
  updateSettings(db, { companyName: "Muster GmbH", iban: "AT611904300234573201", bic: "BKAUATWW" });
  ensureDefaultTemplates(db);
  const client = db.insert(clients).values({ number: 1, name: "Beispiel AG", country: "AT" }).returning().get();
  const invoice = (issueDate = "2026-09-16") =>
    createDocument(db, {
      type: "invoice",
      clientId: client.id,
      issueDate,
      dueDate: "2026-09-30",
      items: [{ title: "Beratung", description: "", quantity: 2000, unit: "h", unitPriceCents: 10000, taxRateBp: 2000, discountBp: 0 }],
    });
  const dataDir = mkdtempSync(join(tmpdir(), "nesev-refreeze-"));
  const pdfsDir = join(dataDir, "pdfs");
  mkdirSync(pdfsDir);
  return { db, invoice, dataDir, pdfsDir };
}

describe("refreezeMissingPdfs", () => {
  test("freezes finalized documents/reminders without a PDF (or whose file is gone); leaves drafts and intact ones", async () => {
    const { db, invoice, dataDir, pdfsDir } = setup();
    const noPath = finalizeDocument(db, invoice().id); // RE-2026-0001: freeze never happened
    const gone = finalizeDocument(db, invoice().id); // RE-2026-0002: path set, file missing
    setPdfPath(db, gone.id, "pdfs/RE-2026-0002.pdf");
    const intact = finalizeDocument(db, invoice().id); // RE-2026-0003: file present
    writeFileSync(join(pdfsDir, "RE-2026-0003.pdf"), "original");
    setPdfPath(db, intact.id, "pdfs/RE-2026-0003.pdf");
    const draft = invoice();
    const reminder = createReminder(db, { invoiceId: noPath.id }, "2026-10-14");
    finalizeReminder(db, reminder.id);

    const r = await refreezeMissingPdfs(db, { dataDir, pdfsDir });
    expect(r.failed).toEqual([]);
    expect(r.documents.map((d) => d.number).sort()).toEqual(["RE-2026-0001", "RE-2026-0002"]);
    expect(r.reminders.map((d) => d.number)).toEqual(["MA-2026-0001"]);

    const pdfPath = (id: number) => db.select().from(documents).where(eq(documents.id, id)).get()!.pdfPath;
    expect(pdfPath(noPath.id)).toBe("pdfs/RE-2026-0001.pdf");
    expect(pdfPath(draft.id)).toBeNull();
    expect(await Bun.file(join(pdfsDir, "RE-2026-0001.pdf")).text()).toStartWith("%PDF-");
    expect(await Bun.file(join(pdfsDir, "RE-2026-0002.pdf")).text()).toStartWith("%PDF-");
    expect(await Bun.file(join(pdfsDir, "RE-2026-0003.pdf")).text()).toBe("original");
    expect(db.select().from(reminders).where(eq(reminders.id, reminder.id)).get()!.pdfPath).toBe("pdfs/MA-2026-0001.pdf");
    expect(existsSync(join(pdfsDir, "MA-2026-0001.pdf"))).toBe(true);

    // second run: nothing left to do
    const again = await refreezeMissingPdfs(db, { dataDir, pdfsDir });
    expect([...again.documents, ...again.reminders, ...again.failed]).toEqual([]);
  }, 30_000);

  test("a failing render is reported, not thrown, and the others still freeze", async () => {
    const { db, invoice, dataDir } = setup();
    finalizeDocument(db, invoice().id);
    const r = await refreezeMissingPdfs(db, { dataDir, pdfsDir: join(dataDir, "missing-dir", "\0bad") });
    expect(r.documents).toEqual([]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ kind: "document", number: "RE-2026-0001" });
  }, 30_000);
});
