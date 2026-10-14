# Assistant eval (`bun run eval:chat`)

Runs nesev's in-app assistant against the real local model on demo data and scores every case. It's not part of
`bun test`, because it needs llama-server and a GGUF. Run it after changes to tool routing, the system prompt, the
guards (forced tool call, page context, id provenance, nudges), the MCP tools or the model.

```bash
bun run eval:chat                                  # all cases, once, the auto-picked model (Qwen3.5-4B)
bun run eval:chat --runs 2 --json /tmp/eval.json   # two runs per case, full results as JSON
bun run eval:chat --filter confirm                 # a tag or case id (comma-separated)
bun run eval:chat --model ~/models/x.gguf --reasoning --context 32768
bun run eval:chat --min 80                         # exit code 1 if the pass rate is below 80 %
```

| Flag | Default | |
|---|---|---|
| `--model <gguf>` / `auto` | `auto` | chat model; auto = the same pick as the app (Qwen3.5-4B preferred) |
| `--runs N` | 1 | runs per case |
| `--filter <id\|tag>` | all | e.g. `nav`, `bank`, `confirm`, `context`, `hard`, `facts`, `multi-turn` |
| `--reasoning` | off | `chat_template_kwargs.enable_thinking` per request |
| `--context N` | the app default (64k) | context size of the chat server |
| `--json <file>` | – | totals and every case result |
| `--min <pct>` | – | minimum pass rate in %, else exit code 1 |
| `--timeout <s>` | 240 | per turn |

## How it runs
- Seeds a temp data dir once (`src/mcp/test/seed.ts`; dates relative to today), then starts its own API
  (`src/server/index.ts`) on a free port with a copy of it, `NESEV_API_URL` pointing nowhere. One API and one
  llama-server serve all cases; after a case that changed data (a successful write tool, e.g. the draft case),
  the API restarts on a fresh copy of the seed.
- Drives `/api/chat` like the UI: one conversation per case, all turns of a case in it, every confirmation
  rejected. Per-step stats (prompt tokens, first token, total) and guard hits come from the API's log
  (`[chat] conv … step …`, "forced tool call", "nudged", "not looked up") and from tool results (context guard,
  repeated failing call).
- Stops its API and llama-server by PID, also on Ctrl-C and errors, and deletes its temp dirs. It never uses
  `data/` or ports 3998/5174.

## Cases (`chat-eval.cases.ts`)
Each case has an id, one or more German turns (optionally with `contextPath`/`contextTitle`), tags, and an
expectation for the last turn:
- `tools` (`ordered`), `anyTool`, `forbidden`;
- `callArgs`: a subset of a successful call's arguments;
- `action`: navigate path, download URL/file name, open_tab URL, or `"none"`;
- `confirm`: the tool and an argument subset (`exact` = no other arguments); `false` = none allowed;
- `facts`: strings, regexes, or functions that take a figure from a tool result, all of which the answer must contain;
- `notInAnswer`: e.g. an invented draft number.

Verdicts: **fail** = an error, a missing or forbidden tool, a wrong action or a missing/wrong confirm. **partial** =
the right path but facts missing, details off (arguments, open instead of download) or a confirm without a
lookup. **pass** otherwise. The pass rate counts passes only; "weighted" counts a partial as half.

To add a case, describe the expected outcome against the seed (ids and facts are listed at the top of the cases
file) and run it a few times (`--filter <id> --runs 3`) before relying on it. The pure parts (judging, parsing, the
table) are unit-tested in `chat-eval.test.ts`.
