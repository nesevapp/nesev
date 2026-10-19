#!/bin/sh
# nesev installer for macOS and Linux (no admin rights needed):
#
#   curl -fsSL https://raw.githubusercontent.com/nesevapp/nesev/main/install.sh | sh
#
# Downloads the latest release for this computer, checks its SHA-256 checksum, installs it to ~/.local/bin/nesev,
# sets up the background service (starts with the login) and opens nesev in the browser. Running it again updates
# nesev. Remove it again: nesev uninstall (or: curl … | sh -s -- --uninstall). Your data is never deleted.
#
# Environment: NESEV_INSTALL_DIR (default ~/.local/bin), NESEV_PORT (default 3998), NESEV_RELEASE_URL (where the
# release assets come from), NESEV_SKIP_SERVICE=1 (no background service), NESEV_NO_OPEN=1 (don't open the browser).

# shellcheck disable=SC1111 # German quotation marks in messages
set -eu

BASE_URL="${NESEV_RELEASE_URL:-https://github.com/nesevapp/nesev/releases/latest/download}"
INSTALL_DIR="${NESEV_INSTALL_DIR:-$HOME/.local/bin}"
PORT="${NESEV_PORT:-3998}"
BIN="$INSTALL_DIR/nesev"
URL="http://localhost:$PORT"

say() { printf '%s\n' "$*"; }
fail() {
  printf '\nFehler: %s\n' "$*" >&2
  exit 1
}

if [ "${1:-}" = "--uninstall" ]; then
  if [ -x "$BIN" ]; then
    "$BIN" uninstall
  else
    say "nesev ist nicht installiert ($BIN fehlt)."
  fi
  exit 0
fi

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "nesev gibt es für macOS und Linux (dieses System: $os)." ;;
esac
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "Für diesen Prozessor ($arch) gibt es keine fertige nesev-Version." ;;
esac
# a Terminal running under Rosetta on Apple silicon still gets the native build
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
asset="nesev-$os-$arch.tar.gz"

command -v curl >/dev/null 2>&1 || fail "curl fehlt."
command -v tar >/dev/null 2>&1 || fail "tar fehlt."
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "sha256sum/shasum fehlt (zum Prüfen des Downloads)."
fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t nesev)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "nesev wird heruntergeladen ($asset) …"
curl -fL --progress-bar -o "$tmp/$asset" "$BASE_URL/$asset" || fail "Download fehlgeschlagen: $BASE_URL/$asset"
curl -fsSL -o "$tmp/SHA256SUMS" "$BASE_URL/SHA256SUMS" || fail "Download fehlgeschlagen: $BASE_URL/SHA256SUMS"
expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "$asset fehlt in SHA256SUMS."
actual=$(sha256 "$tmp/$asset")
[ "$expected" = "$actual" ] || fail "Prüfsumme stimmt nicht – der Download ist beschädigt. Nichts wurde geändert, bitte erneut versuchen."
tar -xzf "$tmp/$asset" -C "$tmp" || fail "Entpacken fehlgeschlagen."
[ -f "$tmp/nesev" ] || fail "$asset enthält kein Programm „nesev“."

mkdir -p "$INSTALL_DIR"
cp "$tmp/nesev" "$INSTALL_DIR/.nesev.new"
chmod 755 "$INSTALL_DIR/.nesev.new"
# curl doesn't set the quarantine flag, but remove it in case the file came from elsewhere (Gatekeeper)
if [ "$os" = darwin ]; then xattr -d com.apple.quarantine "$INSTALL_DIR/.nesev.new" 2>/dev/null || true; fi
mv -f "$INSTALL_DIR/.nesev.new" "$BIN"
version=$("$BIN" --version) || fail "nesev lässt sich nicht starten ($BIN)."
say "nesev $version installiert: $BIN"

service=0
if [ "${NESEV_SKIP_SERVICE:-}" = 1 ]; then
  say "Hintergrunddienst übersprungen (NESEV_SKIP_SERVICE=1). Starten: $BIN"
elif "$BIN" service install --port "$PORT"; then
  service=1
else
  say "Der Hintergrunddienst ließ sich nicht einrichten. nesev stattdessen selbst starten: $BIN"
fi

if [ "$service" = 1 ]; then
  # wait until the server answers (first start extracts its files)
  i=0
  while [ $i -lt 30 ] && ! curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/setup/status" 2>/dev/null; do
    sleep 1
    i=$((i + 1))
  done
  if [ "${NESEV_NO_OPEN:-}" != 1 ]; then
    if [ "$os" = darwin ]; then open "$URL" 2>/dev/null || true; else xdg-open "$URL" >/dev/null 2>&1 || true; fi
  fi
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say ""
    say "Tipp: damit der Befehl „nesev“ im Terminal gefunden wird, diese Zeile in ~/.zshrc bzw. ~/.bashrc eintragen:"
    say "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

say ""
if [ "$service" = 1 ]; then
  say "Fertig! nesev läuft auf $URL – beim ersten Start wählst du dort den Ordner für deine Daten."
else
  say "Fertig! Starten mit: $BIN (öffnet nesev im Browser; beim ersten Start wählst du den Ordner für deine Daten)."
fi
say "Aktualisieren: nesev update (oder diesen Befehl nochmal ausführen). Entfernen: nesev uninstall"
