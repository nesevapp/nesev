import { compareVersions, isCompiled, VERSION } from "../../cli/version";
import { readConfig, writeConfig } from "../lib/data-location";

// "Is there a newer nesev?" – the only request nesev makes on its own. On by default, switchable in the setup and in
// Einstellungen → Export & Backup ("updateCheck" in the per-user config file), off with NESEV_UPDATE_CHECK=0. It reads
// the latest published GitHub release (tag, link, notes) at most once a day, only when the web app asks, and sends
// nothing but the request itself. Errors (offline, rate limit) just mean "no information".

export const LATEST_RELEASE_API = "https://api.github.com/repos/nesevapp/nesev/releases/latest";
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

export interface UpdateStatus {
  current: string;
  enabled: boolean;
  /** NESEV_UPDATE_CHECK=0: the setting can't be changed in the app */
  lockedByEnv: boolean;
  /** how to update: the release binary (`nesev update`) or a source checkout (git pull) */
  install: "binary" | "source";
  latest: string | null;
  newer: boolean;
  /** the release notes mention a security fix */
  security: boolean;
  url: string | null;
  checkedAt: string | null;
  error: string | null;
}

export interface LatestRelease {
  version: string;
  url: string;
  security: boolean;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function parseRelease(json: unknown): LatestRelease | null {
  if (!json || typeof json !== "object") return null;
  const r = json as { tag_name?: unknown; html_url?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown };
  if (typeof r.tag_name !== "string" || r.draft === true || r.prerelease === true) return null;
  const version = r.tag_name.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const body = typeof r.body === "string" ? r.body : "";
  return {
    version,
    url: typeof r.html_url === "string" ? r.html_url : `https://github.com/nesevapp/nesev/releases/tag/v${version}`,
    security: /\bsecurity\b|\bGHSA-|sicherheit/i.test(body),
  };
}

export async function fetchLatestRelease(fetcher: Fetcher = fetch): Promise<LatestRelease> {
  const res = await fetcher(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "nesev" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub antwortet mit ${res.status}`);
  const release = parseRelease(await res.json());
  if (!release) throw new Error("Unerwartete Antwort von GitHub");
  return release;
}

const lockedByEnv = (env = process.env) => env.NESEV_UPDATE_CHECK === "0";
export const updateCheckEnabled = (env = process.env) => !lockedByEnv(env) && readConfig().updateCheck !== false;

export function setUpdateCheck(enabled: boolean) {
  writeConfig({ updateCheck: enabled });
  cache = null;
}

let cache: { at: number; release: LatestRelease | null; error: string | null } | null = null;

/** For tests. */
export function resetUpdateCache() {
  cache = null;
}

export async function getUpdateStatus(
  { force = false, now = Date.now(), fetcher = fetch as Fetcher }: { force?: boolean; now?: number; fetcher?: Fetcher } = {},
): Promise<UpdateStatus> {
  const enabled = updateCheckEnabled();
  if (enabled) {
    const fresh = cache && now - cache.at < (cache.error ? RETRY_MS : DAY_MS);
    if (force || !fresh) {
      try {
        cache = { at: now, release: await fetchLatestRelease(fetcher), error: null };
      } catch (err) {
        cache = { at: now, release: cache?.release ?? null, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  const release = enabled ? (cache?.release ?? null) : null;
  return {
    current: VERSION,
    enabled,
    lockedByEnv: lockedByEnv(),
    install: isCompiled() ? "binary" : "source",
    latest: release?.version ?? null,
    newer: release ? compareVersions(release.version, VERSION) > 0 : false,
    security: release ? release.security && compareVersions(release.version, VERSION) > 0 : false,
    url: release?.url ?? null,
    checkedAt: enabled && cache ? new Date(cache.at).toISOString() : null,
    error: enabled ? (cache?.error ?? null) : null,
  };
}
