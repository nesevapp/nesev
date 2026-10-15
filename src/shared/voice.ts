import { z } from "./schemas/zod";

// Voice input for the assistant ("Spracheingabe"): the browser records, encodes 16 kHz mono WAV (shared/wav.ts) and
// posts it; the server transcribes it fully locally with whisper.cpp (`whisper-cli`, one process per request) and
// returns the text, which goes into the chat input (never sent automatically).
//
// Endpoints (mounted at /api/transcribe, routes/transcribe.ts):
//   POST /            body: audio/wav (16-bit PCM)   → TranscribeResult
//   GET  /status                                     → VoiceStatus
//   GET  /models                                     → WhisperModelInfo[] (ggml models found on disk)
//   GET  /settings / PUT /settings                   VoiceSettings
// Settings live in settings.chat_settings under the key `voice` (no own column).

export const VOICE_LANGUAGES = ["de", "en", "auto"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];
export const VOICE_LANGUAGE_LABELS: Record<VoiceLanguage, string> = {
  de: "Deutsch",
  en: "Englisch",
  auto: "Automatisch erkennen",
};

export interface VoiceSettings {
  enabled: boolean;
  /** ggml model file (whisper.cpp); "" = auto (prefers large-v3-turbo) */
  modelPath: string;
  language: VoiceLanguage;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { enabled: true, modelPath: "", language: "de" };

export const voiceSettingsSchema = z.object({
  enabled: z.boolean(),
  modelPath: z.string().trim().max(1000),
  language: z.enum(VOICE_LANGUAGES),
});

/** Longest recording; the browser stops at this length and the server rejects longer audio. */
export const VOICE_MAX_SECONDS = 120;
/** upper bound of a WAV body: 16 kHz × 16 bit × VOICE_MAX_SECONDS plus header slack */
export const VOICE_MAX_BYTES = 16_000 * 2 * VOICE_MAX_SECONDS + 64 * 1024;

export interface WhisperModelInfo {
  path: string;
  /** "large-v3-turbo-q5_0" */
  name: string;
  sizeBytes: number;
  /** English-only model (*.en) */
  englishOnly: boolean;
}

export interface VoiceStatus {
  enabled: boolean;
  /** whisper-cli and a model are there */
  ready: boolean;
  /** German reason why it isn't ready (may contain `code`), null when ready or disabled */
  problem: string | null;
  binary: string | null;
  model: { path: string; label: string; auto: boolean } | null;
  language: VoiceLanguage;
}

export interface TranscribeResult {
  /** "" when nothing was said */
  text: string;
  audioMs: number;
  /** whisper run time */
  elapsedMs: number;
}
