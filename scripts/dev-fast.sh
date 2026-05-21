#!/usr/bin/env bash
# dev-fast.sh — fastest possible iteration loop.
#
# Skips the Tauri + CEF bundle (which takes 3–10 minutes per cycle) and
# instead runs:
#   1. openhuman-core (Rust HTTP/JSON-RPC server) standalone in the background
#   2. Vite dev server in the foreground — HMR on every save, <1s reload
#
# The frontend reaches the standalone core via the existing browser-mode
# `fetch` fallback in `coreRpcClient.ts`. The token written by the core to
# `$OPENHUMAN_WORKSPACE/core.token` is exported as `VITE_OPENHUMAN_CORE_TOKEN`
# so the bridge doesn't need an interactive paste on every reload.
#
# Open the app at http://localhost:5173 in any browser. Mic permission is
# granted by the browser the first time you use voice mode.
#
# What you LOSE compared to `pnpm dev:app`:
#   - The CEF webview providers (Telegram/Slack/etc. embedded login flows)
#   - Native dictation hotkey
#   - Native macOS mascot panel
#   - Native notifications
# Use `pnpm dev:app` for those flows; this script covers everything else.
#
# Usage:
#   pnpm dev:fast          # default — workspace in ~/.openhuman-dev-fast
#   OPENHUMAN_WORKSPACE=~/.openhuman pnpm dev:fast   # use desktop workspace
#
# Ctrl-C stops both processes cleanly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── Locate cargo ─────────────────────────────────────────────────────────────
# pnpm-spawned subshells don't inherit interactive PATH on macOS, so rustup's
# `~/.cargo/bin` is typically missing. Source `cargo env` if available, then
# fall back to a direct PATH prepend so the build below can find cargo.
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -f "$HOME/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  fi
fi
if ! command -v cargo >/dev/null 2>&1; then
  if [[ -x "$HOME/.cargo/bin/cargo" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "[dev-fast] ERROR: cargo not on PATH. Install rust via https://rustup.rs and re-run." >&2
  exit 1
fi

# ── Configuration ────────────────────────────────────────────────────────────
# Dedicated workspace so the desktop app's `~/.openhuman` config is not
# disturbed and quick experiments don't pollute long-running state. Override
# by exporting OPENHUMAN_WORKSPACE before running.
export OPENHUMAN_WORKSPACE="${OPENHUMAN_WORKSPACE:-$HOME/.openhuman-dev-fast}"
export OPENHUMAN_CORE_PORT="${OPENHUMAN_CORE_PORT:-7788}"

CORE_BIN="$ROOT_DIR/target/debug/openhuman-core"
# The standalone core always writes its bearer token to
# `~/.openhuman/core.token` (via `default_root_openhuman_dir()` in
# `src/openhuman/config/schema/load.rs`), independent of
# `OPENHUMAN_WORKSPACE`. The workspace dir controls config + data
# storage; the token lives at the shared default.
TOKEN_FILE="$HOME/.openhuman/core.token"
CORE_LOG="$ROOT_DIR/target/dev-fast-core.log"
PID_FILE="$ROOT_DIR/target/dev-fast-core.pid"

mkdir -p "$OPENHUMAN_WORKSPACE"
mkdir -p "$(dirname "$CORE_LOG")"

# ── Load .env so provider keys (Anthropic, OpenRouter, ElevenLabs, …) reach
#    the core ────────────────────────────────────────────────────────────────
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source <(grep -E '^[A-Z_][A-Z0-9_]*=' "$ROOT_DIR/.env" | sed 's/^/export /')
  set +a
fi

# ── Cleanup handler ──────────────────────────────────────────────────────────
cleanup() {
  echo
  echo "[dev-fast] shutting down…"
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 0.5
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  exit 0
}
trap cleanup INT TERM EXIT

# ── 1. Build openhuman-core (incremental — fast after first run) ─────────────
echo "[dev-fast] building openhuman-core (incremental, normally <30s)…"
cargo build --manifest-path "$ROOT_DIR/Cargo.toml" --bin openhuman-core
[[ -x "$CORE_BIN" ]] || {
  echo "[dev-fast] ERROR: $CORE_BIN not found after build" >&2
  exit 1
}

# ── 2. Start core in background ──────────────────────────────────────────────
# `serve` opens the HTTP/JSON-RPC server on $OPENHUMAN_CORE_PORT and writes
# the bearer token to $OPENHUMAN_WORKSPACE/core.token.
echo "[dev-fast] starting standalone core on http://127.0.0.1:$OPENHUMAN_CORE_PORT"
echo "[dev-fast] workspace: $OPENHUMAN_WORKSPACE"
echo "[dev-fast] log:       $CORE_LOG"
"$CORE_BIN" serve > "$CORE_LOG" 2>&1 &
CORE_PID=$!
echo "$CORE_PID" > "$PID_FILE"

# ── 3. Wait for the HTTP server to accept connections ────────────────────────
# Don't gate on the token file's existence — the desktop app may also
# touch `~/.openhuman/core.token`, and deleting it would break a running
# desktop session. Instead probe the port: once `curl` succeeds (even with
# 401), the standalone core has booted, opened the listener, and rewritten
# the token file in `init_rpc_token`. The freshest token in that file is
# guaranteed to be ours.
echo -n "[dev-fast] waiting for core to be ready"
for _ in {1..60}; do
  # `curl --fail` returns 0 only on 2xx, which is what core.ping gives
  # us when unauthenticated discovery succeeds. Some endpoints will 401
  # without a token; either way the TCP listener is alive when curl can
  # complete the request, so we accept any non-network exit code.
  if curl -fsS --max-time 1 "http://127.0.0.1:$OPENHUMAN_CORE_PORT/rpc" \
       -H 'Content-Type: application/json' \
       --data '{"jsonrpc":"2.0","id":1,"method":"core.ping","params":{}}' \
       >/dev/null 2>&1; then
    echo " ✓"
    break
  fi
  if ! kill -0 "$CORE_PID" 2>/dev/null; then
    echo
    echo "[dev-fast] ERROR: core exited during startup. Tail of log:" >&2
    tail -40 "$CORE_LOG" >&2
    exit 1
  fi
  echo -n "."
  sleep 0.5
done

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo
  echo "[dev-fast] ERROR: core listener is up but $TOKEN_FILE missing" >&2
  echo "[dev-fast] expected the standalone core to write a token here." >&2
  tail -40 "$CORE_LOG" >&2
  exit 1
fi

TOKEN="$(cat "$TOKEN_FILE")"
echo "[dev-fast] core token captured (${#TOKEN} chars)"

# ── 4. Start Vite ────────────────────────────────────────────────────────────
echo
echo "================================================================"
echo "  Open in your browser:  http://localhost:5173/#/human"
echo "  Core log:              $CORE_LOG  (tail -f to watch)"
echo "  Ctrl-C here stops both Vite and the core."
echo "================================================================"
echo

export VITE_OPENHUMAN_CORE_RPC_URL="http://127.0.0.1:$OPENHUMAN_CORE_PORT/rpc"
export VITE_OPENHUMAN_CORE_TOKEN="$TOKEN"

cd "$ROOT_DIR/app"
exec pnpm dev
