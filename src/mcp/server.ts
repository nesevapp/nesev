import "./stdout-guard"; // must stay the first import, see stdout-guard.ts
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DATA_DIR } from "../server/lib/paths";
import { buildServer } from "./build";
import { createContext } from "./tool";

// nesev MCP server (stdio). Entry: `bun run mcp`. Reads data from NESEV_DATA_DIR (default: <repo>/data) through
// nesev's own Hono app in-process; see README.md for setup, the tool list and how to add tools. The server itself
// (tools, instructions) is built in build.ts, which the nesev server also uses in-process for the assistant.

export { buildServer, SERVER_INFO } from "./build";

if (import.meta.main) {
  const ctx = createContext();
  console.error(`[nesev-mcp] data dir: ${DATA_DIR}`);
  serveStdio(() => buildServer(ctx), { onerror: (err) => console.error("[nesev-mcp]", err) });
}
