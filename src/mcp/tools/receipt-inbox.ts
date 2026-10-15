import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { call } from "../api";
import { bullets } from "../format";
import { CREATES, defineTool, READ_ONLY, type ToolContext } from "../tool";

// Belege-Eingang: receipts picked up from the inbox folder or dropped on /expenses/inbox, waiting to become expenses.
// Listing reads the items; create_expense_from_inbox turns them into expense drafts (receipt attached, no supplier
// or lines yet). Scanning the folder and analysing receipts never happen here.

const InboxRow = z.object({
  id: z.number().int().describe("inbox item id"),
  fileName: z.string(),
  receivedAt: z.string().describe("ISO timestamp"),
  sizeKb: z.number(),
  source: z.enum(["folder", "upload"]),
});

const kb = (bytes: number) => Math.max(1, Math.round(bytes / 1024));

export function registerReceiptInboxTools(server: McpServer, ctx: ToolContext) {
  defineTool(
    server,
    "list_receipt_inbox",
    {
      title: "Belege-Eingang anzeigen",
      group: "expenses",
      description:
        "Receipts waiting in the Belege-Eingang (inbox folder or dropped on the inbox page) that are not yet expenses: " +
        "id, file name, when received, size, source. Also the configured inbox folder and its error, if any. Turn items " +
        "into expenses with create_expense_from_inbox.",
      input: z.object({}),
      output: z.object({
        total: z.number().int(),
        items: z.array(InboxRow),
        folder: z.string().describe('inbox folder; "" = none configured'),
        folderError: z.string().nullable(),
        link: z.string(),
      }),
      annotations: READ_ONLY,
    },
    async () => {
      const [rows, settings] = await Promise.all([
        call(ctx.api.receiptInbox.index.$get({ query: { status: "new" } })),
        call(ctx.api.settings.index.$get()),
      ]);
      // the scanner (and its error) lives in the nesev server; inside it the status is available, here only the folder
      const status = ctx.inServer ? await call(ctx.api.receiptInbox.status.$get()) : null;
      const items = rows.map((r) => ({
        id: r.id,
        fileName: r.fileName,
        receivedAt: r.createdAt,
        sizeKb: kb(r.sizeBytes),
        source: r.sourcePath ? ("folder" as const) : ("upload" as const),
      }));
      const link = ctx.webUrl("/expenses/inbox");
      const folder = settings.receiptInboxPath;
      const folderError = status?.error ?? null;
      const head = items.length
        ? `${items.length} ${items.length === 1 ? "Beleg wartet" : "Belege warten"} im Belege-Eingang:`
        : "Keine neuen Belege im Belege-Eingang.";
      const text = [
        head,
        items.length && bullets(items.map((i) => `#${i.id} ${i.fileName} (${i.sizeKb} KB, ${i.source === "folder" ? "aus Ordner" : "hochgeladen"})`)),
        folder ? `Eingangsordner: ${folder}${folderError ? ` – ${folderError}` : ""}` : "Kein Eingangsordner eingestellt.",
        `Link: ${link}`,
      ]
        .filter(Boolean)
        .join("\n");
      return { text, data: { total: items.length, items, folder, folderError, link } };
    },
  );

  defineTool(
    server,
    "create_expense_from_inbox",
    {
      title: "Ausgabe aus Belege-Eingang anlegen",
      group: "expenses",
      description:
        "Create one expense draft per inbox item (ids from list_receipt_inbox): the file becomes the expense's receipt, " +
        "issue date today, no supplier and no lines yet (shown as 'unvollständig'). Fill it in afterwards with " +
        "update_expense, or queue the receipt analysis with queue_receipt_analysis. Nothing is analysed automatically.",
      input: z.object({ ids: z.array(z.number().int().positive()).min(1).max(20).describe("inbox item ids") }),
      output: z.object({
        created: z.array(
          z.object({ expenseId: z.number().int(), number: z.string().nullable(), fileName: z.string(), link: z.string() }),
        ),
      }),
      annotations: CREATES,
    },
    async ({ ids }) => {
      const expenses = await call(ctx.api.receiptInbox.convert.$post({ json: { ids } }));
      const created = expenses.map((e) => ({
        expenseId: e.id,
        number: e.number,
        fileName: e.attachmentName,
        link: ctx.webUrl(`/expenses/${e.id}`),
      }));
      const text = [
        `${created.length === 1 ? "1 Ausgabe" : `${created.length} Ausgaben`} als Entwurf angelegt (Lieferant und Positionen fehlen noch):`,
        bullets(created.map((c) => `${c.number ?? `#${c.expenseId}`} (expense id ${c.expenseId}) – ${c.fileName}: ${c.link}`)),
      ].join("\n");
      return { text, data: { created } };
    },
  );
}
