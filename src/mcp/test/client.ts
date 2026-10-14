import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { PROJECT_ROOT } from "../../server/lib/paths";

// MCP client for tests and manual checks: spawns the real entry (`bun run mcp`) on a data dir over stdio.
//   NESEV_DATA_DIR=/tmp/nesev-mcp bun src/mcp/test/client.ts                     → list tools
//   NESEV_DATA_DIR=/tmp/nesev-mcp bun src/mcp/test/client.ts get_document '{"id":1}'
// Add --modern to negotiate the 2026-07-28 revision instead of the 2025 initialize handshake.

export const MODERN_VERSION = "2026-07-28";

/**
 * The time zone this process actually uses, for the env of spawned processes. `bun test` runs in UTC without setting
 * process.env.TZ, so children would use the system zone and see another "today" around midnight.
 */
export const sameTimeZone = () => ({ TZ: Intl.DateTimeFormat().resolvedOptions().timeZone });

/** NESEV_* settings of this process (web/API URL) reach the server too; the SDK only passes a minimal env. */
function passThrough(): Record<string, string> {
  return Object.fromEntries(
    ["NESEV_WEB_URL", "NESEV_API_URL"].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
  );
}

export async function connectClient(opts: { dataDir: string; era?: "legacy" | "modern"; env?: Record<string, string> }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "--silent", "mcp"],
    cwd: PROJECT_ROOT,
    env: { ...getDefaultEnvironment(), ...passThrough(), ...sameTimeZone(), NESEV_DATA_DIR: opts.dataDir, ...opts.env },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "nesev-mcp-test", version: "1.0.0" },
    opts.era === "modern" ? { versionNegotiation: { mode: { pin: MODERN_VERSION } } } : {},
  );
  await client.connect(transport);
  return client;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const modern = args.includes("--modern");
  const [tool, json] = args.filter((a) => a !== "--modern");
  const dataDir = process.env.NESEV_DATA_DIR;
  if (!dataDir) {
    console.error("Set NESEV_DATA_DIR");
    process.exit(1);
  }
  const client = await connectClient({ dataDir, era: modern ? "modern" : "legacy" });
  console.log(`protocol ${client.getNegotiatedProtocolVersion()} (${client.getProtocolEra()})`);
  if (!tool) {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}: ${t.description?.split(". ")[0]}`);
  } else {
    const res = await client.callTool({ name: tool, arguments: json ? JSON.parse(json) : {} });
    console.log(res.isError ? "ERROR" : "OK");
    for (const c of res.content as { type: string; text?: string }[]) if (c.type === "text") console.log(c.text);
    if (res.structuredContent) console.log(JSON.stringify(res.structuredContent, null, 2));
  }
  await client.close();
}
