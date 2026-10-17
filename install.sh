#!/usr/bin/env bash
# 9Router installer/updater for Linux and macOS.
# Installs the CLI into a per-user directory (~/.9router/cli) so upgrades never
# collide with a locked npm global dir, and manages stop/start of the running
# service around the install. Prefers `acs service --force` stop/start when the
# acs CLI exists (which also pauses/resumes the ACS watchdog cadence on
# acs-managed machines), then falls back to process-level handling so
# machines without acs (non-acs installs) are fully supported too.
set -euo pipefail

REPO_OWNER="andyvandaric"
REPO_NAME="9router"
VERSION="latest"
PORT="${PORT:-20128}"
NO_START=0
CUSTOM_URL=""

usage() {
  cat <<'EOF'
Usage: install.sh [--version X.Y.Z] [--port 20128] [--no-start] [--url <tgz-url>]

  --version X.Y.Z   Pin a fork-patch release (default: latest)
  --port N          Server port to start/restart on (default: 20128)
  --no-start        Stop/upgrade only; do not start the service
  --url URL         Install directly from this tgz URL (overrides --version)
EOF
  exit 0
}

say()  { printf '==> %s\n' "$1"; }
okay() { printf '    OK %s\n' "$1"; }
warn() { printf '    !! %s\n' "$1" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --url) CUSTOM_URL="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

# 1. Preflight -------------------------------------------------------------
for cmd in node npm curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Missing dependency: $cmd" >&2; exit 1; }
done
okay "node $(node --version) found"

ACS_BIN=""
if command -v acs >/dev/null 2>&1; then ACS_BIN="$(command -v acs)"; fi

SERVER_URL="http://127.0.0.1:${PORT}"

# 2. Resolve download URL --------------------------------------------------
if [ -n "$CUSTOM_URL" ]; then
  DOWNLOAD_URL="$CUSTOM_URL"
elif [ "$VERSION" = "latest" ]; then
  DOWNLOAD_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/9router-latest.tgz"
else
  CLEAN_VERSION="${VERSION#v}"
  DOWNLOAD_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${CLEAN_VERSION}-andyvandaric-patch/9router-${CLEAN_VERSION}.tgz"
fi

# 3. Download FIRST (before stopping) to minimize service downtime ---------
TMPDIR_="$(mktemp -d)"
STOPPED=0
INSTALL_DONE=0

# Restore-on-failure -------------------------------------------------------
# The upgrade window stops the service, so a failure in between (a failed npm
# install is the real-world case) must not leave the stack down. This runs on
# every exit path, including the `set -e` aborts.
restore_state() {
  rm -rf "$TMPDIR_"
  [ "$STOPPED" -eq 1 ] || return 0
  [ "$INSTALL_DONE" -eq 1 ] && return 0
  curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && return 0
  warn "install window left the service stopped - restoring it"
  if [ -n "${ACS_BIN:-}" ] && "$ACS_BIN" service start 9router --force >/dev/null 2>&1; then
    :
  elif [ -n "${CLI_JS:-}" ] && [ -e "${CLI_JS:-}" ]; then
    nohup node "$CLI_JS" --tray --skip-update -p "$PORT" >/dev/null 2>&1 &
  fi
  for _ in $(seq 1 10); do
    sleep 0.5
    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      okay "service healthy again on port ${PORT}"
      return 0
    fi
  done
  warn "could not confirm health after restore; start manually: nohup node \"${CLI_JS:-<cli.js>}\" --tray --skip-update -p ${PORT} >/dev/null 2>&1 &"
}
trap restore_state EXIT
TGZ="${TMPDIR_}/9router.tgz"
say "Downloading ${DOWNLOAD_URL}"
curl -fSL --retry 3 -o "$TGZ" "$DOWNLOAD_URL"
[ -s "$TGZ" ] || { echo "Downloaded tarball is empty" >&2; exit 1; }
okay "saved $(du -h "$TGZ" | cut -f1)"

# 4. Stop every running 9Router instance ------------------------------------
say "Stopping running 9Router processes (if any)"
if [ -n "$ACS_BIN" ]; then
  if "$ACS_BIN" service stop 9router --force >/dev/null 2>&1; then
    okay "stopped via acs (--force)"
  elif "$ACS_BIN" service stop 9router >/dev/null 2>&1; then
    okay "stopped via acs"
  else
    warn "acs stop failed; falling back to process scan"
  fi
fi
# Leftovers outside acs management (non-acs installs) are killed by pattern.
STOP_CLEAN=1
for _ in 1 2 3 4 5; do
  LEFTOVER="$(pgrep -f 'node_modules/9router' 2>/dev/null || true)"
  [ -z "$LEFTOVER" ] || STOP_CLEAN=0
  if [ -z "$LEFTOVER" ] && command -v lsof >/dev/null 2>&1; then
    LISTENERS="$(lsof -ti tcp:"${PORT}" 2>/dev/null || true)"
    [ -z "$LISTENERS" ] || STOP_CLEAN=0
  fi
  if pgrep -f 'node_modules/9router' >/dev/null 2>&1; then
    pkill -9 -f "node_modules/9router" 2>/dev/null || true
    warn "killed leftover 9router processes"
  elif command -v lsof >/dev/null 2>&1 && lsof -ti tcp:"${PORT}" >/dev/null 2>&1; then
    # shellcheck disable=SC2046
    kill -9 $(lsof -ti tcp:"${PORT}" 2>/dev/null) 2>/dev/null || true
    warn "freed port ${PORT}"
  else
    break
  fi
  sleep 1
done
if [ "$STOP_CLEAN" -ne 1 ]; then
  warn "processes kept reappearing - continuing anyway (install is user-dir, unaffected)"
else
  okay "nothing is holding port ${PORT} now"
fi
STOPPED=1
sleep 1

# 5. Purge the stale global install (prevents PATH shadowing) ---------------
say "Removing stale global npm install (if any)"
if npm ls -g 9router >/dev/null 2>&1; then
  if npm uninstall -g 9router >/dev/null 2>&1; then
    okay "Global 9router removed"
  else
    warn "Global removal failed; user-dir shim may be shadowed"
  fi
else
  okay "No global install to purge"
fi

# Stale shims from a partially-uninstalled global can sit in the npm prefix
# root and shadow the user-dir shim in PATH order.
say "Cleaning stale global bin shims (if any)"
NPM_PREFIX="$(npm config get prefix 2>/dev/null | head -n1 || true)"
if [ -n "$NPM_PREFIX" ] && [ "$NPM_PREFIX" != "${HOME}/.9router/cli" ]; then
  rm -f "$NPM_PREFIX/bin/9router" "$NPM_PREFIX/bin/9router.cmd" 2>/dev/null || true
  rm -f "$NPM_PREFIX/9router" "$NPM_PREFIX/9router.cmd" "$NPM_PREFIX/9router.ps1" 2>/dev/null || true
fi
okay "Shim cleanup done"

# 6. Install into the user dir ----------------------------------------------
#    npm --global --prefix <dir> puts the package in <dir>/lib/node_modules/9router
#    and a bin shim in <dir>/bin/9router - a per-user tree we always own, so
#    no file in it can be locked by a managed global dir again.
say "Installing into ${HOME}/.9router/cli"
if ! npm install --global --prefix "${HOME}/.9router/cli" "$TGZ" >/dev/null 2>&1; then
  # npm can die with an empty log and a non-zero exit when a supervisor window
  # races the install (observed on Windows), so retry once before giving up.
  warn "npm install failed - retrying once"
  sleep 2
  if ! npm install --global --prefix "${HOME}/.9router/cli" "$TGZ" >/dev/null 2>&1; then
    npm install --global --prefix "${HOME}/.9router/cli" "$TGZ"  # rerun to surface the error
    exit 1
  fi
fi
SHIM="${HOME}/.9router/cli/bin/9router"
[ -e "$SHIM" ] || { echo "Install finished but ${SHIM} was not created" >&2; exit 1; }
CLI_JS="${HOME}/.9router/cli/lib/node_modules/9router/cli.js"
[ -e "$CLI_JS" ] || { echo "Missing ${CLI_JS} after install" >&2; exit 1; }
okay "Installed"

# 7. PATH management (shell profile, current session) ------------------------
say "Ensuring ~/.9router/cli/bin is on your PATH"
mkdir -p "${HOME}/.9router/cli/bin"
export PATH="${HOME}/.9router/cli/bin:${PATH}"
PATH_LINE='export PATH="${HOME}/.9router/cli/bin:$PATH"'
add_rc() {
  local rc="$1"
  [ -f "$rc" ] || touch "$rc"
  grep -qF '.9router/cli/bin' "$rc" 2>/dev/null || printf '\n# 9Router CLI (%s)\n%s\n' "$(date +%Y-%m-%d)" "$PATH_LINE" >> "$rc"
}
add_rc "${HOME}/.bashrc"
for rc in "${HOME}/.zshrc" "${HOME}/.profile"; do
  [ -f "$rc" ] && add_rc "$rc"
done
okay "PATH added to shell profiles (new terminals pick it up)"

# 8. Verify -------------------------------------------------------------------
PKG="${HOME}/.9router/cli/lib/node_modules/9router/package.json"
[ -f "$PKG" ] || { echo "Installed package.json missing" >&2; exit 1; }
INSTALLED="$(node -e "console.log(require('$PKG').version)")"
okay "9Router v${INSTALLED} installed"
if [ "$VERSION" != "latest" ] && [ "$INSTALLED" != "${VERSION#v}" ]; then
  echo "Installed version ${INSTALLED} does not match requested ${VERSION}" >&2
  exit 1
fi

# 9. Start the service (fully silent, no terminal) ----------------------------
if [ "$NO_START" -eq 1 ]; then
  say "-no-start given; start later with: nohup node \"${CLI_JS}\" --tray --skip-update -p ${PORT} >/dev/null 2>&1 &"
  INSTALL_DONE=1
else
  say "Starting 9Router on port ${PORT}"
  STARTED_VIA_ACS=0
  if [ -n "$ACS_BIN" ]; then
    if "$ACS_BIN" service start 9router --force >/dev/null 2>&1; then
      STARTED_VIA_ACS=1
      okay "started via acs (--force)"
    elif "$ACS_BIN" service start 9router >/dev/null 2>&1; then
      STARTED_VIA_ACS=1
      okay "started via acs"
    fi
  fi
  wait_health() {
    for _ in $(seq 1 30); do
      sleep 0.5
      curl -fsS --max-time 2 "${SERVER_URL}/api/health" >/dev/null 2>&1 && return 0
    done
    return 1
  }
  if ! wait_health && [ "$STARTED_VIA_ACS" -ne 1 ]; then
    warn "Service not healthy yet - spawning manually (nohup, fully silent)"
    # nohup + & detaches from this shell: survives terminal close, writes no
    # console output, and starts no terminal on macOS/Linux.
    nohup node "$CLI_JS" --tray --skip-update -p "$PORT" >/dev/null 2>&1 &
  fi
  if wait_health; then
    okay "Server is healthy at ${SERVER_URL}"
    INSTALL_DONE=1
    printf '\n  Dashboard: %s/dashboard\n  Gateway:   %s/v1\n  Data dir:  %s/.9router (untouched by this install)\n' \
      "$SERVER_URL" "$SERVER_URL" "$HOME"
  else
    warn "Server did not report healthy within 15s. Check: nohup node \"${CLI_JS}\" --tray --skip-update -p ${PORT} >/dev/null 2>&1 &"
  fi
fi

echo
echo "Done."
