import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { TranscribeResult, VoiceSettings, VoiceStatus, WhisperModelInfo } from "@shared/voice";
import { parseResponse, transcribe } from "./client";
import { keys } from "./keys";

// Spracheingabe (voice input for the assistant, contract in src/shared/voice.ts). The WAV upload is a raw body,
// which hc can't type, so it's a plain fetch against the client's URL.

export const voiceApi = {
  settings: (): Promise<VoiceSettings> => parseResponse(transcribe.settings.$get()),
  updateSettings: (json: VoiceSettings): Promise<VoiceSettings> => parseResponse(transcribe.settings.$put({ json })),
  status: (): Promise<VoiceStatus> => parseResponse(transcribe.status.$get()),
  models: (): Promise<WhisperModelInfo[]> => parseResponse(transcribe.models.$get()),
  /** 16 kHz mono 16-bit WAV (encodeWav from @shared/wav) → text; throws Error with the server's German message */
  async transcribe(wav: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<TranscribeResult> {
    const res = await fetch(transcribe.index.$url(), {
      method: "POST",
      body: new Blob([wav], { type: "audio/wav" }),
      headers: { "content-type": "audio/wav" },
      signal,
    });
    const body = (await res.json().catch(() => null)) as (TranscribeResult & { error?: string }) | null;
    if (!res.ok || !body) throw new Error(body?.error ?? `Transkription fehlgeschlagen (Fehler ${res.status})`);
    return body;
  },
};

export type { TranscribeResult, VoiceSettings, VoiceStatus, WhisperModelInfo } from "@shared/voice";

export const voiceSettingsQuery = queryOptions({ queryKey: keys.voice.settings, queryFn: voiceApi.settings });

export const voiceStatusQuery = queryOptions({ queryKey: keys.voice.status, queryFn: voiceApi.status, staleTime: 10_000 });

export const whisperModelsQuery = queryOptions({ queryKey: keys.voice.models, queryFn: voiceApi.models });

export function useUpdateVoiceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: voiceApi.updateSettings,
    onSuccess: (saved) => {
      qc.setQueryData(keys.voice.settings, saved);
      void qc.invalidateQueries({ queryKey: keys.voice.status });
    },
  });
}
