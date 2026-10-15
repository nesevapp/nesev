// 16-bit PCM WAV for voice input: the browser records Float32 samples at the device rate, resamples to 16 kHz mono
// and encodes a WAV (no ffmpeg needed); the server parses the header to check format and length before running
// whisper.cpp. Pure functions, used by web (features/chat/voice-*) and server (services/voice.ts).

export const VOICE_SAMPLE_RATE = 16_000;
const HEADER_BYTES = 44;

/** Linear-interpolation resampling with a box filter when downsampling (good enough for speech). */
export function resample(samples: Float32Array, fromRate: number, toRate = VOICE_SAMPLE_RATE): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.max(1, Math.floor(samples.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const start = i * ratio;
    if (ratio > 1) {
      // average the source samples this output sample covers (crude low-pass against aliasing)
      const from = Math.floor(start);
      const to = Math.min(samples.length, Math.max(from + 1, Math.floor(start + ratio)));
      let sum = 0;
      for (let j = from; j < to; j++) sum += samples[j]!;
      out[i] = sum / (to - from);
    } else {
      const j = Math.floor(start);
      const t = start - j;
      out[i] = samples[j]! * (1 - t) + (samples[Math.min(j + 1, samples.length - 1)] ?? 0) * t;
    }
  }
  return out;
}

/** Mono 16-bit PCM WAV of Float32 samples in [-1, 1] (clipped). */
export function encodeWav(samples: Float32Array, sampleRate = VOICE_SAMPLE_RATE): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(HEADER_BYTES + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(HEADER_BYTES + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** offset and length of the PCM data in the buffer */
  dataOffset: number;
  dataBytes: number;
  durationMs: number;
}

/** Header of a PCM WAV (walks the chunks, so extra chunks like LIST are fine); null if it isn't one. */
export function parseWav(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 16 <= bytes.length) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!fmt || fmt.format !== 1 || fmt.channels < 1 || fmt.sampleRate <= 0 || fmt.bits !== 16) return null;
      const dataBytes = Math.min(size, bytes.length - body);
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bits,
        dataOffset: body,
        dataBytes,
        durationMs: Math.round((dataBytes / (2 * fmt.channels) / fmt.sampleRate) * 1000),
      };
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

/** Peak RMS over 50 ms windows of a 16-bit PCM WAV, 0…1 – near 0 means silence (whisper then invents text). */
export function peakLevel(bytes: Uint8Array, info: WavInfo): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = Math.floor(info.dataBytes / 2);
  const window = Math.max(1, Math.round((info.sampleRate * info.channels) / 20));
  let peak = 0;
  for (let start = 0; start < samples; start += window) {
    const end = Math.min(samples, start + window);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const s = view.getInt16(info.dataOffset + i * 2, true) / 0x8000;
      sum += s * s;
    }
    peak = Math.max(peak, Math.sqrt(sum / (end - start)));
  }
  return peak;
}
