import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { allowedHosts, type OriginGuardEnv, originGuard } from "./origin-guard";

function makeApp(env: OriginGuardEnv = {}) {
  return new Hono()
    .use("*", originGuard(() => env))
    .get("/api/settings", (c) => c.json({ ok: true }))
    .post("/api/clients", (c) => c.json({ ok: true }, 201));
}

const get = (app: Hono, headers: Record<string, string>) => app.request("http://localhost/api/settings", { headers });
const post = (app: Hono, headers: Record<string, string>) =>
  app.request("http://localhost/api/clients", { method: "POST", headers });

describe("Host check", () => {
  test("loopback hosts with any port are allowed", async () => {
    const app = makeApp();
    for (const host of ["localhost", "localhost:5174", "127.0.0.1:3998", "[::1]:3998", "LOCALHOST:1"]) {
      expect((await get(app, { host })).status).toBe(200);
    }
  });

  test("rebinding host is rejected on GET with a German JSON error", async () => {
    const res = await get(makeApp(), { host: "evil.example" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("Zugriff verweigert");
    expect((await get(makeApp(), { host: "evil.example:3998" })).status).toBe(403);
    expect((await get(makeApp(), { host: "127.0.0.1.evil.example" })).status).toBe(403);
  });

  test("NESEV_ALLOWED_HOSTS and a specific NESEV_HOST are honoured", async () => {
    const app = makeApp({ NESEV_ALLOWED_HOSTS: " nesev.lan , 192.168.1.20", NESEV_HOST: "10.0.0.5" });
    expect((await get(app, { host: "nesev.lan:3998" })).status).toBe(200);
    expect((await get(app, { host: "192.168.1.20:3998" })).status).toBe(200);
    expect((await get(app, { host: "10.0.0.5:3998" })).status).toBe(200);
    expect((await post(app, { host: "nesev.lan:3998", origin: "http://nesev.lan:3998" })).status).toBe(201);
    expect((await get(app, { host: "evil.example" })).status).toBe(403);
  });

  test("wildcard NESEV_HOST adds nothing", () => {
    expect([...allowedHosts({ NESEV_HOST: "0.0.0.0" })].sort()).toEqual(["127.0.0.1", "::1", "localhost"]);
    expect(allowedHosts({ NESEV_HOST: "::" }).has("::")).toBe(false);
  });
});

describe("Origin check on unsafe methods", () => {
  const app = makeApp();
  test("foreign Origin on POST is rejected", async () => {
    expect((await post(app, { host: "localhost:3998", origin: "https://evil.example" })).status).toBe(403);
    expect((await post(app, { host: "localhost:3998", origin: "null" })).status).toBe(403);
  });

  test("same-origin POST (incl. via the Vite proxy) is allowed", async () => {
    expect((await post(app, { host: "localhost:5174", origin: "http://localhost:5174" })).status).toBe(201);
    expect(
      (await post(app, { host: "127.0.0.1:3998", origin: "http://127.0.0.1:3998", "sec-fetch-site": "same-origin" }))
        .status,
    ).toBe(201);
  });

  test("POST without Origin is allowed (curl, MCP, server-side)", async () => {
    expect((await post(app, { host: "127.0.0.1:3998" })).status).toBe(201);
  });

  test("Sec-Fetch-Site: cross-site on POST is rejected", async () => {
    expect((await post(app, { host: "localhost:3998", "sec-fetch-site": "cross-site" })).status).toBe(403);
  });

  test("GET with a foreign Origin is not blocked by the Origin check (CORS keeps it unreadable)", async () => {
    expect((await get(app, { host: "localhost:3998", origin: "https://evil.example" })).status).toBe(200);
  });
});
