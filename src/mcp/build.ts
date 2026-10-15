// buildServer() without side effects: importable from the nesev server process (in-app assistant, see
// src/server/services/chat-tools.ts) without the stdio entry's stdout guard. server.ts is the stdio entry.

import { McpServer } from "@modelcontextprotocol/server";
import { createContext, type ToolContext } from "./tool";
import { registerArticleTools } from "./tools/articles";
import { registerBankTools } from "./tools/bank";
import { registerClientTools } from "./tools/clients";
import { registerDocumentTools } from "./tools/documents";
import { registerExpenseTools } from "./tools/expenses";
import { registerFinanceTools } from "./tools/finance";
import { registerOverviewTools } from "./tools/overview";
import { registerReceiptTools } from "./tools/receipts";
import { registerReceiptInboxTools } from "./tools/receipt-inbox";
import { registerRecurringTools } from "./tools/recurring";
import { registerDocumentWriteTools } from "./tools/write-documents";
import { registerExpenseWriteTools } from "./tools/write-expenses";
import { registerMasterDataWriteTools } from "./tools/write-masterdata";
import { registerRecordWriteTools } from "./tools/write-records";

export const SERVER_INFO = { name: "nesev", version: "0.1.0" };

export const INSTRUCTIONS = `nesev is the user's local invoicing and bookkeeping app (Austrian sole trader, EUR, German UI).
Use "search" to find ids (clients, invoices, offers, credit notes, expenses, …), then the get_* tools for details.
Amounts are returned as formatted euros plus integer cents; dates are YYYY-MM-DD. Tax figures (UVA/ZM/EAR) are a helper, not tax advice.
Amount inputs are euros (number or "1.234,56"); invoice/offer prices are net. Documents are created as drafts; finalize_document is irreversible
(gapless number, frozen PDF), so show the draft and get the user's confirmation first. Corrections of finalized invoices only via credit notes.`;

/** Tool modules in registration order; tools/list returns the tools in exactly this order. */
const TOOL_MODULES: ((server: McpServer, ctx: ToolContext) => void)[] = [
  registerOverviewTools,
  registerDocumentTools,
  registerClientTools,
  registerArticleTools,
  registerExpenseTools,
  registerFinanceTools,
  // write tools (and receipt analysis) after the read tools
  registerMasterDataWriteTools,
  registerDocumentWriteTools,
  registerExpenseWriteTools,
  registerReceiptTools,
  registerReceiptInboxTools,
  // bank (read + match) and recurring invoices, then updates of existing records, fixed costs, assets
  registerBankTools,
  registerRecurringTools,
  registerRecordWriteTools,
];

export function buildServer(ctx: ToolContext = createContext()): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  for (const register of TOOL_MODULES) register(server, ctx);
  return server;
}
