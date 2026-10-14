import { type ChatSettings, chatSettingsSchema, type ChatStatus, DEFAULT_CHAT_SETTINGS } from "../../shared/chat";
import type { OcrSettings } from "../../shared/receipts";
import type { DbOrTx } from "../db/client";
import { settings } from "../db/schema";
import { type LlamaLease, satisfies } from "../lib/llama/lease";
import { discoverModels, type FsDeps, type GgufModel, modelAlias, nodeFs } from "../lib/llama/paths";
import type { LlamaConfig, LlamaServerManager } from "../lib/llama/server";
import { ggufLabel, llamaDownloadHint, resolveLlama } from "./receipt-llama";
import { getOcrSettings } from "./receipt-settings";
import { getSettings } from "./settings";

// Assistant settings (settings.chat_settings JSON; null → defaults, unknown or invalid keys fall back per field) and
// the llama-server config for chat. The binary is the one configured for receipt recognition. An empty model path
// means "like receipt recognition": the OCR model (configured or auto-picked, Qwen3.5-4B first), so both share one
// server; chat runs text-only with its own (larger) context, which OCR then reuses (lib/llama/lease.ts).

export function getChatSettings(db: DbOrTx): ChatSettings {
  const raw = getSettings(db).chatSettings;
  const out: ChatSettings = { ...DEFAULT_CHAT_SETTINGS };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(chatSettingsSchema.shape) as (keyof ChatSettings)[]) {
      const parsed = chatSettingsSchema.shape[key].safeParse((raw as Record<string, unknown>)[key]);
      if (parsed.success) (out as unknown as Record<string, unknown>)[key] = parsed.data;
    }
  }
  return out;
}

export function updateChatSettings(db: DbOrTx, data: ChatSettings): ChatSettings {
  getSettings(db); // creates the singleton row if missing
  db.update(settings).set({ chatSettings: data }).run();
  return getChatSettings(db);
}

export interface ResolvedChatModel {
  binary: string | null;
  binaryError: string | null;
  model: string;
  /** model path left empty: the receipt recognition's model */
  auto: boolean;
  label: string;
}

export function resolveChatModel(
  chat: ChatSettings,
  ocr: OcrSettings,
  fs: FsDeps = nodeFs,
  discover: () => GgufModel[] = () => discoverModels(fs),
): ResolvedChatModel {
  const r = resolveLlama(ocr, chat.modelPath ? { modelPath: chat.modelPath } : {}, fs, discover);
  return {
    binary: r.binary.path,
    binaryError: r.binary.path === null ? r.binary.error : null,
    model: r.model,
    auto: !chat.modelPath,
    label: r.auto ? ggufLabel(r.auto) : r.model ? modelAlias(r.model) : "",
  };
}

/** German reason why the assistant can't start a model, or null. */
export function chatProblem(r: ResolvedChatModel, fs: FsDeps = nodeFs): string | null {
  if (r.binary === null) return r.binaryError ?? "llama-server nicht gefunden";
  if (!r.model) return llamaDownloadHint();
  if (!fs.isFile(r.model)) return `Modelldatei nicht gefunden: ${r.model}`;
  return null;
}

/** Text-only config for chat; throws with a German message when the binary or model is missing. */
export function chatLlamaConfig(chat: ChatSettings, ocr: OcrSettings, fs: FsDeps = nodeFs, discover?: () => GgufModel[]): LlamaConfig {
  const r = resolveChatModel(chat, ocr, fs, discover);
  const problem = chatProblem(r, fs);
  if (problem) throw new ChatModelError(problem);
  return { binary: r.binary!, model: r.model, mmproj: null, contextSize: chat.contextSize };
}

export class ChatModelError extends Error {}

export function chatStatus(
  db: DbOrTx,
  manager: Pick<LlamaServerManager, "activeConfig">,
  fs: FsDeps = nodeFs,
  discover?: () => GgufModel[],
): ChatStatus {
  const chat = getChatSettings(db);
  const r = resolveChatModel(chat, getOcrSettings(db), fs, discover);
  const problem = chatProblem(r, fs);
  const active = manager.activeConfig();
  const running =
    !problem && !!active && satisfies(active, { binary: r.binary!, model: r.model, mmproj: null, contextSize: chat.contextSize });
  return {
    enabled: chat.enabled,
    ready: !problem,
    model: r.model ? { path: r.model, label: r.label, auto: r.auto } : null,
    running,
    problem,
  };
}

/**
 * After saving the chat settings: an idle server that was last used by the assistant and no longer fits the new
 * chat config is stopped (frees memory; the next message starts the right one).
 */
export async function syncChatServer(
  db: DbOrTx,
  manager: Pick<LlamaServerManager, "activeConfig" | "stop">,
  lease: Pick<LlamaLease, "busy" | "recentlyUsed">,
  workerBusy: boolean,
): Promise<void> {
  const active = manager.activeConfig();
  if (!active || lease.busy || workerBusy || !lease.recentlyUsed("chat")) return;
  const chat = getChatSettings(db);
  let wanted: LlamaConfig | null = null;
  try {
    wanted = chat.enabled ? chatLlamaConfig(chat, getOcrSettings(db)) : null;
  } catch {
    wanted = null;
  }
  if (!wanted || !satisfies(active, wanted)) await manager.stop();
}
