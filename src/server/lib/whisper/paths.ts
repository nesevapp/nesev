import { basename, join } from "node:path";
import type { WhisperModelInfo } from "../../../shared/voice";
import { expandHome, type FsDeps, nodeFs } from "../llama/paths";

// Find whisper.cpp's CLI and local ggml models for voice input. Nothing is downloaded here: the settings show a
// one-line curl into ~/Library/Caches/whisper.cpp; models of other local tools (VoiceInk, a whisper.cpp checkout,
// the Hugging Face cache) are picked up as well.

export const whisperInstallHint = () => "whisper.cpp nicht gefunden – `brew install whisper-cpp`";

export const WHISPER_DEFAULT_MODEL = "ggml-large-v3-turbo-q5_0.bin";
export const whisperModelHint = () =>
  `Kein Whisper-Modell gefunden – laden mit \`curl -L --create-dirs -o ~/Library/Caches/whisper.cpp/${WHISPER_DEFAULT_MODEL} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_DEFAULT_MODEL}\` (ca. 550 MB)`;

/** `whisper-cli` on PATH, else Homebrew's. */
export function findWhisperCli(fs: FsDeps = nodeFs): string | null {
  const onPath = fs.which("whisper-cli");
  if (onPath && fs.isExecutable(onPath)) return onPath;
  if (fs.isExecutable("/opt/homebrew/bin/whisper-cli")) return "/opt/homebrew/bin/whisper-cli";
  return null;
}

/** Directories scanned for ggml-*.bin, with the depth below each. */
export function whisperModelRoots(fs: FsDeps = nodeFs): { dir: string; depth: number }[] {
  const { home, env } = fs;
  const hfHub = env.HF_HUB_CACHE || join(env.HF_HOME || join(home, ".cache/huggingface"), "hub");
  return [
    { dir: join(home, "Library/Caches/whisper.cpp"), depth: 1 },
    { dir: join(home, ".cache/whisper.cpp"), depth: 1 },
    // models--ggerganov--whisper.cpp/snapshots/<rev>/ggml-*.bin
    { dir: join(hfHub, "models--ggerganov--whisper.cpp"), depth: 2 },
    { dir: join(hfHub, "models--ggml-org--whisper.cpp"), depth: 2 },
    { dir: join(home, "whisper.cpp/models"), depth: 0 },
    { dir: join(home, "Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels"), depth: 0 },
  ];
}

/** smaller files are whisper.cpp's test models (for-tests-ggml-tiny.bin is ~0.6 MB) */
const MIN_MODEL_BYTES = 20_000_000;
/** VAD (silero) and Core ML encoder files share the ggml- prefix but aren't speech models */
const NOT_A_MODEL = /silero|vad|encoder|for-tests/i;

/** "ggml-large-v3-turbo-q5_0.bin" → "large-v3-turbo-q5_0" */
export const whisperModelName = (path: string) => basename(path).replace(/^ggml-/, "").replace(/\.bin$/i, "");

export function discoverWhisperModels(fs: FsDeps = nodeFs, roots = whisperModelRoots(fs)): WhisperModelInfo[] {
  const seen = new Set<string>();
  const out: WhisperModelInfo[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of fs.readdir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0 && entry.name !== "blobs") walk(path, depth - 1);
        continue;
      }
      if (!(entry.isFile() || entry.isSymbolicLink()) || !/^ggml-.+\.bin$/i.test(entry.name) || NOT_A_MODEL.test(entry.name)) continue;
      const sizeBytes = fs.size(path) ?? 0;
      if (sizeBytes < MIN_MODEL_BYTES) continue;
      const real = fs.realpath(path);
      if (seen.has(real)) continue;
      seen.add(real);
      const name = whisperModelName(path);
      out.push({ path, name, sizeBytes, englishOnly: /\.en(?:[-_.]|$)/i.test(name) });
    }
  };
  for (const root of roots) walk(root.dir, root.depth);
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/** Lower is better: turbo is about as fast as base on Apple Silicon (Metal) and far better in German. */
function rank(m: WhisperModelInfo, language: string): number {
  const size = /large-v3-turbo/i.test(m.name)
    ? 0
    : /large/i.test(m.name)
      ? 1
      : /medium/i.test(m.name)
        ? 2
        : /small/i.test(m.name)
          ? 3
          : /base/i.test(m.name)
            ? 4
            : 5;
  return size + (m.englishOnly && language !== "en" ? 10 : 0);
}

/** Model for an empty path: best ranked, then the smaller file (quantized). */
export function pickWhisperModel(models: WhisperModelInfo[], language: string): WhisperModelInfo | null {
  return [...models].sort((a, b) => rank(a, language) - rank(b, language) || a.sizeBytes - b.sizeBytes)[0] ?? null;
}

export type WhisperModelLookup =
  | { path: string; label: string; auto: boolean; error?: undefined }
  | { path: null; error: string };

export function resolveWhisperModel(
  configured: string,
  language: string,
  fs: FsDeps = nodeFs,
  discover: () => WhisperModelInfo[] = () => discoverWhisperModels(fs),
): WhisperModelLookup {
  if (configured) {
    const path = expandHome(configured, fs.home);
    if (!fs.isFile(path)) return { path: null, error: `Whisper-Modell nicht gefunden: ${path}` };
    return { path, label: whisperModelName(path), auto: false };
  }
  const picked = pickWhisperModel(discover(), language);
  return picked ? { path: picked.path, label: picked.name, auto: true } : { path: null, error: whisperModelHint() };
}
