import type { McpServer, StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server";
import { join } from "node:path";
import type { z } from "zod";
import { DEFAULT_PORT } from "../server/lib/app-files";
import { DATA_DIR } from "../server/lib/paths";
import { TOOL_GROUP_META, type ToolGroup } from "../shared/chat";
import { type Api, ApiError, api, createApi } from "./api";

// The shared core every tool module builds on: the context passed to register<Area>Tools(server, ctx) and
// defineTool(), which wires a zod input/output schema, annotations and the error mapping onto server.registerTool.

export interface ToolContext {
  /** in-process typed API clients (see api.ts) */
  api: Api;
  /** absolute link into the web UI, e.g. webUrl("/invoices/12") → "http://localhost:3998/invoices/12" */
  webUrl: (path: string) => string;
  /** absolute path of a file stored relative to the data dir ("pdfs/RE-2026-0001.pdf") */
  dataPath: (relative: string) => string;
  /** the running nesev server (HTTP), for work that must not run in the MCP process (receipt analysis) */
  apiUrl: string;
  /**
   * The tools run inside the nesev server process (in-app assistant) instead of the stdio MCP process: receipt
   * analysis is queued in-process (api serves POST /api/receipts), apiUrl is unused.
   */
  inServer: boolean;
}

/** The nesev server serves API and web app on one port (PORT, default 3998); in dev the web app is Vite's URL. */
export const DEFAULT_WEB_URL = `http://localhost:${DEFAULT_PORT}`;
export const DEFAULT_API_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

export function createContext(env: Record<string, string | undefined> = process.env): ToolContext {
  const port = env.PORT?.trim();
  const base = (env.NESEV_WEB_URL?.trim() || (port ? `http://localhost:${port}` : DEFAULT_WEB_URL)).replace(/\/+$/, "");
  return {
    api,
    webUrl: (path) => `${base}${path.startsWith("/") ? path : `/${path}`}`,
    dataPath: (relative) => join(DATA_DIR, relative),
    apiUrl: (env.NESEV_API_URL?.trim() || (port ? `http://127.0.0.1:${port}` : DEFAULT_API_URL)).replace(/\/+$/, ""),
    inServer: false,
  };
}

/** Context for the tools inside the nesev server process: links are app paths ("/invoices/12"), receipts in-process. */
export function createServerContext(): ToolContext {
  return {
    api: createApi({ inServer: true }),
    webUrl: (path) => (path.startsWith("/") ? path : `/${path}`),
    dataPath: (relative) => join(DATA_DIR, relative),
    apiUrl: "",
    inServer: true,
  };
}

/** Annotations for tools that only read. */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** Creates something new or edits a draft; nothing existing is lost (clients may allow these permanently). */
export const CREATES: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Changes the state of existing records, often irreversibly (finalize, mark paid, …): clients should ask first. */
export const CHANGES_STATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

/** A problem the tool itself detects (ambiguous client, unknown unit, missing file, …); reported like an ApiError. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** What a tool handler returns: a short text summary for the model and the structured data (matches `output`). */
export interface ToolOutput<O> {
  text: string;
  data: O;
}

type ObjectSchema = z.ZodObject;

export interface ToolSpec<I extends ObjectSchema, O extends ObjectSchema> {
  title: string;
  /** routing group for the in-app assistant (see TOOL_GROUPS in src/shared/chat.ts); "ui" is reserved for assistant-only tools */
  group: Exclude<ToolGroup, "ui">;
  /** written for an LLM: when to use it, what it returns, units */
  description: string;
  input: I;
  output: O;
  annotations: ToolAnnotations;
}

/**
 * Registers one tool. The handler gets the validated input and returns `{ text, data }`; `data` becomes
 * `structuredContent` (validated against `output` by the SDK and the client). An ApiError (non-2xx from nesev's
 * API) or a ToolError becomes a tool error (`isError: true`) carrying the German message; anything else is thrown
 * and the SDK reports it as a tool error too.
 */
export function defineTool<I extends ObjectSchema, O extends ObjectSchema>(
  server: McpServer,
  name: string,
  spec: ToolSpec<I, O>,
  run: (input: z.output<I>) => Promise<ToolOutput<z.input<O>>>,
) {
  return server.registerTool(
    name,
    {
      title: spec.title,
      description: spec.description,
      // zod 4 objects are Standard Schemas with JSON Schema; the casts only bridge the generic parameters
      inputSchema: spec.input as unknown as StandardSchemaWithJSON,
      outputSchema: spec.output as unknown as StandardSchemaWithJSON,
      annotations: { title: spec.title, ...spec.annotations },
      _meta: { [TOOL_GROUP_META]: spec.group },
    },
    async (input: unknown) => {
      try {
        const { text, data } = await run(input as z.output<I>);
        return { content: [{ type: "text" as const, text }], structuredContent: data as Record<string, unknown> };
      } catch (err) {
        if (err instanceof ApiError || err instanceof ToolError) return { content: [{ type: "text" as const, text: `Fehler: ${err.message}` }], isError: true };
        console.error(`[nesev-mcp] ${name} failed`, err);
        throw err;
      }
    },
  );
}
