import { accessSync, constants, type Dirent, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// llama.cpp provider: find the llama-server binary and local GGUF models. Nothing is downloaded here –
// models come from Unsloth Studio, LM Studio or a one-off `llama-server -hf <repo>:<quant>`, which stores the
// file in the Hugging Face cache (~/.cache/huggingface/hub) that we scan.

/** File system access, injectable for tests. */
export interface FsDeps {
  home: string;
  env: Record<string, string | undefined>;
  /** executable regular file */
  isExecutable(path: string): boolean;
  isFile(path: string): boolean;
  /** size in bytes (follows symlinks), null if missing */
  size(path: string): number | null;
  readdir(path: string): Dirent[];
  realpath(path: string): string;
  which(cmd: string): string | null;
}

export const nodeFs: FsDeps = {
  home: homedir(),
  env: process.env,
  isExecutable(path) {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  isFile(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  size(path) {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
  readdir(path) {
    try {
      return readdirSync(path, { withFileTypes: true });
    } catch {
      return [];
    }
  },
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
  which: (cmd) => Bun.which(cmd),
};

/** "~/x" → "/Users/me/x" */
export function expandHome(path: string, home = nodeFs.home): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

// --- binary ----------------------------------------------------------------------------------------------

export type BinarySource = "configured" | "unsloth" | "path" | "homebrew";

export const BINARY_SOURCE_LABELS: Record<BinarySource, string> = {
  configured: "eingestellt",
  unsloth: "Unsloth Studio",
  path: "PATH",
  homebrew: "Homebrew",
};

export type BinaryLookup = { path: string; source: BinarySource } | { path: null; error: string };

export const binaryInstallHint = () =>
  "llama-server nicht gefunden – Unsloth Studio installieren (bringt llama.cpp mit) oder `brew install llama.cpp`";

/** Configured path, else the first of: Unsloth's build, `llama-server` on PATH, /opt/homebrew/bin. */
export function findLlamaServer(configured: string, fs: FsDeps = nodeFs): BinaryLookup {
  if (configured) {
    const path = expandHome(configured, fs.home);
    if (fs.isExecutable(path)) return { path, source: "configured" };
    return { path: null, error: fs.isFile(path) ? `llama-server nicht ausführbar: ${path}` : `llama-server nicht gefunden: ${path}` };
  }
  const unsloth = join(fs.home, ".unsloth/llama.cpp/build/bin/llama-server");
  if (fs.isExecutable(unsloth)) return { path: unsloth, source: "unsloth" };
  const onPath = fs.which("llama-server");
  if (onPath && fs.isExecutable(onPath)) return { path: onPath, source: "path" };
  if (fs.isExecutable("/opt/homebrew/bin/llama-server")) return { path: "/opt/homebrew/bin/llama-server", source: "homebrew" };
  return { path: null, error: binaryInstallHint() };
}

// --- models ----------------------------------------------------------------------------------------------

export interface GgufModel {
  /** absolute path (as found, not resolved – HF snapshots are symlinks into blobs/) */
  path: string;
  /** "unsloth/gemma-4-E2B-it-GGUF" for HF cache files, else the file name without .gguf */
  name: string;
  /** quantization from the file name ("UD-Q4_K_XL", "BF16"), "" if unknown */
  quant: string;
  /** bytes, summed over all parts of a split model */
  sizeBytes: number;
  /** mmproj file next to the model (vision), or null */
  mmproj: string | null;
}

/** smaller files are test/vocab models (stories260K, ggml-vocab-*) */
const MIN_MODEL_BYTES = 50_000_000;
const SPLIT = /-(\d{5})-of-(\d{5})\.gguf$/i;
const QUANT = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|MXFP4(?:_MOE)?))$/i;

export const isMmproj = (file: string) => /mmproj/i.test(basename(file));

export function quantOf(file: string): string {
  const stem = basename(file).replace(SPLIT, ".gguf").replace(/\.gguf$/i, "");
  return QUANT.exec(stem)?.[1] ?? "";
}

/** "…/hub/models--unsloth--gemma-4-E2B-it-GGUF/snapshots/<rev>/…" → "unsloth/gemma-4-E2B-it-GGUF" */
export function hfRepoOf(path: string): string | null {
  const m = /\/models--([^/]+)\/snapshots\//.exec(path);
  return m ? m[1]!.split("--").join("/") : null;
}

/** Projector next to a model: mmproj*.gguf in the same directory, preferring F16, then BF16, F32, then by name. */
export function findMmproj(modelPath: string, fs: FsDeps = nodeFs): string | null {
  const dir = dirname(modelPath);
  const rank = (name: string) => (/[-_]F16\b/i.test(name) ? 0 : /BF16/i.test(name) ? 1 : /F32/i.test(name) ? 2 : 3);
  const candidates = fs
    .readdir(dir)
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && /\.gguf$/i.test(e.name) && isMmproj(e.name))
    .map((e) => e.name)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return candidates.length ? join(dir, candidates[0]!) : null;
}

/** Directories scanned for GGUFs, with the depth below each. */
export function modelRoots(fs: FsDeps = nodeFs): { dir: string; depth: number }[] {
  const { home, env } = fs;
  const hfHub = env.HF_HUB_CACHE || join(env.HF_HOME || join(home, ".cache/huggingface"), "hub");
  return [
    // models--<org>--<repo>/snapshots/<rev>/[subdir/]file.gguf
    { dir: hfHub, depth: 4 },
    { dir: env.LLAMA_CACHE || join(home, ".cache/llama.cpp"), depth: 2 },
    { dir: join(home, "Library/Caches/llama.cpp"), depth: 2 },
    { dir: join(home, ".unsloth"), depth: 4 },
    { dir: join(home, ".lmstudio/models"), depth: 3 },
  ];
}

/** source checkouts / tooling dirs that never hold user models but are large to walk */
const SKIP_DIRS = new Set(["llama.cpp", "node_modules", ".git", "blobs", ".venv", "venv", "site-packages", "__pycache__"]);

/** GGUF models on disk (no mmproj, no tiny test files, split models once), sorted by name and quant. */
export function discoverModels(fs: FsDeps = nodeFs, roots = modelRoots(fs)): GgufModel[] {
  const seen = new Set<string>();
  const out: GgufModel[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of fs.readdir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0 && !SKIP_DIRS.has(entry.name)) walk(path, depth - 1);
        continue;
      }
      if (!(entry.isFile() || entry.isSymbolicLink()) || !/\.gguf$/i.test(entry.name) || isMmproj(entry.name)) continue;
      const split = SPLIT.exec(entry.name);
      if (split && split[1] !== "00001") continue;
      let sizeBytes = fs.size(path) ?? 0;
      if (split) {
        const total = Number(split[2]);
        for (let i = 2; i <= total; i++) {
          const part = path.replace(SPLIT, `-${String(i).padStart(5, "0")}-of-${split[2]}.gguf`);
          sizeBytes += fs.size(part) ?? 0;
        }
      }
      if (sizeBytes < MIN_MODEL_BYTES) continue;
      const real = fs.realpath(path);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push({
        path,
        name: hfRepoOf(path) ?? entry.name.replace(SPLIT, ".gguf").replace(/\.gguf$/i, ""),
        quant: quantOf(entry.name),
        sizeBytes,
        mmproj: findMmproj(path, fs),
      });
    }
  };
  for (const root of roots) walk(root.dir, root.depth);
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.quant.localeCompare(b.quant) || a.path.localeCompare(b.path));
}

/** model id for the API (`--alias`): the file name without .gguf / split suffix */
export function modelAlias(modelPath: string): string {
  return basename(modelPath).replace(SPLIT, ".gguf").replace(/\.gguf$/i, "");
}
