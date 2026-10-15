import { useCallback, useEffect, useRef, useState } from "react";
import { VOICE_MAX_SECONDS } from "@shared/voice";
import { encodeWav, resample } from "@shared/wav";
import { voiceApi } from "@/sdk";

// Microphone recording for voice input: getUserMedia → AudioWorklet collecting Float32 frames → on stop, resample to
// 16 kHz mono, encode WAV (@shared/wav) and transcribe on the server. Stops by itself after VOICE_MAX_SECONDS.

export type VoicePhase = "idle" | "starting" | "recording" | "transcribing";

/** collects ~85 ms batches of channel 0 and posts them to the main thread */
const WORKLET = `
class NesevRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(4096); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("nesev-recorder", NesevRecorder);
`;

/** German message for getUserMedia / AudioContext failures */
export function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Kein Zugriff aufs Mikrofon – im Browser erlauben (Schloss-Symbol in der Adressleiste) und erneut versuchen.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Kein Mikrofon gefunden.";
  if (name === "NotReadableError" || name === "AbortError") return "Das Mikrofon ist gerade nicht verfügbar (von einer anderen App belegt?).";
  return `Aufnahme nicht möglich: ${err instanceof Error ? err.message : String(err)}`;
}

/** Text after the transcript was added to what's already typed. */
export function appendTranscript(current: string, text: string): string {
  const head = current.trimEnd();
  if (!head) return text;
  return `${head}${current.endsWith("\n") ? "\n" : " "}${text}`;
}

interface Session {
  stream: MediaStream;
  ctx: AudioContext;
  chunks: Float32Array[];
  timer: ReturnType<typeof setInterval>;
}

export function useVoiceRecorder({ onText, onError }: { onText: (text: string) => void; onError: (message: string) => void }) {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const session = useRef<Session | null>(null);
  const upload = useRef<AbortController | null>(null);
  const startedAt = useRef(0);
  /** bumped on cancel/unmount so a pending getUserMedia doesn't start recording afterwards */
  const generation = useRef(0);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };

  const teardown = useCallback(() => {
    const s = session.current;
    session.current = null;
    if (!s) return null;
    clearInterval(s.timer);
    for (const track of s.stream.getTracks()) track.stop();
    void s.ctx.close().catch(() => {});
    return s;
  }, []);

  const stop = useCallback(async () => {
    const s = teardown();
    if (!s) return;
    setLevel(0);
    const total = s.chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const c of s.chunks) {
      samples.set(c, offset);
      offset += c.length;
    }
    const wav = encodeWav(resample(samples, s.ctx.sampleRate));
    const abort = new AbortController();
    upload.current = abort;
    setPhase("transcribing");
    try {
      const result = await voiceApi.transcribe(wav, abort.signal);
      if (result.text) callbacks.current.onText(result.text);
      else callbacks.current.onError("Nichts verstanden – bitte näher am Mikrofon noch einmal sprechen.");
    } catch (err) {
      if (!abort.signal.aborted) callbacks.current.onError(err instanceof Error ? err.message : String(err));
    } finally {
      if (upload.current === abort) {
        upload.current = null;
        setPhase("idle");
      }
    }
  }, [teardown]);

  const start = useCallback(async () => {
    if (session.current || upload.current) return;
    const gen = ++generation.current;
    setPhase("starting");
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Spracheingabe braucht http://localhost oder HTTPS.");
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (gen !== generation.current) throw new DOMException("cancelled", "AbortError");
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "nesev-recorder");
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(node).connect(mute).connect(ctx.destination);
      const chunks: Float32Array[] = [];
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        chunks.push(e.data);
        let sum = 0;
        for (const v of e.data) sum += v * v;
        // RMS → 0…1 on a rough dB scale (−50 dB … 0 dB)
        const db = 20 * Math.log10(Math.sqrt(sum / e.data.length) || 1e-6);
        setLevel(Math.max(0, Math.min(1, (db + 50) / 50)));
      };
      startedAt.current = performance.now();
      setElapsedMs(0);
      const timer = setInterval(() => {
        const ms = performance.now() - startedAt.current;
        setElapsedMs(ms);
        if (ms >= VOICE_MAX_SECONDS * 1000) void stop();
      }, 200);
      session.current = { stream, ctx, chunks, timer };
      setPhase("recording");
    } catch (err) {
      for (const track of stream?.getTracks() ?? []) track.stop();
      void ctx?.close().catch(() => {});
      if (gen !== generation.current) return;
      setPhase("idle");
      callbacks.current.onError(err instanceof DOMException ? micErrorMessage(err) : err instanceof Error ? err.message : String(err));
    }
  }, [stop]);

  const cancel = useCallback(() => {
    generation.current++;
    teardown();
    upload.current?.abort();
    upload.current = null;
    setLevel(0);
    setPhase("idle");
  }, [teardown]);

  useEffect(
    () => () => {
      generation.current++;
      teardown();
      upload.current?.abort();
    },
    [teardown],
  );

  return { phase, elapsedMs, level, start, stop, cancel };
}
