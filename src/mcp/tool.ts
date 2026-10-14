import type { McpServer, StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server";
import { join } from "node:path";
import type { z } from "zod";
import { DATA_DIR } from "../server/lib/paths";
import { type Api, ApiError, api } from "./api";

// The shared core every tool module builds on: the context passed to register<Area>Tools(server, ctx) and
// defineTool(), which wires a zod input/output schema, annotations and the error mapping onto server.registerTool.

export interface ToolContext {
  /** in-process typed API clients (see api.ts) */
  api: Api;
  /** absolute link into the web UI, e.g. webUrl("/invoices/12") → "http://localhost:5174/invoices/12" */
  webUrl: (path: string) => string;
  /** absolute path of a file stored relative to the data dir ("pdfs/RE-2026-0001.pdf") */
  dataPath: (relative: string) => string;
}

export const DEFAULT_WEB_URL = "http://localhost:5174";

export function createContext(env: Record<string, string | undefined> = process.env): ToolContext {
  const base = (env.NESEV_WEB_URL?.trim() || DEFAULT_WEB_URL).replace(/\/+$/, "");
  return {
    api,
    webUrl: (path) => `${base}${path.startsWith("/") ? path : `/${path}`}`,
    dataPath: (relative) => join(DATA_DIR, relative),
  };
}

/** Annotations for tools that only read. Write tools set their own (readOnlyHint: false, destructiveHint, …). */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** What a tool handler returns: a short text summary for the model and the structured data (matches `output`). */
export interface ToolOutput<O> {
  text: string;
  data: O;
}

type ObjectSchema = z.ZodObject;

export interface ToolSpec<I extends ObjectSchema, O extends ObjectSchema> {
  title: string;
  /** written for an LLM: when to use it, what it returns, units */
  description: string;
  input: I;
  output: O;
  annotations: ToolAnnotations;
}

/**
 * Registers one tool. The handler gets the validated input and returns `{ text, data }`; `data` becomes
 * `structuredContent` (validated against `output` by the SDK and the client). An ApiError (non-2xx from nesev's
 * API) becomes a tool error (`isError: true`) carrying the API's German message; anything else is thrown and the
 * SDK reports it as a tool error too.
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
    },
    async (input: unknown) => {
      try {
        const { text, data } = await run(input as z.output<I>);
        return { content: [{ type: "text" as const, text }], structuredContent: data as Record<string, unknown> };
      } catch (err) {
        if (err instanceof ApiError) return { content: [{ type: "text" as const, text: `Fehler: ${err.message}` }], isError: true };
        console.error(`[nesev-mcp] ${name} failed`, err);
        throw err;
      }
    },
  );
}
