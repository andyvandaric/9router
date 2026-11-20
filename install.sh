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
  --no-start        Install/upgrade only; do not start the server
  --url URL         Install directly from this tgz URL (overrides --version)
EOF
  exit 0
}

say()  { printf '==> %s\n' "$1"; }
okay() { printf '    OK %s\n' "$1"; }
warn() { printf '    !! %s\n' "$1" >&2; }

# Listener discovery without lsof -------------------------------------------
# lsof cannot see a leftover next-server: its comm is `next-server (v1` and the
# unclosed paren breaks lsof's /proc name parse, so `lsof -ti tcp:$PORT` returns
# nothing while the port is LISTEN. Resolve the listening socket inode from
# /proc/net/tcp{,6} instead - that path never parses comm.
proc_net_listener_pids() {
  case "${PORT:-}" in ''|*[!0-9]*) return 0 ;; esac
  local port_hex inode_set fd target inode pid
  port_hex="$(printf '%04X' "$((10#$PORT))")"
  # st == 0A is LISTEN; field 2 is local_address (hex ip:hex port), field 10 inode.
  inode_set="$(awk -v p="$port_hex" '$4 == "0A" { split($2, a, ":"); if (toupper(a[2]) == p && $10 != "0") print $10 }' \
    /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u | tr '\n' ' ' || true)"
  [ -n "$inode_set" ] || return 0
  inode_set=" ${inode_set} "
  for fd in /proc/[0-9]*/fd/*; do
    [ -L "$fd" ] || continue
    target="$(readlink "$fd" 2>/dev/null)" || continue
    case "$target" in
      socket:\[*) inode="${target#socket:[}"; inode="${inode%]}" ;;
      *) continue ;;
    esac
    case "$inode_set" in *" ${inode} "*) ;; *) continue ;; esac
    pid="${fd#/proc/}"
    printf '%s\n' "${pid%%/*}"
  done | sort -u
}

# Merge the inode scan (primary) with opportunistic lsof/ss results. Every
# source must be LISTENER-scoped: an unscoped `lsof -ti tcp:$PORT` (or `fuser`)
# also lists processes holding a client connection to the port - a browser on
# the dashboard would then be mistaken for the port's owner and refused.
# `fuser` has no state filter at all, so it is deliberately not used here.
port_listener_pids() {
  local pids=""
  pids="$(proc_net_listener_pids)"
  if command -v lsof >/dev/null 2>&1; then
    pids="${pids}
$(lsof -ti tcp:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  if command -v ss >/dev/null 2>&1; then
    pids="${pids}
$(ss -Htnlp "sport = :${PORT}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 || true)"
  fi
  printf '%s\n' "$pids" | tr -s '[:space:]' '\n' | grep -E '^[0-9]+$' | sort -u || true
}

pid_cmdline() {
  local pid="$1"
  if [ -r "/proc/${pid}/cmdline" ]; then
    tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true
  else
    ps -o command= -p "$pid" 2>/dev/null || true
  fi
}

pid_cwd() {
  local pid="$1"
  if [ -e "/proc/${pid}/cwd" ]; then
    readlink "/proc/${pid}/cwd" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1 || true
  fi
}

# A listener is ours when its cwd/cmdline references a 9router install, or its
# cwd is a deleted `.9router-*` dir (the launcher orphan case: readlink then
# yields `/path/.9router-XXXX/app (deleted)`), or a cli.js process is an
# ancestor. Anything else is foreign and is never killed. Deliberately no
# bare-`deleted`/`node` heuristic: that would happily kill a foreign process.
pid_belongs_to_9router() {
  local pid="$1" cline cwd ancestor
  cline="$(pid_cmdline "$pid")"
  case "$cline" in *9router*|*9Router*) return 0 ;; esac
  cwd="$(pid_cwd "$pid")"
  case "$cwd" in *9router*|*9Router*|*".9router-"*) return 0 ;; esac
  [ -r "/proc/${pid}/status" ] || return 1
  ancestor="$pid"
  for _ in 1 2 3 4 5 6; do
    ancestor="$(awk '/^PPid:/ { print $2 }' "/proc/${ancestor}/status" 2>/dev/null || true)"
    case "$ancestor" in ''|0|1) break ;; esac
    cline="$(pid_cmdline "$ancestor")"
    case "$cline" in *cli.js*) return 0 ;; esac
  done
  return 1
}

# Version gate helpers: compare what the live server reports with what landed.
json_version() {
  sed -n 's/.*"currentVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true
}

live_version() {
  # 5s: /api/version also probes the npm registry (4s timeout) before answering.
  curl -fsS --max-time 5 "${SERVER_URL}/api/version" 2>/dev/null | json_version || true
}

# Poll for the served version to match the installed one. Bounded by wall clock,
# not iterations: /api/version itself can take ~4s when the npm registry is
# unreachable. Prints the last version it saw either way.
wait_live_version() {
  local served="" deadline=$((SECONDS + 25))
  while [ "$SECONDS" -lt "$deadline" ]; do
    served="$(live_version)"
    if [ -n "${INSTALLED:-}" ] && [ "$served" = "$INSTALLED" ]; then
      printf '%s' "$served"
      return 0
    fi
    sleep 0.5
  done
  printf '%s' "$served"
  return 1
}

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
  warn "install window left the server stopped - starting it again in the background"
  if [ -n "${ACS_BIN:-}" ] && "$ACS_BIN" service start 9router --force >/dev/null 2>&1; then
    :
  elif [ -n "${CLI_JS:-}" ] && [ -e "${CLI_JS:-}" ]; then
    nohup node "$CLI_JS" --tray --skip-update -p "$PORT" >/dev/null 2>&1 &
  fi
  for _ in $(seq 1 10); do
    sleep 0.5
    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      okay "server healthy again on port ${PORT}"
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
# Leftovers outside acs management (non-acs installs) are killed by pattern,
# then by the actual owner of the listening socket. A listener is only killed
# when it belongs to a 9Router install; a foreign process holding the port is
# reported and left alive.
kill_owned_port_listeners() {
  local pids pid
  pids="$(port_listener_pids)"
  [ -n "$pids" ] || return 0
  for pid in $pids; do
    if pid_belongs_to_9router "$pid"; then
      continue
    fi
    warn "port ${PORT} is held by a process that is not 9Router:"
    warn "  PID ${pid}: $(pid_cmdline "$pid")"
    warn "  cwd: $(pid_cwd "$pid")"
    echo "Refusing to kill PID ${pid} (not a 9Router process). Stop it yourself, or pass --port <free port>." >&2
    exit 1
  done
  for pid in $pids; do
    warn "stopping PID ${pid}"
    kill -9 "$pid" 2>/dev/null || true
  done
}

for _ in 1 2 3 4 5; do
  LEFTOVER="$(pgrep -f 'node_modules/9router' 2>/dev/null || true)"
  if [ -n "$LEFTOVER" ]; then
    pkill -9 -f "node_modules/9router" 2>/dev/null || true
    warn "killed leftover 9router processes"
  fi
  kill_owned_port_listeners
  [ -n "$(port_listener_pids)" ] || break
  sleep 1
done

# Never race a listener: the port must be genuinely free before we start.
STILL_LISTENING="$(port_listener_pids)"
if [ -n "$STILL_LISTENING" ]; then
  for pid in $STILL_LISTENING; do
    warn "still listening on port ${PORT}: PID ${pid} ($(pid_cmdline "$pid"))"
  done
  echo "Port ${PORT} is still in use - refusing to start a second server on it." >&2
  exit 1
fi
okay "nothing is holding port ${PORT} now"
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

# Payload assertion: a package that installs without the prebuilt CLI server
# cannot start, so fail here naming the path instead of timing out on health.
PAYLOAD="${HOME}/.9router/cli/lib/node_modules/9router/app/.next-cli-build/server"
if [ ! -d "$PAYLOAD" ]; then
  echo "Installed package is missing the prebuilt server payload at ${PAYLOAD}" >&2
  exit 1
fi
okay "Prebuilt server payload present"

# 9. Start the server (plain background process, fully silent) ---------------
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
  start_ours() {
    nohup node "$CLI_JS" --tray --skip-update -p "$PORT" >/dev/null 2>&1 &
    SPAWNED_PID=$!
    SPAWNED_PIDS="${SPAWNED_PIDS:-} ${SPAWNED_PID}"
  }
  stop_ours() {
    local pid
    for pid in ${SPAWNED_PIDS:-}; do
      kill -9 "$pid" 2>/dev/null || true
    done
    SPAWNED_PIDS=""
  }
  if ! wait_health && [ "$STARTED_VIA_ACS" -ne 1 ]; then
    warn "Server not healthy yet - starting it in the background (nohup, fully silent)"
    # nohup + & detaches from this shell: survives terminal close, writes no
    # console output, and starts no terminal on macOS/Linux.
    start_ours
  fi
  if ! wait_health; then
    stop_ours
    warn "Server did not report healthy within 15s. Check: nohup node \"${CLI_JS}\" --tray --skip-update -p ${PORT} >/dev/null 2>&1 &"
    exit 1
  fi
  okay "Server is healthy at ${SERVER_URL}"

  # Hard live-version gate: a healthy server can still be the STALE orphan that
  # survived the stop sweep (its launcher was killed, its next-server child was
  # not). Never report success for a server that is not serving what we just
  # installed.
  SERVED=""
  if SERVED="$(wait_live_version)"; then
    okay "Live server reports v${SERVED}"
  else
    warn "Live server reports v${SERVED:-<none>}, not the installed v${INSTALLED}"
    warn "sweeping stale listeners and starting the installed CLI once"
    kill_owned_port_listeners
    sleep 1
    start_ours
    if wait_health && SERVED="$(wait_live_version)"; then
      okay "Live server reports v${SERVED}"
    else
      stop_ours
      echo "Install FAILED: installed v${INSTALLED}, but ${SERVER_URL}/api/version reports v${SERVED:-<none>}." >&2
      echo "The server serving port ${PORT} is not the version this run installed." >&2
      exit 1
    fi
  fi

  INSTALL_DONE=1
  printf '\n  Installed and started v%s\n' "$INSTALLED"
  printf '  Dashboard: %s/dashboard\n  Gateway:   %s/v1\n  Data dir:  %s/.9router (untouched by this install)\n' \
    "$SERVER_URL" "$SERVER_URL" "$HOME"
  printf '  Stop with: pkill -f "node_modules/9router"\n'
fi

echo
echo "Done."
