import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlist, servicePath } from "./service";

describe("launchd plist", () => {
  const plist = buildPlist({
    bunPath: "/Users/x/.bun/bin/bun",
    root: "/Users/x/Dev & Co/nesev",
    port: 3998,
    logDir: "/Users/x/Library/Logs/nesev",
    path: servicePath("/Users/x/.bun/bin/bun", "darwin"),
    dataDir: "/tmp/nesev-data",
  });

  test("runs the production server from the repo with KeepAlive and RunAtLoad", () => {
    expect(plist).toContain("<string>/Users/x/.bun/bin/bun</string>\n    <string>src/server/index.ts</string>");
    expect(plist).toContain("<string>/Users/x/Dev &amp; Co/nesev</string>");
    expect(plist).toContain("<key>NODE_ENV</key>\n    <string>production</string>");
    expect(plist).toContain("<key>PORT</key>\n    <string>3998</string>");
    expect(plist).toContain("<key>NESEV_DATA_DIR</key>\n    <string>/tmp/nesev-data</string>");
    expect(plist).toContain("<key>NESEV_SERVICE</key>\n    <string>1</string>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(servicePath("/Users/x/.bun/bin/bun", "darwin").split(":").slice(0, 2)).toEqual(["/Users/x/.bun/bin", "/opt/homebrew/bin"]);
  });

  test.skipIf(process.platform !== "darwin")("passes plutil -lint", () => {
    const file = join(mkdtempSync(join(tmpdir(), "nesev-plist-")), "at.nesev.plist");
    writeFileSync(file, plist);
    const r = spawnSync("plutil", ["-lint", file], { encoding: "utf8" });
    expect(r.stdout.trim()).toEndWith("OK");
  });
});
