import type { MiddlewareHandler } from "hono";

// nesev has no auth and relies on listening on loopback only. That alone doesn't stop a browser page: a malicious site
// can rebind its domain to 127.0.0.1 (DNS rebinding) and then read the API "same-origin", or fire cross-site POSTs at
// localhost (CSRF). This guard rejects
//  - any request whose Host isn't a loopback name (localhost, 127.0.0.1, [::1]) or an explicitly allowed host,
//  - unsafe methods (not GET/HEAD/OPTIONS) whose Origin isn't an allowed host, or that the browser marks cross-site.
// A missing Origin is fine (curl, MCP, server-side calls). Extra hosts: NESEV_ALLOWED_HOSTS (comma-separated), plus
// NESEV_HOST when it names a specific address (not a wildcard like 0.0.0.0).

const LOOPBACK = ["localhost", "127.0.0.1", "::1"];
const WILDCARDS = new Set(["", "0.0.0.0", "::", "[::]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type OriginGuardEnv = { NESEV_ALLOWED_HOSTS?: string; NESEV_HOST?: string; [key: string]: string | undefined };

/** lower-case hostname without brackets/port */
function normalize(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

export function allowedHosts(env: OriginGuardEnv = process.env): Set<string> {
  const hosts = new Set(LOOPBACK);
  for (const h of (env.NESEV_ALLOWED_HOSTS ?? "").split(",")) {
    const n = normalize(h);
    if (n) hosts.add(n);
  }
  const bind = normalize(env.NESEV_HOST ?? "");
  if (!WILDCARDS.has(bind)) hosts.add(bind);
  return hosts;
}

/** hostname of a Host header value ("localhost:5174", "[::1]:3998"), or null if unparsable */
function hostOf(hostHeader: string): string | null {
  try {
    return normalize(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return null;
  }
}

function originHost(origin: string): string | null {
  try {
    return normalize(new URL(origin).hostname);
  } catch {
    return null; // "null" (sandboxed iframe, file://) and garbage
  }
}

const forbidden = (message: string) => Response.json({ error: message }, { status: 403 });

/** `env` is read per request (default process.env), so importing app.ts stays side-effect free */
export function originGuard(getEnv: () => OriginGuardEnv = () => process.env): MiddlewareHandler {
  return async (c, next) => {
    const hosts = allowedHosts(getEnv());
    const hostHeader = c.req.header("host") ?? new URL(c.req.url).host;
    const host = hostOf(hostHeader);
    if (!host || !hosts.has(host)) return forbidden("Zugriff verweigert: unbekannter Host");

    if (!SAFE_METHODS.has(c.req.method)) {
      if (c.req.header("sec-fetch-site") === "cross-site") return forbidden("Zugriff verweigert: fremde Herkunft");
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        const oh = originHost(origin);
        if (!oh || !hosts.has(oh)) return forbidden("Zugriff verweigert: fremde Herkunft");
      }
    }
    await next();
  };
}
