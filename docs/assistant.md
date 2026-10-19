# Assistant, voice input and MCP server

How nesev's AI features work: the in-app assistant (a small local model driving the MCP tools), voice input, and the
MCP server for external clients. Everything runs locally; nesev never downloads models. General architecture:
[architecture.md](architecture.md). Setup and the tool list of the MCP server: [src/mcp/README.md](../src/mcp/README.md).
The assistant eval: [src/server/eval/README.md](../src/server/eval/README.md).

Contents: [MCP server](#mcp-server) · [Assistant backend](#assistant-backend) · [Guards for small models](#guards-for-small-models) ·
[Assistant UI](#assistant-ui) · [Voice input](#voice-input-spracheingabe) · [Eval and measurements](#eval-and-measurements)

---

## MCP server
`src/mcp`, `bun run mcp`. Details, setup and conventions in [src/mcp/README.md](../src/mcp/README.md).

- Local stdio MCP server for AI clients (Claude Code / Desktop). It uses the same data dir as the nesev server
  (`NESEV_DATA_DIR`, else the one chosen in the first-start setup) and refuses to start before the setup. Web links
  use `NESEV_WEB_URL` (default `http://localhost:<PORT>`, PORT defaults to 3998).
- SDK v2 (`@modelcontextprotocol/server`, pinned) via `serveStdio` with `legacy: 'serve'`, so 2025-era (`initialize`)
  and 2026-07-28 clients both work.
- In-process: typed `hc` clients per route module whose `fetch` is `app.fetch` (no HTTP, no port, no raw SQL).
  Validation, rules and German error messages come from the routes; a non-2xx becomes a tool error with the API's
  message. It never imports the server entry (`src/server/index.ts` / `main.ts`), so no schedulers, OCR queue or
  llama-server run in the MCP process; it exits when stdin closes.
- stdout is reserved for JSON-RPC: `stdout-guard.ts` (first import of `server.ts`) routes `console.log/info/debug`
  to stderr. `build.ts` is the importable server without the guard (used by the assistant).
- Read tools (`readOnlyHint`) come first in a fixed order, then write tools: creates (`destructiveHint: false`) and
  state changes (`destructiveHint: true`: finalize, mark sent/paid, convert, credit note, reminder, bank matching,
  record updates …). No delete, settings, bank import or email tools.
- Receipt analysis never runs in the MCP process: `api.ts` refuses non-GET `/api/receipts` in-process.
  `queue_receipt_analysis` calls the running nesev server over HTTP (`NESEV_API_URL`, default
  `http://127.0.0.1:<PORT>`), first checking per expense (number, supplier, receipt path) that the server works on the
  same data, and fails clearly when it isn't reachable.
- Output: short text summary + `structuredContent` matching an `outputSchema`; money as `{ cents, formatted }`, dates
  `YYYY-MM-DD`, German status labels, web links. Money input: `euroAmount` (euro number or "1.234,56" / "1234.56").
- Tests spawn the real entry on a seeded temp dir (`src/mcp/test/seed.ts`) and drive it with the SDK client in both
  protocol eras: every tool, annotations, gapless numbering, draft-only edits, receipt upload, a fake nesev server for
  queueing, the in-process receipts guard, and a raw stdout-purity check.

## Assistant backend
Contract `src/shared/chat.ts`; server `routes/chat.ts`, `services/chat.ts` (conversations + agent loop),
`chat-llm.ts` (streaming client), `chat-tools.ts` (MCP host, tool selection, results, confirmation texts),
`chat-settings.ts` (settings, model, status). Tables `chat_conversations` / `chat_messages` (OpenAI message order;
tool results are their own rows).

**Model.** nesev's own llama-server. Settings (`settings.chat_settings` JSON, invalid/unknown keys fall back per
field): on/off, model (empty = the receipt recognition's model, i.e. the Qwen3.5-4B auto-pick, so both share one
server), context 64k by default (the KV cache costs ~32 KB per token on Qwen3.5-4B, ~2 GB at 64k, because only every
4th layer has full attention), reasoning off. The binary is the one configured for receipt recognition. Chat runs
text-only.

**Reasoning per request.** The server keeps `--reasoning off`; chat sends `chat_template_kwargs: {enable_thinking}`
per request (it overrides the flag). Thinking text is not stored; the UI gets one `thinking` event. An empty answer
after thinking is retried once without reasoning.

### Sharing llama-server with receipt OCR
`lib/llama/lease.ts`, `getLlamaLease()`: a process-wide FIFO lock around "ensure config + request". The OCR worker
takes it per receipt, chat per model call, so neither restarts the server under the other. Never call
`getLlamaServer().ensure()` directly for a request.
- A running server is reused when it satisfies the request (same binary + model, ≥ context, projector if needed):
  OCR (8k, text) runs on chat's larger server without a restart; only chat after an 8k OCR server restarts once.
- Chat keeps the server warm: after each call the 5-min idle stop is re-armed; `unloadAfterBatch` and OCR settings
  changes don't stop it while chat used it in the last 5 min; changing the chat settings stops an idle server that no
  longer fits.

### Tools
- **MCP tools in-process:** an MCP client linked to `buildServer()` (`src/mcp/build.ts`) over the SDK's
  `InMemoryTransport`, loaded lazily (src/mcp imports the app). `createServerContext()` gives app-path links
  (`/invoices/12`) and `inServer: true` (receipt POSTs served in-process, `queue_receipt_analysis` queues directly).
  MCP definitions → OpenAI `tools` (`$schema` stripped). Results: text → model; structured content →
  `ChatToolResult` (first line as summary; links, max 6).
- **Tool routing** (`selectToolsDetailed` + `GROUP_ROUTES` in `chat-tools.ts`): every MCP tool has a group
  (`_meta["nesev/group"]`: core, documents, clients, expenses, bank, finance; UI tools: ui). Each request gets core +
  ui, plus every group whose German words match the current or previous user message (ambiguous "weak" words like
  „bezahlt“, „offen“, „Zahlung“, „ändern“ only when no other group is named), whose pages the user is on
  (`contextPath`), or whose tools ran in the last turns. Nothing matched → the read tools of all groups (plus every
  write tool for a generic write verb like „leg … an“). A short pure navigation request gets core + ui only.
  - Tools are ordered by `TOOL_GROUPS`, so the prefix (system prompt + core/ui) stays cached across group sets.
  - Over budget (small contexts): write tools of groups matched only by page/recent use go first, then all non-core
    writes.
  - Why: ~47 tools ≈ 20k tokens don't fit a 32k context next to the history, and a 4B model picks better from a short
    list. Group sizes (estimate, 2.7 chars/token): core 0.9k, ui 1.1k, documents 7.4k, expenses 5.8k, clients 1.9k,
    bank 1.6k, finance 1.6k; all read tools ≈ 6.7k.
  - **A new MCP tool needs** a `group` in `defineTool`, a card builder in `chat-cards.ts` if it returns a list or
    figures, and new German keywords in `GROUP_ROUTES` if its group's words don't cover it.
- **UI tools** (`chat-ui-tools.ts`, group ui, assistant-only, no confirmation): `open_in_app {what, id? | number?}`
  (→ `navigate`), `open_pdf {id? | number?, type}` (→ `open_tab`; drafts render as preview), `download_pdf` (→
  `download`). Ids are checked; a `number` like „RE-2026-0004“ or a `query` (name) is resolved via `search` (a query
  must be unique, otherwise the candidates come back so the model asks). Deterministic nudges (`nudgeUiCall`):
  open_pdf → download_pdf when the user says „herunterladen“; in a pure navigation request naming a record type, a
  `search` becomes `open_in_app {what, query}`. `withUiTools()` composes them with the MCP host.
- **Cards** (`chat-cards.ts`, generative UI, built from structured content only; a result may carry several, stacked
  in the UI): dashboard and forecast charts, tax KPIs, document cards (with PDF url and status), tables for the
  list tools (≤ 8 rows + `more`, total), bank overview/transactions, recurring invoices, change tables (Feld, vorher,
  nachher) for record updates, an AfA chart for `create_asset`. The model's copy of the result notes that the user
  already sees the card, and the prompt asks for 1–3 sentences instead of repeating it.

### Agent loop
- History from the DB, capped by an estimate of 2.7 chars/token: old tool results are cut to 600 chars first, then
  the oldest turns dropped.
- Streamed `/v1/chat/completions`: temperature 0.4 (override `NESEV_CHAT_TEMPERATURE` for experiments), top_p 0.8,
  top_k 20, `parallel_tool_calls: false`, max 2048 tokens (8192 with reasoning). Deltas → SSE; tool calls are parsed
  from streamed chunks and executed, up to 8 model calls per turn.
- The first call of a data question ("Umsatz", "Rechnung", numbers, months, „öffne“, „PDF“, …) uses
  `tool_choice: "required"` (the 4B otherwise invented figures). If it still answers with text, that text is held
  back and the call retried once.
- **Confirmation:** tools with `destructiveHint` (= `CONFIRM_TOOLS`; a test keeps them in sync) are not executed: the
  tool row is stored `pending` with a German summary (e.g. "Rechnung (Entwurf, id 6) für Alpen Software GmbH über
  € 540,00 finalisieren – vergibt die Nummer …"; record updates show „Label: vorher → nachher“), and `confirm` ends
  the stream. `POST /confirm` executes (and continues the loop) or cancels: a rejection ends the turn with a fixed
  reply per tool, without a model call; the model sees „abgelehnt, nichts geändert“ in later turns. New messages
  while a confirmation is pending or a reply runs → 409.
- **Prompt:** German, today's date, company name, amounts `€ 1.234,56`, search before guessing ids, numbers only from
  tool results, drafts first (no number yet), tax = helper, deletes/settings/bank/email → web app, Markdown links
  with app paths. The page context goes into the user message ("(Kontext: Der Nutzer sieht gerade Rechnung id 12
  („…“). Gilt nur für „diese/hier/davon“.)"), not the system prompt, so the cached prefix stays stable.
- **SSE:** `event: <type>` + `data: <json>`; `: ping` comments every 5 s (Bun.serve closes connections idle for
  10 s; a cold first prompt takes longer). A client disconnect aborts the llama request; partial text is kept.
- **Warm-up** (`chat-warm.ts`, `POST /api/chat/warm`): the panel calls it when it opens (model ready, at most every
  30 s). In the background it starts the chat llama-server under the lease and primes its prompt cache with a
  one-token completion of the system prompt + core/ui tools. Returns at once: `warming`, `warm`, `busy` (a receipt
  batch runs or someone holds the lease – it never queues or restarts under OCR), `disabled`, `unavailable`.
- **Receipts uploaded in the chat** (`chat-uploads.ts`, `recordUploads` in `chat.ts`,
  `POST /api/chat/conversations/:id/uploads`): stored as a `user` message whose `tool_result` JSON is
  `{kind: "uploads", uploads: [...], failures}` and whose content is one German line per receipt („Hochgeladener
  Beleg: Ausgabe ER-2026-0014 (id 14), Entwurf ohne Lieferant und Positionen, Datei „kassenbon.png“.“). No model call.
  `buildHistory` puts these lines in front of the next user message, plus a hint generated at request time: change
  exactly that expense by its id; the amount is unknown, so `lines`/`category` only with an amount from the user or
  `get_receipt_analysis`, else ask. While at most 3 user messages followed the last upload, the expenses group is
  always offered.
- **„Antwort war falsch“** (`chat-feedback.ts`, table `chat_feedback`): a flag button under each finished answer with
  an optional note. `bun run eval:feedback` turns flags into draft eval cases.

## Guards for small models
A 4B model makes predictable mistakes; these guards catch them deterministically. Each logs a line the eval counts.

- **Malformed calls:** bad JSON / unknown tool → tool error back to the model; the same failing call repeated
  unchanged isn't executed again; the 2nd such incident ends the turn with a German error. A repetition loop in the
  text (a block ≥ 60 chars 3×) is cut and generation stopped (`repetition loop cut`).
- **Id provenance** (`chat-provenance.ts`): state-changing calls and creates that reference existing records (table
  `ID_ARGS`, e.g. `match_bank_transaction` id → booking, `create_invoice_draft` clientId) may only use ids established
  in the conversation: in a successful tool result, typed by the user, behind a record number the user named, or the
  page record when the message refers to it. Otherwise the call is not run and the model is told to look it up first
  (`not looked up`). Motivation: even a 9B model matched bank bookings with guessed ids.
- **Page context** (`chat-context.ts`): a call on the context record's id is not run when the message has no deictic
  word („diese/hier/davon“) and names something else (another number, „Entwurf“ for a finalized document, another
  name after für/von/bei). The model is told to search; once per record and turn.
- **Claimed but not done** (`chat-claims.ts`): in a turn where the user asked for a change (`isWriteRequest`:
  imperative write verbs such as ordne zu, erstelle, ändere, markiere, leg an, finalisiere; or a short „ja“ after
  „Soll ich …?“), model text is held back until the turn's outcome is known. A final answer that claims an action in
  own-action phrasing („habe … zugeordnet“, „wurde erstellt“, „ist jetzt markiert“, „erledigt“) without a successful
  or pending call of a matching evidence tool in this turn is discarded and retried once with a correction; a second
  one is replaced by a fixed reply („Das ist noch nicht erledigt: …“). Negations, questions, offers, conditionals and
  data descriptions („wurde am 3.10. erstellt“, „bereits zugeordnet“) don't count. Not checked: claims that contradict
  tool data. Log `claim-guard …`.
- **Offered instead of acting** (`chat-offers.ts`): in a write turn, a final answer that offers the requested action
  („Soll ich … erstellen?“) instead of calling the tool is retried once with „Der Nutzer hat diese Aktion bereits
  verlangt …“ – only when this turn's lookups left exactly one plausible record per slot (table `OFFER_RULES`), the
  tool hasn't run, the request isn't a question and no value is missing. Log `offer-nudge …`.
- **Invented record numbers** (`chat-numbers.ts`): every record number in an answer (RE/AN/GS/MA/ER-YYYY-NNNN,
  K-/AV-NNNN; case and zero padding ignored) must appear in the conversation (tool results, the user's text, the page
  title). Streamed text runs through a `NumberGate` that holds a number until it's complete and stops at the first
  unknown one, so a fake is never shown. A final answer with an unknown number is discarded and retried once; a second
  one gets neutral wording (the number dropped, a link label becomes „Entwurf“ or the type) via a `replace` event.
  Log `number-guard …`.
- **Guessed amounts:** an `update_expense` with `lines` on a draft uploaded in the chat whose amounts neither the user
  typed nor a tool result showed isn't run; the model is told to ask or read `get_receipt_analysis` (log
  `guessed amount`). Without it, the 4B made up amounts for „Bewirtung …, bar bezahlt“.

## Assistant UI
`features/chat/`, `sdk/chat.ts`.

- Side panel on the right (420 px, pushes the content), toggled with **⌘J / Ctrl+J** or the round floating button at
  the bottom right (`chat-fab.tsx`). While the button shows, `--fab-space` on `<html>` widens the right padding of
  sticky action bars. The button is hidden while the panel is open, when the assistant is disabled and on the
  template designer, and shows a dot while a reply streams (green) or a confirmation waits (amber), via
  `setChatActivity` in `chat-store.ts`. Esc closes the panel. Open state and the selected conversation persist in
  localStorage `nesev.chat`. Once opened it stays mounted, so an answer keeps streaming while the panel is closed.
- Header: status dot (`GET /status`), title (click to rename), „Neu“ (created on the first message), history dropdown,
  link to Einstellungen#assistent.
- Streaming: `streamChat()` POSTs and parses the `text/event-stream` itself (`sdk/sse.ts`, tested incl. split chunks
  and split UTF-8). Events are applied to the cached conversation detail (`applyEvent` in `use-chat-session.ts`); at
  the end of a turn the conversation and list are refetched and the views the turn's write tools touched are
  invalidated (`chatToolChanges`).
- Messages: assistant text through a small Markdown subset (`markdown.ts` parser → AST → React, never raw HTML; links
  only to app paths, `/api/files/…` and http(s); file-system paths stay text). Tool calls as compact cards (German
  label + icon per tool in `tools.ts`). A confirmation card for pending calls („Ausführen“ / „Abbrechen“) locks the
  composer until answered.
- Composer: autosizing textarea, Enter sends / Shift+Enter newline, Stop, disabled with the reason + settings link
  when the model isn't ready. Sends `context { path, title }` of the current page.
- **Receipts in the chat** (`chat-uploads.tsx`): paperclip or drop files on the panel; PDF/JPG/PNG/WebP. The files go
  through the normal quick capture (`POST /api/expenses/drafts`, one incomplete draft per file, nothing analysed),
  then the upload message is recorded and shown as a card per receipt: thumbnail, number, Entwurf/erfasst, „Ausgabe
  öffnen“, „Erkennung starten“ (queues the analysis; never automatic) with live status, and „Vorschläge ansehen“.
- Settings section „Assistent“ (`#assistent`): status rows, enable switch, model path + picker of discovered GGUFs,
  context size 8k–64k, reasoning switch.

## Voice input (Spracheingabe)
`shared/voice.ts`, `shared/wav.ts`, `routes/transcribe.ts` (`/api/transcribe`), `services/voice.ts`, `lib/whisper/*`,
`features/chat/voice-*`, `sdk/voice.ts`.

- Mic button in the composer: click to start/stop or hold to talk, cancel, timer + level bars, max 2 min.
- The browser records with getUserMedia + an AudioWorklet, resamples to 16 kHz mono and encodes a 16-bit WAV itself
  (no ffmpeg). The server checks the WAV header/length, skips silent clips (peak RMS < 0.005; whisper turns silence
  into „Amen.“), writes a temp file, runs **whisper.cpp** `whisper-cli -nt -np -sns` once per request (serialized)
  and returns the text. The text is appended to the input, never sent automatically.
- No resident server: with the model in the file cache, `ggml-large-v3-turbo-q5_0` (574 MB) transcribes 5–18 s of
  German speech in 0.5–0.7 s on Apple Silicon (first run after boot ~4 s).
- Model discovery like the GGUFs (`~/Library/Caches/whisper.cpp`, `~/.cache/whisper.cpp`, HF cache
  `ggerganov/whisper.cpp`, `~/whisper.cpp/models`, VoiceInk's models); empty path = auto-pick (large-v3-turbo, then
  large/medium/small/base; `*.en` only for English; quantized first). A missing binary shows `brew install
  whisper-cpp`, a missing model a download command.
- Settings „Spracheingabe“ (`#spracheingabe`): on/off, language (Deutsch default / Englisch / automatisch), model path
  + picker; stored under `settings.chat_settings.voice`.

## Eval and measurements
- `bun run eval:chat` (`src/server/eval/`, see its [README](../src/server/eval/README.md)) runs German cases
  (navigation, PDFs, page context, ambiguity, facts from tool results, tax, bank, rejected confirms, multi-turn
  follow-ups, drafts, invented numbers) against the real model on fresh demo data and scores tool path, action,
  confirm and key facts. Run it after changes to routing, the prompt, the guards, the tools or the model.
- Baseline (Qwen3.5-4B, 24 cases): 86 % pass over two runs before the number guard; 24/24 in one run after it, turn
  median ~5 s, p90 ~12 s. Remaining weak spots: the 4B occasionally claims a bank match or a draft without calling the
  tool (caught by the claim guard), sometimes picks `open_pdf` for „herunterladen“, or answers „Öffne die Ausgabe von
  A1“ without opening it.
- Measured on an M5 Pro, Qwen3.5-4B UD-Q4_K_XL, 32k context, all tools: server start 1.3–1.8 s; first prompt of a
  fresh server (≈ 13.5k tokens) 8.5–9 s to the first token; later calls 0.2–1.7 s to the first token (prompt cache),
  2–6 s per call; a full "Rechnungsentwurf anlegen" turn ~7–20 s. With routing: 7–32 tools, 2.5k–16k prompt tokens;
  first token 2–6 s when the group set changes, 0.1–0.7 s when cached.
- Qwen3.8-27B UD-Q5_K_XL: start 24 s, first prompt 43 s, then ~1 s to the first token and ~10 tok/s; it got every
  step right on the first try. The 4B needs the guards (it dropped item titles until `title` became required in the
  schema, invented numbers without forced tool use, repeated paragraphs).
