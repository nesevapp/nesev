# Releasing

nesev ships as a single executable per platform, built with `bun build --compile`. Users install it with
[`install.sh`](../install.sh) and update it with `nesev update`. Both download from
`https://github.com/nesevapp/nesev/releases/latest/download/`, so a release only reaches users once it is
**published** (drafts and pre-releases are never "latest").

## Cutting a release

1. Update `CHANGELOG.md` and set `"version"` in `package.json` (e.g. `0.2.0`). Commit.
2. Tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
3. The [release workflow](../.github/workflows/release.yml) runs typecheck and tests on Linux and macOS, then builds on
   macOS: the SPA, the Apple Vision OCR helper for arm64 and x86_64, and the four binaries. It smoke-tests the
   darwin-arm64 binary, checks the checksums and creates a **draft** release. The tag has to match the
   `package.json` version, or the workflow fails.
4. Open the draft on GitHub, edit the generated notes, and try an asset on a real machine
   (`tar -xzf nesev-darwin-arm64.tar.gz && ./nesev`).
5. Publish the release. From then on, `install.sh` and `nesev update` pick it up.

A tag with a suffix (`v0.2.0-rc.1`) creates a pre-release, which `install.sh` and `nesev update` ignore. Use it to
test the workflow.

## Release assets

| File | Content |
|---|---|
| `nesev-darwin-arm64.tar.gz`, `nesev-darwin-x64.tar.gz`, `nesev-linux-x64.tar.gz`, `nesev-linux-arm64.tar.gz` | `nesev` (the executable) and `LICENSE` |
| `SHA256SUMS` | SHA-256 of the archives (`shasum -a 256 -c SHA256SUMS`) |
| `VERSION` | the version number, used by `nesev update` to check for a newer release |

The asset names carry no version, so the `latest/download/<name>` URLs stay stable. Don't rename them: the installer
and `nesev update` (`src/cli/update.ts`) rely on them.

## How the binary works

- `scripts/build-binary.ts` generates `build/entry-<target>.ts`. That file embeds everything nesev reads at runtime
  (`dist/web`, the SQL migrations and `meta/_journal.json`, the fonts, the Swift OCR helper source and, on macOS, the
  precompiled helper) as `import … with { type: "file" }`, then calls `src/cli/main.ts`.
- On start, `src/cli/embedded.ts` extracts these files once per build to the cache folder (macOS
  `~/Library/Caches/nesev/<version>-<id>/`, Linux `~/.cache/nesev/…`, overridable with `NESEV_CACHE_DIR`). It sets
  `NESEV_APP_ROOT` to that folder, which `src/server/lib/app-files.ts` uses as `APP_ROOT`. Missing files are restored
  on the next start, and older builds are removed.
- `process.env.NODE_ENV` is fixed to `"production"` at build time (`--define`), so the binary always serves the
  built SPA.
- The OCR helper ships precompiled as `bin/nesev-ocr-<source hash>`, so Mac users don't need the Xcode tools. Run
  from source, `lib/ocr/helper.ts` still compiles it with `swiftc` on first use.
- x64 builds use Bun's `-baseline` runtime, which also runs on CPUs without AVX2 (older Intel Macs, Rosetta).
- Size: about 100 MB on macOS and 138 MB on Linux, or 37–53 MB as tar.gz. Bun itself is about 60 MB, and the pdfme
  template designer's PDF worker and pdfium wasm in `dist/web` add about 20 MB.

## Building and testing locally

```bash
bun run build:binary                          # this machine's target → build/bin/<target>/nesev
bun scripts/build-binary.ts --all --package   # all targets + build/release/ (as in CI); --skip-web reuses dist/web
```

Try a binary without touching your real setup. Pick a free port, and use temp folders for everything:

```bash
T=$(mktemp -d)
HOME=$T NESEV_CONFIG_DIR=$T/cfg NESEV_CACHE_DIR=$T/cache NESEV_API_URL=http://127.0.0.1:9 PORT=3990 \
  build/bin/darwin-arm64/nesev start
```

To test the installer and `nesev update` against a local "release", serve `build/release/` over HTTP. Skip the
service: installing it would really load a launchd agent / systemd unit, even with a temp `HOME`.

```bash
python3 -m http.server 3991 --bind 127.0.0.1 --directory build/release &
T=$(mktemp -d)
HOME=$T NESEV_RELEASE_URL=http://127.0.0.1:3991 NESEV_SKIP_SERVICE=1 NESEV_NO_OPEN=1 NESEV_CACHE_DIR=$T/cache sh install.sh
HOME=$T NESEV_RELEASE_URL=http://127.0.0.1:3991 NESEV_CACHE_DIR=$T/cache $T/.local/bin/nesev update --force
```

The Linux binaries can be tried in Docker, e.g.
`docker run --rm -v $PWD/build/bin/linux-arm64:/opt/nesev:ro debian:bookworm-slim /opt/nesev/nesev --version`.

## Not done yet

- **Code signing / notarization (macOS)**: the binaries are only ad-hoc signed. That is fine with `install.sh`, because
  curl doesn't set the quarantine flag. A file downloaded in the browser is blocked by Gatekeeper until the user runs
  `xattr -d com.apple.quarantine nesev`. Fixing that needs an Apple Developer ID plus `codesign` and `notarytool` in the
  workflow.
- **Windows**: Bun can compile `bun-windows-x64`, but there is no service integration (`nesev service`), no updater
  for `.exe` and no installer, and the build has never been run on Windows. Not shipped.
