import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_VOICE_SETTINGS,
  type TranscribeResult,
  VOICE_MAX_BYTES,
  VOICE_MAX_SECONDS,
  type VoiceSettings,
  voiceSettingsSchema,
  type VoiceStatus,
} from "../../shared/voice";
import { parseWav, peakLevel } from "../../shared/wav";
import type { DbOrTx } from "../db/client";
import { settings } from "../db/schema";
import { type FsDeps, nodeFs } from "../lib/llama/paths";
import { AbortedError, CommandError } from "../lib/ocr/run";
import { discoverWhisperModels, findWhisperCli, resolveWhisperModel, whisperInstallHint } from "../lib/whisper/paths";
import { type CommandRunner, defaultRunner, runWhisper } from "../lib/whisper/run";
import { getSettings } from "./settings";

// Voice input (contract in src/shared/voice.ts). Settings are the `voice` key of settings.chat_settings (invalid
// fields fall back per field, the assistant's own keys are left alone). Transcription writes the WAV to a fresh
// temp dir, runs whisper-cli on it and removes the dir again; runs are serialized (one at a time on the GPU).

/** below this peak RMS (≈ −46 dBFS) a recording is treated as silence – whisper would invent "Amen." or similar */
export const SILENCE_LEVEL = 0.005;

export class VoiceError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 499 | 500 | 503,
    message: string,
  ) {
    super(message);
  }
}

function chatSettingsObject(db: DbOrTx): Record<string, unknown> {
  const raw = getSettings(db).chatSettings;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function getVoiceSettings(db: DbOrTx): VoiceSettings {
  const raw = chatSettingsObject(db).voice;
  const out: VoiceSettings = { ...DEFAULT_VOICE_SETTINGS };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(voiceSettingsSchema.shape) as (keyof VoiceSettings)[]) {
      const parsed = voiceSettingsSchema.shape[key].safeParse((raw as Record<string, unknown>)[key]);
      if (parsed.success) (out as unknown as Record<string, unknown>)[key] = parsed.data;
    }
  }
  return out;
}

export function updateVoiceSettings(db: DbOrTx, data: VoiceSettings): VoiceSettings {
  const current = chatSettingsObject(db);
  db.update(settings).set({ chatSettings: { ...current, voice: data } }).run();
  return getVoiceSettings(db);
}

export function voiceStatus(db: DbOrTx, fs: FsDeps = nodeFs): VoiceStatus {
  const s = getVoiceSettings(db);
  const binary = findWhisperCli(fs);
  const model = resolveWhisperModel(s.modelPath, s.language, fs, () => discoverWhisperModels(fs));
  const problem = !binary ? whisperInstallHint() : model.path === null ? model.error : null;
  return {
    enabled: s.enabled,
    ready: s.enabled && !problem,
    problem: s.enabled ? problem : null,
    binary,
    model: model.path === null ? null : { path: model.path, label: model.label, auto: model.auto },
    language: s.language,
  };
}

export interface TranscribeDeps {
  run: CommandRunner;
  fs: FsDeps;
  now: () => number;
}

export const defaultTranscribeDeps: TranscribeDeps = { run: defaultRunner, fs: nodeFs, now: () => performance.now() };

let queue: Promise<unknown> = Promise.resolve();

/** run after the previous transcription finished (successfully or not) */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

export async function transcribe(
  db: DbOrTx,
  wav: Uint8Array,
  { deps = defaultTranscribeDeps, signal }: { deps?: TranscribeDeps; signal?: AbortSignal } = {},
): Promise<TranscribeResult> {
  const s = getVoiceSettings(db);
  if (!s.enabled) throw new VoiceError(409, "Spracheingabe ist deaktiviert (Einstellungen → Assistent)");
  if (wav.length > VOICE_MAX_BYTES) throw new VoiceError(413, `Aufnahme zu lang (höchstens ${VOICE_MAX_SECONDS / 60} Minuten)`);
  const info = parseWav(wav);
  if (!info) throw new VoiceError(400, "Keine gültige WAV-Aufnahme (16-bit PCM erwartet)");
  if (info.durationMs > VOICE_MAX_SECONDS * 1000 + 1000) {
    throw new VoiceError(413, `Aufnahme zu lang (höchstens ${VOICE_MAX_SECONDS / 60} Minuten)`);
  }
  if (info.durationMs < 200 || peakLevel(wav, info) < SILENCE_LEVEL) {
    return { text: "", audioMs: info.durationMs, elapsedMs: 0 };
  }

  const binary = findWhisperCli(deps.fs);
  if (!binary) throw new VoiceError(503, whisperInstallHint());
  const model = resolveWhisperModel(s.modelPath, s.language, deps.fs, () => discoverWhisperModels(deps.fs));
  if (model.path === null) throw new VoiceError(503, model.error);

  return serialized(async () => {
    if (signal?.aborted) throw new VoiceError(499, "Abgebrochen");
    const dir = mkdtempSync(join(tmpdir(), "nesev-voice-"));
    try {
      const wavPath = join(dir, "input.wav");
      writeFileSync(wavPath, wav);
      const started = deps.now();
      const text = await runWhisper({ binary, model: model.path, language: s.language, wavPath }, { run: deps.run, signal });
      return { text, audioMs: info.durationMs, elapsedMs: Math.round(deps.now() - started) };
    } catch (err) {
      if (err instanceof AbortedError) throw new VoiceError(499, "Abgebrochen");
      if (err instanceof CommandError) throw new VoiceError(500, `Transkription fehlgeschlagen: ${err.message}`);
      throw err;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
