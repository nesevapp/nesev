import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// bun run eval:feedback [file] – the answers flagged "Antwort war falsch" in the app as draft eval cases (the format
// of chat-eval.cases.ts), to stdout or into `file`. Per flag: the conversation's user messages up to the flagged
// answer as turns, the tools that turn called, the bad answer and the user's note as comments, and an `expect` to
// fill in. Reads <NESEV_DATA_DIR or data/>/nesev.db READ-ONLY (no migrations, no writes); doesn't import the app.
// The cases run on demo data (src/mcp/test/seed.ts), so names, numbers and ids have to be adapted by hand.

export interface FeedbackTurn {
  text: string;
  contextPath: string | null;
}

export interface FeedbackCase {
  feedbackId: number;
  conversationId: number;
  title: string;
  note: string;
  flaggedAt: string;
  turns: FeedbackTurn[];
  /** "search {…} → done", in call order, of the flagged answer's turn */
  tools: string[];
  /** tool names of that turn */
  toolNames: string[];
  answer: string;
}

interface MessageRow {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  status: string;
  context_path: string | null;
}

/** The flags with their conversation up to the flagged answer (oldest flag first). */
export function loadFeedback(sqlite: Database): FeedbackCase[] {
  const flags = sqlite
    .query<{ id: number; conversation_id: number; message_id: number; note: string; created_at: string; title: string }, []>(
      `SELECT f.id, f.conversation_id, f.message_id, f.note, f.created_at, c.title
       FROM chat_feedback f JOIN chat_conversations c ON c.id = f.conversation_id ORDER BY f.id`,
    )
    .all();
  const messages = sqlite.query<MessageRow, [number, number]>(
    `SELECT id, role, content, tool_calls, tool_call_id, tool_name, status, context_path
     FROM chat_messages WHERE conversation_id = ? AND id <= ? ORDER BY id`,
  );
  return flags.map((f) => {
    const rows = messages.all(f.conversation_id, f.message_id);
    const lastUser = rows.findLastIndex((r) => r.role === "user");
    const turnRows = rows.slice(lastUser + 1);
    const status = new Map(turnRows.filter((r) => r.role === "tool").map((r) => [r.tool_call_id, r.status]));
    const calls = turnRows.flatMap((r) => {
      if (r.role !== "assistant" || !r.tool_calls) return [];
      try {
        const list = JSON.parse(r.tool_calls) as { id: string; name: string; arguments: unknown }[];
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    });
    return {
      feedbackId: f.id,
      conversationId: f.conversation_id,
      title: f.title,
      note: f.note,
      flaggedAt: f.created_at,
      turns: rows.filter((r) => r.role === "user").map((r) => ({ text: r.content, contextPath: r.context_path })),
      tools: calls.map((c) => `${c.name} ${JSON.stringify(c.arguments)} → ${status.get(c.id) ?? "?"}`),
      toolNames: calls.map((c) => c.name),
      answer: rows.at(-1)?.content ?? "",
    };
  });
}

const oneLine = (text: string, max = 400) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const deDate = (iso: string) => iso.slice(0, 10).split("-").reverse().join(".");

/** One draft case as TypeScript (an element of CASES). */
export function formatCase(f: FeedbackCase): string {
  const turns = f.turns.map((t) => `      { text: ${JSON.stringify(t.text)}${t.contextPath ? `, contextPath: ${JSON.stringify(t.contextPath)}` : ""} },`);
  const tools = [...new Set(f.toolNames)];
  return [
    `  // Feedback #${f.feedbackId} · conversation ${f.conversationId} „${oneLine(f.title, 80)}“ · flagged ${deDate(f.flaggedAt)}`,
    `  // Note: ${f.note ? `„${oneLine(f.note)}“` : "(none)"}`,
    `  // Tools of the flagged turn: ${f.tools.length ? "" : "none"}`,
    ...f.tools.map((t) => `  //   ${oneLine(t, 300)}`),
    `  // Flagged answer: „${oneLine(f.answer)}“`,
    `  {`,
    `    id: "feedback-${f.feedbackId}",`,
    `    turns: [`,
    ...turns,
    `    ],`,
    `    description: ${JSON.stringify(`TODO: ${f.note ? oneLine(f.note, 120) : "what should have happened"}`)},`,
    `    tags: ["feedback"],`,
    `    expect: {`,
    `      // TODO: the expected outcome on the demo seed, e.g. tools, forbidden, callArgs, action, confirm, facts,`,
    `      // notInAnswer, knownNumbers. The flagged turn called: ${tools.join(", ") || "no tool"}.`,
    `    },`,
    `  },`,
  ].join("\n");
}

export function formatFeedback(cases: FeedbackCase[], today = new Date().toISOString()): string {
  const head = [
    `// Draft eval cases from ${cases.length} answer(s) flagged „Antwort war falsch“ (bun run eval:feedback, ${deDate(today)}).`,
    `// They come from real conversations: adapt names, numbers and ids to the demo seed (top of chat-eval.cases.ts),`,
    `// fill in \`expect\`, then paste into CASES and run them a few times (--filter <id> --runs 3).`,
  ];
  return `${[...head, "", ...cases.map(formatCase)].join("\n")}\n`;
}

if (import.meta.main) {
  const out = process.argv[2];
  const dataDir = resolve(process.env.NESEV_DATA_DIR ?? join(import.meta.dir, "../../../data"));
  const file = process.env.NESEV_DB ?? join(dataDir, "nesev.db");
  if (!existsSync(file)) {
    console.error(`No database at ${file}`);
    process.exit(1);
  }
  const sqlite = new Database(file, { readonly: true });
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  const cases = loadFeedback(sqlite);
  sqlite.close();
  const text = formatFeedback(cases);
  if (out) {
    await Bun.write(out, text);
    console.error(`${cases.length} draft case(s) → ${out}`);
  } else process.stdout.write(text);
}
