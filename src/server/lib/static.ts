import { stat } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

/** Serve a regular file from `dir` by a request-relative path; null if missing or outside `dir`. */
export async function serveFile(dir: string, relPath: string): Promise<Response | null> {
  const full = normalize(join(dir, decodeURIComponent(relPath)));
  if (!full.startsWith(dir + sep)) return null;
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) return null;
  return new Response(Bun.file(full));
}
