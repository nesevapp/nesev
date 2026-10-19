import "./stdout-guard"; // must stay the first import, see stdout-guard.ts
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DATA_DIR, DATA_DIR_SOURCE } from "../server/lib/paths";
import { buildServer } from "./build";
import { createContext } from "./tool";

// nesev MCP server (stdio). Entry: `bun run mcp`. Reads the same data dir as the nesev server (NESEV_DATA_DIR, else the one chosen in the first-start setup) through
// nesev's own Hono app in-process; see README.md for setup, the tool list and how to add tools. The server itself
// (tools, instructions) is built in build.ts, which the nesev server also uses in-process for the assistant.

export { buildServer, SERVER_INFO } from "./build";

if (import.meta.main) {
  if (!DATA_DIR_SOURCE) {
    console.error("[nesev-mcp] nesev is not set up yet: start nesev once and choose a data folder, or set NESEV_DATA_DIR.");
    process.exit(1);
  }
  const ctx = createContext();
  console.error(`[nesev-mcp] data dir: ${DATA_DIR}`);
  serveStdio(() => buildServer(ctx), { onerror: (err) => console.error("[nesev-mcp]", err) });
}
