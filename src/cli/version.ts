import pkg from "../../package.json" with { type: "json" };

/** nesev's version (package.json; release tags are v<version>). */
export const VERSION: string = pkg.version;

/** True inside the single-file release binary (bun build --compile), false when run from source. */
export function isCompiled(): boolean {
  return import.meta.dir.startsWith("/$bunfs/") || /^[A-Z]:[\\/]~BUN[\\/]/i.test(import.meta.dir);
}

/** -1 / 0 / 1 for dotted numeric versions ("0.10.0" > "0.9.1"); a leading "v" and pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.trim().replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((n) => Number(n) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
