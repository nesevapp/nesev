import { describe, expect, test } from "bun:test";
import type { Dirent } from "node:fs";
import { dirname } from "node:path";
import { discoverModels, expandHome, findLlamaServer, findMmproj, type FsDeps, hfRepoOf, modelAlias, quantOf } from "./paths";

const HOME = "/Users/me";
const GB = 1_000_000_000;

/** in-memory file system: path → size (exec: executable) */
function fakeFs(files: Record<string, number | { size: number; exec?: boolean }>, opts: { which?: Record<string, string>; env?: Record<string, string> } = {}): FsDeps {
  const entries = new Map(Object.entries(files).map(([p, v]) => [p, typeof v === "number" ? { size: v, exec: false } : { exec: false, ...v }]));
  const dirs = new Set<string>();
  for (const p of entries.keys()) for (let d = dirname(p); d !== "/"; d = dirname(d)) dirs.add(d);
  const dirent = (name: string, dir: boolean) =>
    ({ name, isFile: () => !dir, isDirectory: () => dir, isSymbolicLink: () => false }) as unknown as Dirent;
  return {
    home: HOME,
    env: opts.env ?? {},
    isExecutable: (p) => !!entries.get(p)?.exec,
    isFile: (p) => entries.has(p),
    size: (p) => entries.get(p)?.size ?? null,
    readdir(dir) {
      const out = new Map<string, boolean>();
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      for (const p of [...entries.keys(), ...dirs]) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const name = rest.split("/")[0]!;
        out.set(name, rest.includes("/") || dirs.has(prefix + name));
      }
      return [...out].map(([name, dir]) => dirent(name, dir));
    },
    realpath: (p) => p,
    which: (cmd) => opts.which?.[cmd] ?? null,
  };
}

describe("findLlamaServer", () => {
  const unsloth = `${HOME}/.unsloth/llama.cpp/build/bin/llama-server`;

  test("prefers Unsloth's build, then PATH, then Homebrew", () => {
    const all = fakeFs(
      { [unsloth]: { size: 1, exec: true }, "/usr/local/bin/llama-server": { size: 1, exec: true }, "/opt/homebrew/bin/llama-server": { size: 1, exec: true } },
      { which: { "llama-server": "/usr/local/bin/llama-server" } },
    );
    expect(findLlamaServer("", all)).toEqual({ path: unsloth, source: "unsloth" });
    const noUnsloth = fakeFs(
      { "/usr/local/bin/llama-server": { size: 1, exec: true }, "/opt/homebrew/bin/llama-server": { size: 1, exec: true } },
      { which: { "llama-server": "/usr/local/bin/llama-server" } },
    );
    expect(findLlamaServer("", noUnsloth)).toEqual({ path: "/usr/local/bin/llama-server", source: "path" });
    expect(findLlamaServer("", fakeFs({ "/opt/homebrew/bin/llama-server": { size: 1, exec: true } }))).toEqual({
      path: "/opt/homebrew/bin/llama-server",
      source: "homebrew",
    });
  });

  test("nothing found → German install hint", () => {
    const r = findLlamaServer("", fakeFs({}));
    expect(r.path).toBeNull();
    expect("error" in r && r.error).toContain("brew install llama.cpp");
  });

  test("a configured path wins and is not silently replaced", () => {
    const fs = fakeFs({ [unsloth]: { size: 1, exec: true }, [`${HOME}/bin/llama-server`]: { size: 1, exec: true }, "/tmp/x": 1 });
    expect(findLlamaServer("~/bin/llama-server", fs)).toEqual({ path: `${HOME}/bin/llama-server`, source: "configured" });
    expect(findLlamaServer("/nope/llama-server", fs)).toEqual({ path: null, error: "llama-server nicht gefunden: /nope/llama-server" });
    expect(findLlamaServer("/tmp/x", fs)).toEqual({ path: null, error: "llama-server nicht ausführbar: /tmp/x" });
  });
});

describe("GGUF discovery", () => {
  const hub = `${HOME}/.cache/huggingface/hub`;
  const gemma = `${hub}/models--unsloth--gemma-4-E2B-it-GGUF/snapshots/0314/gemma-4-E2B-it-UD-Q4_K_XL.gguf`;
  const qwenDir = `${hub}/models--unsloth--Qwen3.5-4B-GGUF/snapshots/abcd`;

  test("labels, quant, size; skips mmproj, tiny test files, later split parts and tool dirs", () => {
    const fs = fakeFs({
      [gemma]: 3.18 * GB,
      [`${qwenDir}/Qwen3.5-4B-Q4_K_M.gguf`]: 2.7 * GB,
      [`${qwenDir}/mmproj-BF16.gguf`]: 0.6 * GB,
      [`${qwenDir}/mmproj-F16.gguf`]: 0.6 * GB,
      [`${hub}/models--x--Big-GGUF/snapshots/r/Q8_0/Big-Q8_0-00001-of-00002.gguf`]: 40 * GB,
      [`${hub}/models--x--Big-GGUF/snapshots/r/Q8_0/Big-Q8_0-00002-of-00002.gguf`]: 10 * GB,
      [`${HOME}/.unsloth/.cache/stories260K.gguf`]: 1_200_000,
      [`${HOME}/.unsloth/llama.cpp/models/ggml-vocab-qwen35.gguf`]: 60_000_000,
      [`${HOME}/.unsloth/studio/models/My-Model-IQ4_XS.gguf`]: 1.5 * GB,
      [`${HOME}/.cache/llama.cpp/LFM2.5-2.6B-BF16.gguf`]: 5.4 * GB,
    });
    const models = discoverModels(fs);
    expect(models.map((m) => [m.name, m.quant, Math.round(m.sizeBytes / GB)])).toEqual([
      ["LFM2.5-2.6B-BF16", "BF16", 5],
      ["My-Model-IQ4_XS", "IQ4_XS", 2],
      ["unsloth/gemma-4-E2B-it-GGUF", "UD-Q4_K_XL", 3],
      ["unsloth/Qwen3.5-4B-GGUF", "Q4_K_M", 3],
      ["x/Big-GGUF", "Q8_0", 50],
    ]);
    const qwen = models.find((m) => m.name === "unsloth/Qwen3.5-4B-GGUF")!;
    expect(qwen.mmproj).toBe(`${qwenDir}/mmproj-F16.gguf`);
    expect(models.find((m) => m.quant === "UD-Q4_K_XL")!.mmproj).toBeNull();
  });

  test("honours HF_HUB_CACHE", () => {
    const fs = fakeFs({ "/data/hf/models--a--B-GGUF/snapshots/r/B-Q4_K_M.gguf": GB }, { env: { HF_HUB_CACHE: "/data/hf" } });
    expect(discoverModels(fs).map((m) => m.name)).toEqual(["a/B-GGUF"]);
  });

  test("mmproj preference: F16, BF16, F32, then by name", () => {
    const dir = "/m";
    expect(findMmproj(`${dir}/x.gguf`, fakeFs({ [`${dir}/x.gguf`]: GB, [`${dir}/mmproj-F32.gguf`]: 1, [`${dir}/mmproj-BF16.gguf`]: 1 }))).toBe(
      `${dir}/mmproj-BF16.gguf`,
    );
    expect(findMmproj(`${dir}/x.gguf`, fakeFs({ [`${dir}/x.gguf`]: GB, [`${dir}/mmproj-model-q8.gguf`]: 1 }))).toBe(`${dir}/mmproj-model-q8.gguf`);
    expect(findMmproj(`${dir}/x.gguf`, fakeFs({ [`${dir}/x.gguf`]: GB }))).toBeNull();
  });

  test("helpers", () => {
    expect(quantOf("Qwen3.8-27B-UD-Q5_K_XL.gguf")).toBe("UD-Q5_K_XL");
    expect(quantOf("model-q8_0.gguf")).toBe("q8_0");
    expect(quantOf("Big-Q8_0-00001-of-00002.gguf")).toBe("Q8_0");
    expect(quantOf("plain.gguf")).toBe("");
    expect(hfRepoOf(gemma)).toBe("unsloth/gemma-4-E2B-it-GGUF");
    expect(hfRepoOf("/x/y.gguf")).toBeNull();
    expect(modelAlias(gemma)).toBe("gemma-4-E2B-it-UD-Q4_K_XL");
    expect(modelAlias("/a/Big-Q8_0-00001-of-00002.gguf")).toBe("Big-Q8_0");
    expect(expandHome("~/x", HOME)).toBe(`${HOME}/x`);
    expect(expandHome("/abs", HOME)).toBe("/abs");
  });
});
