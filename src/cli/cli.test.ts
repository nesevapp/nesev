import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildId, extractEmbedded } from "./embedded";
import {
  binaryServiceSpec,
  buildPlist,
  buildSystemdUnit,
  installedServicePort,
  installService,
  isServiceInstalled,
  serviceLocation,
  servicePath,
} from "./service";
import { parseSums, sha256, updateBinary } from "./update";
import { compareVersions } from "./version";

const tmp = () => mkdtempSync(join(tmpdir(), "nesev-cli-"));

describe("service files", () => {
  const home = "/home/x";
  const loc = serviceLocation("linux", home, {});
  const spec = binaryServiceSpec({ execPath: "/home/x/My Apps/nesev", port: 3998, location: loc });

  test("systemd unit runs `<binary> start` with Restart=always and NESEV_SERVICE", () => {
    const unit = buildSystemdUnit({ ...spec, env: { ...spec.env, NESEV_DATA_DIR: "/data/100%$x" } });
    expect(unit).toContain('ExecStart="/home/x/My Apps/nesev" start\n');
    expect(unit).toContain("Environment=PORT=3998\n");
    expect(unit).toContain("Environment=NESEV_SERVICE=1\n");
    expect(unit).toContain('Environment="NESEV_DATA_DIR=/data/100%%$$x"\n');
    expect(unit).toContain("Restart=always\n");
    expect(unit).toContain("WantedBy=default.target\n");
    expect(unit).not.toContain("WorkingDirectory");
    expect(loc.unitPath).toBe("/home/x/.config/systemd/user/nesev.service");
  });

  test("binary plist: ProgramArguments without bun, PATH starts with the binary's dir", () => {
    const mac = binaryServiceSpec({ execPath: "/Users/x/.local/bin/nesev", port: 3999, location: serviceLocation("darwin", "/Users/x", {}) });
    const plist = buildPlist(mac);
    expect(plist).toContain("<array>\n    <string>/Users/x/.local/bin/nesev</string>\n    <string>start</string>\n  </array>");
    expect(plist).not.toContain("WorkingDirectory");
    expect(plist).toContain("<string>/Users/x/Library/Logs/nesev/nesev.log</string>");
    expect(servicePath("/Users/x/.local/bin", "darwin").split(":")[0]).toBe("/Users/x/.local/bin");
    if (process.platform === "darwin") {
      const file = join(tmp(), "at.nesev.plist");
      writeFileSync(file, plist);
      expect(spawnSync("plutil", ["-lint", file], { encoding: "utf8" }).stdout.trim()).toEndWith("OK");
    }
  });

  test("installed port is read back from the plist/unit", () => {
    const dir = tmp();
    const mac = serviceLocation("darwin", dir, {});
    mkdirSync(join(dir, "Library/LaunchAgents"), { recursive: true });
    writeFileSync(mac.plistPath, buildPlist(binaryServiceSpec({ execPath: "/x/nesev", port: 3977, location: mac })));
    expect(installedServicePort(mac)).toBe(3977);
    const linux = serviceLocation("linux", dir, {});
    expect(isServiceInstalled(linux)).toBe(false);
    expect(installedServicePort(linux)).toBeNull();
    mkdirSync(join(dir, ".config/systemd/user"), { recursive: true });
    writeFileSync(linux.unitPath, buildSystemdUnit(binaryServiceSpec({ execPath: "/x/nesev", port: 3978, location: linux })));
    expect(installedServicePort(linux)).toBe(3978);
  });

  test("dry run writes to a temp dir only", () => {
    const dir = tmp();
    for (const platform of ["darwin", "linux"] as const) {
      if (platform === "darwin" && process.platform !== "darwin") continue; // needs plutil
      const loc = serviceLocation(platform, dir, {});
      const r = installService(binaryServiceSpec({ execPath: "/x/nesev", port: 3998, location: loc }), { dryRun: true, location: loc });
      expect(r.file.startsWith(dir)).toBe(false);
      expect(readFileSync(r.file, "utf8")).toBe(r.content!);
      expect(isServiceInstalled(loc)).toBe(false);
    }
  });
});

describe("embedded files", () => {
  test("extracts once, restores missing files, prunes older builds", () => {
    const src = tmp();
    const base = join(tmp(), "cache");
    writeFileSync(join(src, "index-abc.html"), "<html>");
    writeFileSync(join(src, "helper-def"), "#!/bin/sh\n");
    const files = [
      ["dist/web/index.html", join(src, "index-abc.html")],
      ["bin/nesev-ocr-123", join(src, "helper-def")],
    ] as const;
    mkdirSync(join(base, "0.0.9-old"), { recursive: true });
    const root = extractEmbedded(files, "1.0.0", base);
    expect(root).toBe(join(base, `1.0.0-${buildId(files)}`));
    expect(readFileSync(join(root, "dist/web/index.html"), "utf8")).toBe("<html>");
    expect(statSync(join(root, "bin/nesev-ocr-123")).mode & 0o111).toBeTruthy();
    expect(existsSync(join(base, "0.0.9-old"))).toBe(false);

    rmSync(join(root, "dist/web/index.html"));
    expect(extractEmbedded(files, "1.0.0", base)).toBe(root);
    expect(existsSync(join(root, "dist/web/index.html"))).toBe(true);
    // a changed file (= different embedded name) is a different build
    expect(buildId([["dist/web/index.html", join(src, "index-xyz.html")]])).not.toBe(buildId([files[0]]));
  });
});

describe("versions and checksums", () => {
  test("compareVersions", () => {
    expect(compareVersions("0.10.0", "0.9.1")).toBe(1);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-beta.1", "1.2.4")).toBe(-1);
  });
  test("parseSums", () => {
    const h = "a".repeat(64);
    const sums = parseSums(`${h}  nesev-linux-x64.tar.gz\n${"B".repeat(64)} *VERSION\n\n`);
    expect(sums.get("nesev-linux-x64.tar.gz")).toBe(h);
    expect(sums.get("VERSION")).toBe("b".repeat(64));
  });
});

describe("update", () => {
  const releases = tmp();
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  let sums = "";

  beforeAll(() => {
    // a fake release: the "binary" is a shell script that prints its version
    const pkg = join(releases, "pkg");
    mkdirSync(pkg);
    writeFileSync(join(pkg, "nesev"), "#!/bin/sh\necho 9.9.9\n");
    chmodSync(join(pkg, "nesev"), 0o755);
    spawnSync("tar", ["-czf", join(releases, "nesev-linux-x64.tar.gz"), "-C", pkg, "nesev"]);
    sums = `${sha256(readFileSync(join(releases, "nesev-linux-x64.tar.gz")))}  nesev-linux-x64.tar.gz\n`;
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const name = new URL(req.url).pathname.slice(1);
        if (name === "VERSION") return new Response("9.9.9\n");
        if (name === "SHA256SUMS") return new Response(sums);
        const file = join(releases, name);
        return existsSync(file) ? new Response(Bun.file(file)) : new Response("not found", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  const installed = () => {
    const bin = join(tmp(), "nesev");
    writeFileSync(bin, "old");
    return bin;
  };

  test("replaces the binary with the verified newer release", async () => {
    const bin = installed();
    const r = await updateBinary({ current: "0.1.0", binaryPath: bin, base, target: "linux-x64" });
    expect(r).toEqual({ from: "0.1.0", to: "9.9.9", updated: true });
    expect(readFileSync(bin, "utf8")).toContain("echo 9.9.9");
    expect(statSync(bin).mode & 0o111).toBeTruthy();
  });

  test("up to date or --check: nothing downloaded", async () => {
    const bin = installed();
    expect((await updateBinary({ current: "9.9.9", binaryPath: bin, base, target: "linux-x64" })).updated).toBe(false);
    expect((await updateBinary({ current: "0.1.0", binaryPath: bin, base, target: "linux-x64", checkOnly: true })).updated).toBe(false);
    expect(readFileSync(bin, "utf8")).toBe("old");
  });

  test("a checksum mismatch or missing asset changes nothing", async () => {
    const bin = installed();
    const good = sums;
    sums = `${"0".repeat(64)}  nesev-linux-x64.tar.gz\n`;
    await expect(updateBinary({ current: "0.1.0", binaryPath: bin, base, target: "linux-x64" })).rejects.toThrow("Prüfsumme");
    sums = good;
    await expect(updateBinary({ current: "0.1.0", binaryPath: bin, base, target: "linux-arm64" })).rejects.toThrow();
    expect(readFileSync(bin, "utf8")).toBe("old");
  });
});
