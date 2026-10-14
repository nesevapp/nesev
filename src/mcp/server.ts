import "./stdout-guard"; // must stay the first import, see stdout-guard.ts
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DATA_DIR } from "../server/lib/paths";
import { createContext, type ToolContext } from "./tool";
import { registerArticleTools } from "./tools/articles";
import { registerClientTools } from "./tools/clients";
import { registerDocumentTools } from "./tools/documents";
import { registerExpenseTools } from "./tools/expenses";
import { registerFinanceTools } from "./tools/finance";
import { registerOverviewTools } from "./tools/overview";

// nesev MCP server (stdio). Entry: `bun run mcp`. Reads data from NESEV_DATA_DIR (default: <repo>/data) through
// nesev's own Hono app in-process; see README.md for setup, the tool list and how to add tools.

export const SERVER_INFO = { name: "nesev", version: "0.1.0" };

const INSTRUCTIONS = `nesev is the user's local invoicing and bookkeeping app (Austrian sole trader, EUR, German UI).
Use "search" to find ids (clients, invoices, offers, credit notes, expenses, …), then the get_* tools for details.
Amounts are returned as formatted euros plus integer cents; dates are YYYY-MM-DD. Tax figures (UVA/ZM/EAR) are a helper, not tax advice.`;

/** Tool modules in registration order; tools/list returns the tools in exactly this order. */
const TOOL_MODULES: ((server: McpServer, ctx: ToolContext) => void)[] = [
  registerOverviewTools,
  registerDocumentTools,
  registerClientTools,
  registerArticleTools,
  registerExpenseTools,
  registerFinanceTools,
];

export function buildServer(ctx: ToolContext = createContext()): McpServer {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  for (const register of TOOL_MODULES) register(server, ctx);
  return server;
}

if (import.meta.main) {
  const ctx = createContext();
  console.error(`[nesev-mcp] data dir: ${DATA_DIR}`);
  serveStdio(() => buildServer(ctx), { onerror: (err) => console.error("[nesev-mcp]", err) });
}
