import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../../cli/version";
import { getUpdateStatus, parseRelease, resetUpdateCache, setUpdateCheck } from "./update-check";

// readConfig/writeConfig use NESEV_CONFIG_DIR; the fetcher is fake, nothing goes to the network.
let root: string;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nesev-update-"));
  saved = { NESEV_CONFIG_DIR: process.env.NESEV_CONFIG_DIR, NESEV_UPDATE_CHECK: process.env.NESEV_UPDATE_CHECK };
  process.env.NESEV_CONFIG_DIR = root;
  delete process.env.NESEV_UPDATE_CHECK;
  resetUpdateCache();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(root, { recursive: true, force: true });
});

const bump = (v: string) => v.replace(/(\d+)$/, (n) => String(Number(n) + 1));
const release = (tag: string, body = "") => ({ tag_name: tag, html_url: `https://example.test/${tag}`, body });
function fakeFetch(responses: (object | Error)[]) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    const next = responses.shift();
    if (!next || next instanceof Error) throw next ?? new Error("no response");
    return new Response(JSON.stringify(next), { status: 200 });
  };
  return { fetcher, calls };
}

describe("parseRelease", () => {
  test("tag, link and security flag; drafts, pre-releases and odd tags are ignored", () => {
    expect(parseRelease(release("v1.2.3", "Fixes GHSA-abcd-1234"))).toEqual({
      version: "1.2.3",
      url: "https://example.test/v1.2.3",
      security: true,
    });
    expect(parseRelease(release("v1.2.3", "Neue Funktionen"))?.security).toBe(false);
    expect(parseRelease({ ...release("v1.2.3"), prerelease: true })).toBeNull();
    expect(parseRelease({ ...release("v1.2.3"), draft: true })).toBeNull();
    expect(parseRelease(release("nightly"))).toBeNull();
    expect(parseRelease(null)).toBeNull();
  });
});

describe("getUpdateStatus", () => {
  test("on by default: reports a newer release, caches it for a day", async () => {
    const newer = bump(VERSION);
    const { fetcher, calls } = fakeFetch([release(`v${newer}`, "Security fix"), release(`v${newer}`)]);
    const s = await getUpdateStatus({ fetcher, now: 1_000 });
    expect(s).toMatchObject({ enabled: true, current: VERSION, latest: newer, newer: true, security: true, error: null });
    await getUpdateStatus({ fetcher, now: 1_000 + 60_000 });
    expect(calls.length).toBe(1);
    await getUpdateStatus({ fetcher, now: 1_000 + 25 * 60 * 60 * 1000 });
    expect(calls.length).toBe(2);
  });

  test("same version: not newer, no security hint", async () => {
    const { fetcher } = fakeFetch([release(`v${VERSION}`, "GHSA-xxxx")]);
    expect(await getUpdateStatus({ fetcher })).toMatchObject({ newer: false, security: false, latest: VERSION });
  });

  test("errors are reported and retried after an hour", async () => {
    const { fetcher, calls } = fakeFetch([new Error("offline"), release(`v${bump(VERSION)}`)]);
    expect(await getUpdateStatus({ fetcher, now: 0 })).toMatchObject({ newer: false, error: "offline" });
    await getUpdateStatus({ fetcher, now: 30 * 60 * 1000 });
    expect(calls.length).toBe(1);
    expect(await getUpdateStatus({ fetcher, now: 61 * 60 * 1000 })).toMatchObject({ newer: true, error: null });
  });

  test("switched off (setting or NESEV_UPDATE_CHECK=0): never fetches", async () => {
    const { fetcher, calls } = fakeFetch([release(`v${bump(VERSION)}`)]);
    setUpdateCheck(false);
    expect(await getUpdateStatus({ fetcher, force: true })).toMatchObject({ enabled: false, newer: false, latest: null });
    setUpdateCheck(true);
    process.env.NESEV_UPDATE_CHECK = "0";
    expect(await getUpdateStatus({ fetcher, force: true })).toMatchObject({ enabled: false, lockedByEnv: true });
    expect(calls.length).toBe(0);
  });
});
