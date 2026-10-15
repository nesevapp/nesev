import { describe, expect, test } from "bun:test";
import type { Dirent } from "node:fs";
import { dirname } from "node:path";
import type { FsDeps } from "../llama/paths";
import { discoverWhisperModels, findWhisperCli, pickWhisperModel, resolveWhisperModel, whisperModelName } from "./paths";

const HOME = "/Users/me";
const MB = 1_000_000;

/** in-memory file system: path → size (exec: executable) */
function fakeFs(files: Record<string, number | { size: number; exec?: boolean }>, which: Record<string, string> = {}): FsDeps {
  const entries = new Map(Object.entries(files).map(([p, v]) => [p, typeof v === "number" ? { size: v, exec: false } : { exec: false, ...v }]));
  const dirs = new Set<string>();
  for (const p of entries.keys()) for (let d = dirname(p); d !== "/"; d = dirname(d)) dirs.add(d);
  const dirent = (name: string, dir: boolean) =>
    ({ name, isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false }) as unknown as Dirent;
  return {
    home: HOME,
    env: {},
    isExecutable: (p) => !!entries.get(p)?.exec,
    isFile: (p) => entries.has(p),
    size: (p) => entries.get(p)?.size ?? null,
    readdir(dir) {
      const out = new Map<string, boolean>();
      const prefix = `${dir}/`;
      for (const p of [...entries.keys(), ...dirs]) {
        if (!p.startsWith(prefix)) continue;
        const name = p.slice(prefix.length).split("/")[0]!;
        out.set(name, dirs.has(prefix + name));
      }
      return [...out].map(([name, dir]) => dirent(name, dir));
    },
    realpath: (p) => p,
    which: (cmd) => which[cmd] ?? null,
  };
}

const cache = `${HOME}/Library/Caches/whisper.cpp`;
const voiceInk = `${HOME}/Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels`;
const hf = `${HOME}/.cache/huggingface/hub/models--ggerganov--whisper.cpp/snapshots/abc`;

describe("findWhisperCli", () => {
  test("PATH first, then Homebrew, else null", () => {
    const both = fakeFs({ "/usr/local/bin/whisper-cli": { size: 1, exec: true }, "/opt/homebrew/bin/whisper-cli": { size: 1, exec: true } }, { "whisper-cli": "/usr/local/bin/whisper-cli" });
    expect(findWhisperCli(both)).toBe("/usr/local/bin/whisper-cli");
    expect(findWhisperCli(fakeFs({ "/opt/homebrew/bin/whisper-cli": { size: 1, exec: true } }))).toBe("/opt/homebrew/bin/whisper-cli");
    expect(findWhisperCli(fakeFs({ "/opt/homebrew/bin/whisper-cli": 1 }))).toBeNull();
  });
});

describe("discoverWhisperModels", () => {
  test("finds ggml models in the known dirs, skips test, VAD and encoder files", () => {
    const fs = fakeFs({
      [`${cache}/ggml-base.bin`]: 148 * MB,
      [`${cache}/ggml-silero-v5.1.2.bin`]: 30 * MB,
      [`${cache}/ggml-base-encoder.mlmodelc.bin`]: 40 * MB,
      [`${cache}/notes.txt`]: 1,
      [`${voiceInk}/ggml-large-v3-turbo-q5_0.bin`]: 574 * MB,
      [`${hf}/ggml-small.en.bin`]: 488 * MB,
      [`${HOME}/whisper.cpp/models/for-tests-ggml-tiny.bin`]: 600_000,
      [`${HOME}/whisper.cpp/models/ggml-tiny.bin`]: 1 * MB, // too small
      [`${HOME}/.cache/huggingface/hub/models--other--x/snapshots/r/ggml-model.bin`]: 100 * MB, // not scanned
    });
    expect(discoverWhisperModels(fs)).toEqual([
      { path: `${cache}/ggml-base.bin`, name: "base", sizeBytes: 148 * MB, englishOnly: false },
      { path: `${voiceInk}/ggml-large-v3-turbo-q5_0.bin`, name: "large-v3-turbo-q5_0", sizeBytes: 574 * MB, englishOnly: false },
      { path: `${hf}/ggml-small.en.bin`, name: "small.en", sizeBytes: 488 * MB, englishOnly: true },
    ]);
  });

  test("model names", () => {
    expect(whisperModelName("/x/ggml-large-v3-turbo-q5_0.bin")).toBe("large-v3-turbo-q5_0");
  });
});

describe("pickWhisperModel", () => {
  const m = (name: string, sizeBytes = 100 * MB) => ({ path: `/m/ggml-${name}.bin`, name, sizeBytes, englishOnly: /\.en/.test(name) });

  test("prefers turbo, then larger multilingual models, quantized first", () => {
    expect(pickWhisperModel([m("base"), m("small"), m("large-v3-turbo", 1600 * MB), m("large-v3-turbo-q5_0", 574 * MB)], "de")?.name).toBe("large-v3-turbo-q5_0");
    expect(pickWhisperModel([m("base"), m("medium"), m("small")], "de")?.name).toBe("medium");
    expect(pickWhisperModel([], "de")).toBeNull();
  });

  test("English-only models only for English", () => {
    expect(pickWhisperModel([m("small.en"), m("base")], "de")?.name).toBe("base");
    expect(pickWhisperModel([m("small.en"), m("base")], "en")?.name).toBe("small.en");
  });
});

describe("resolveWhisperModel", () => {
  test("configured path (with ~), auto pick, missing", () => {
    const fs = fakeFs({ [`${cache}/ggml-base.bin`]: 148 * MB });
    expect(resolveWhisperModel("~/Library/Caches/whisper.cpp/ggml-base.bin", "de", fs)).toEqual({ path: `${cache}/ggml-base.bin`, label: "base", auto: false });
    expect(resolveWhisperModel("/nope/ggml-x.bin", "de", fs)).toEqual({ path: null, error: "Whisper-Modell nicht gefunden: /nope/ggml-x.bin" });
    expect(resolveWhisperModel("", "de", fs)).toEqual({ path: `${cache}/ggml-base.bin`, label: "base", auto: true });
    const none = resolveWhisperModel("", "de", fakeFs({}));
    expect(none.path).toBeNull();
    expect(none.error).toContain("ggml-large-v3-turbo-q5_0.bin");
  });
});
