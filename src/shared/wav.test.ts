import { describe, expect, test } from "bun:test";
import { encodeWav, parseWav, peakLevel, resample, VOICE_SAMPLE_RATE } from "./wav";

const sine = (rate: number, seconds: number, freq = 440, amp = 0.5) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));

describe("encodeWav", () => {
  test("writes a 16 kHz mono 16-bit PCM header and clipped samples", () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    expect(wav.length).toBe(44 + 6 * 2);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(wav.length - 8);
    expect(String.fromCharCode(...wav.subarray(8, 16))).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(12);
    const samples = Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true));
    expect(samples).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });

  test("round-trips through parseWav", () => {
    const info = parseWav(encodeWav(new Float32Array(16000 * 3)));
    expect(info).toEqual({ sampleRate: 16000, channels: 1, bitsPerSample: 16, dataOffset: 44, dataBytes: 96000, durationMs: 3000 });
  });
});

describe("parseWav", () => {
  test("skips extra chunks before data (afconvert writes a FLLR/LIST chunk)", () => {
    const plain = encodeWav(new Float32Array(1600));
    const extra = new Uint8Array([..."LIST"].map((c) => c.charCodeAt(0)).concat([3, 0, 0, 0, 1, 2, 3, 0]));
    const wav = new Uint8Array([...plain.subarray(0, 36), ...extra, ...plain.subarray(36)]);
    expect(parseWav(wav)).toMatchObject({ dataOffset: 44 + extra.length, dataBytes: 3200, durationMs: 100 });
  });

  test("rejects non-WAV, float and 8-bit data", () => {
    expect(parseWav(new Uint8Array(100))).toBeNull();
    expect(parseWav(new TextEncoder().encode("RIFF....WAVE" + " ".repeat(40)))).toBeNull();
    const float = encodeWav(new Float32Array(10));
    new DataView(float.buffer).setUint16(20, 3, true);
    expect(parseWav(float)).toBeNull();
    const eight = encodeWav(new Float32Array(10));
    new DataView(eight.buffer).setUint16(34, 8, true);
    expect(parseWav(eight)).toBeNull();
  });
});

describe("resample", () => {
  test("48 kHz → 16 kHz keeps duration and a low tone", () => {
    const out = resample(sine(48000, 1), 48000);
    expect(out.length).toBe(VOICE_SAMPLE_RATE);
    // compare with a sine generated at 16 kHz directly (box filter barely damps 440 Hz)
    const ref = sine(16000, 1);
    const maxErr = Math.max(...Array.from(out, (v, i) => Math.abs(v - ref[i]!)).slice(10));
    expect(maxErr).toBeLessThan(0.05);
  });

  test("44.1 kHz and upsampling from 8 kHz", () => {
    expect(resample(sine(44100, 2), 44100).length).toBe(32000);
    expect(resample(sine(8000, 1), 8000).length).toBe(16000);
    expect(resample(new Float32Array(5), 16000).length).toBe(5);
  });
});

describe("peakLevel", () => {
  test("silence vs. speech-like signal", () => {
    const silent = encodeWav(new Float32Array(16000));
    expect(peakLevel(silent, parseWav(silent)!)).toBe(0);
    const loud = encodeWav(new Float32Array([...new Float32Array(16000), ...sine(16000, 0.2, 300, 0.3)]));
    expect(peakLevel(loud, parseWav(loud)!)).toBeGreaterThan(0.2);
  });
});
