import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Dirent } from "node:fs";
import { DEFAULT_CHAT_SETTINGS } from "../../shared/chat";
import { DEFAULT_VOICE_SETTINGS } from "../../shared/voice";
import { encodeWav } from "../../shared/wav";
import { createTestDb } from "../db/client";
import type { FsDeps } from "../lib/llama/paths";
import { AbortedError, CommandError } from "../lib/ocr/run";
import { getChatSettings, updateChatSettings } from "./chat-settings";
import { getSettings } from "./settings";
import { getVoiceSettings, transcribe, type TranscribeDeps, updateVoiceSettings, VoiceError, voiceStatus } from "./voice";

const HOME = "/Users/me";
const BIN = "/opt/homebrew/bin/whisper-cli";
const MODEL = `${HOME}/Library/Caches/whisper.cpp/ggml-large-v3-turbo-q5_0.bin`;

function fakeFs(files: Record<string, { size: number; exec?: boolean }>): FsDeps {
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) for (let d = dirname(p); d !== "/"; d = dirname(d)) dirs.add(d);
  return {
    home: HOME,
    env: {},
    isExecutable: (p) => !!files[p]?.exec,
    isFile: (p) => p in files,
    size: (p) => files[p]?.size ?? null,
    readdir(dir) {
      const names = new Set([...Object.keys(files), ...dirs].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split("/")[0]!));
      return [...names].map((name) => ({ name, isFile: () => !dirs.has(`${dir}/${name}`), isDirectory: () => dirs.has(`${dir}/${name}`), isSymbolicLink: () => false }) as unknown as Dirent);
    },
    realpath: (p) => p,
    which: () => null,
  };
}

const fullFs = fakeFs({ [BIN]: { size: 1, exec: true }, [MODEL]: { size: 574_000_000 } });

const speech = () =>
  encodeWav(Float32Array.from({ length: 16000 * 2 }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / 16000)));

function deps(run: TranscribeDeps["run"], fs = fullFs): TranscribeDeps {
  let t = 0;
  return { run, fs, now: () => (t += 400) };
}

async function voiceError(p: Promise<unknown>): Promise<VoiceError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof VoiceError) return err;
    throw err;
  }
  throw new Error("expected a VoiceError");
}

describe("voice settings", () => {
  test("defaults, round trip, invalid fields fall back per field", () => {
    const db = createTestDb();
    expect(getVoiceSettings(db)).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(updateVoiceSettings(db, { enabled: false, modelPath: "~/m.bin", language: "en" })).toEqual({ enabled: false, modelPath: "~/m.bin", language: "en" });
    updateChatSettings(db, { ...DEFAULT_CHAT_SETTINGS, reasoning: true });
    updateVoiceSettings(db, { ...DEFAULT_VOICE_SETTINGS, language: "auto" });
    // the assistant's own save keeps `voice` and vice versa
    expect(getChatSettings(db).reasoning).toBe(true);
    expect(getVoiceSettings(db).language).toBe("auto");
    updateChatSettings(db, { ...DEFAULT_CHAT_SETTINGS, reasoning: false });
    expect(getVoiceSettings(db).language).toBe("auto");
    expect(getSettings(db).chatSettings).toMatchObject({ reasoning: false, voice: { language: "auto" } });
  });
});

describe("voiceStatus", () => {
  test("ready with auto model; hints for missing binary / model", () => {
    const db = createTestDb();
    expect(voiceStatus(db, fullFs)).toEqual({
      enabled: true,
      ready: true,
      problem: null,
      binary: BIN,
      model: { path: MODEL, label: "large-v3-turbo-q5_0", auto: true },
      language: "de",
    });
    expect(voiceStatus(db, fakeFs({ [MODEL]: { size: 574_000_000 } })).problem).toContain("brew install whisper-cpp");
    const noModel = voiceStatus(db, fakeFs({ [BIN]: { size: 1, exec: true } }));
    expect(noModel).toMatchObject({ ready: false, model: null });
    expect(noModel.problem).toContain("curl -L");
    updateVoiceSettings(db, { ...DEFAULT_VOICE_SETTINGS, enabled: false });
    expect(voiceStatus(db, fakeFs({}))).toMatchObject({ enabled: false, ready: false, problem: null });
  });
});

describe("transcribe", () => {
  test("runs whisper-cli on a temp WAV, returns the cleaned text and removes the file", async () => {
    const db = createTestDb();
    let seen: { cmd: string[]; path: string; bytes: number } | null = null;
    const wav = speech();
    const result = await transcribe(db, wav, {
      deps: deps(async (cmd) => {
        const path = cmd[cmd.indexOf("-f") + 1]!;
        seen = { cmd, path, bytes: readFileSync(path).length };
        return " Wie viel ist derzeit offen?\n [BLANK_AUDIO]\n Zeig mir die Rechnungen.\n";
      }),
    });
    expect(result).toEqual({ text: "Wie viel ist derzeit offen? Zeig mir die Rechnungen.", audioMs: 2000, elapsedMs: 400 });
    expect(seen!.cmd.slice(0, 5)).toEqual([BIN, "-m", MODEL, "-l", "de"]);
    expect(seen!.bytes).toBe(wav.length);
    expect(existsSync(seen!.path)).toBe(false);
    expect(existsSync(dirname(seen!.path))).toBe(false);
  });

  test("silence and very short clips skip whisper", async () => {
    const db = createTestDb();
    const run = async () => {
      throw new Error("must not run");
    };
    expect(await transcribe(db, encodeWav(new Float32Array(16000 * 3)), { deps: deps(run) })).toEqual({ text: "", audioMs: 3000, elapsedMs: 0 });
    expect((await transcribe(db, encodeWav(new Float32Array(800).fill(0.5)), { deps: deps(run) })).text).toBe("");
  });

  test("errors: disabled, invalid, too long, missing whisper/model, failures; temp dir removed on failure", async () => {
    const db = createTestDb();
    const ok = async () => "x";
    expect((await voiceError(transcribe(db, new Uint8Array(100), { deps: deps(ok) }))).status).toBe(400);
    expect((await voiceError(transcribe(db, encodeWav(new Float32Array(16000 * 125)), { deps: deps(ok) }))).status).toBe(413);
    const noBin = await voiceError(transcribe(db, speech(), { deps: deps(ok, fakeFs({ [MODEL]: { size: 574_000_000 } })) }));
    expect(noBin.status).toBe(503);
    expect(noBin.message).toContain("brew install whisper-cpp");
    expect((await voiceError(transcribe(db, speech(), { deps: deps(ok, fakeFs({ [BIN]: { size: 1, exec: true } })) }))).status).toBe(503);

    let path = "";
    const failing = await voiceError(
      transcribe(db, speech(), {
        deps: deps(async (cmd) => {
          path = cmd[cmd.indexOf("-f") + 1]!;
          throw new CommandError("failed to load model");
        }),
      }),
    );
    expect(failing).toMatchObject({ status: 500, message: "Transkription fehlgeschlagen: failed to load model" });
    expect(existsSync(dirname(path))).toBe(false);
    const aborted = await voiceError(transcribe(db, speech(), { deps: deps(async () => Promise.reject(new AbortedError())) }));
    expect(aborted.status).toBe(499);

    updateVoiceSettings(db, { ...DEFAULT_VOICE_SETTINGS, enabled: false });
    expect((await voiceError(transcribe(db, speech(), { deps: deps(ok) }))).status).toBe(409);
  });

  test("runs one at a time", async () => {
    const db = createTestDb();
    let active = 0;
    let maxActive = 0;
    const run = async () => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return "ok";
    };
    const results = await Promise.all([1, 2, 3].map(() => transcribe(db, speech(), { deps: deps(run) })));
    expect(results.map((r) => r.text)).toEqual(["ok", "ok", "ok"]);
    expect(maxActive).toBe(1);
  });
});
