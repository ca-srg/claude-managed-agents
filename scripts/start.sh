#!/usr/bin/env bash
set -euo pipefail

# Persist runtime state (proper-lockfile, state.json, run-*.json) on the
# mounted Fly volume. STATE_FILE / RUN_LOCK in src/shared/constants.ts are
# resolved against process.cwd() (= /app), so we redirect that subdirectory
# to /data via a symlink instead of editing the constants.
mkdir -p /data/agent-state
if [ ! -L /app/.github-issue-agent ] \
  || [ "$(readlink /app/.github-issue-agent)" != "/data/agent-state" ]; then
  rm -rf /app/.github-issue-agent
  ln -sfn /data/agent-state /app/.github-issue-agent
fi

# --- main app ---------------------------------------------------------------
bun /app/index.ts &
APP_PID=$!
echo "[start.sh] bun server started (pid=$APP_PID)" >&2

# --- mcp-proxy sidecar ------------------------------------------------------
# Exposes the named-server stdio MCP servers in $MCP_PROXY_CONFIG as
# Streamable HTTP / SSE endpoints under /servers/<name>/mcp and
# /servers/<name>/sse respectively. Consumed by Claude Managed Agents as a
# Remote MCP server through the MCP gateway below.
MCP_PROXY_HOST="${MCP_PROXY_HOST:-0.0.0.0}"
MCP_PROXY_PORT="${MCP_PROXY_PORT:-8096}"
MCP_PROXY_CONFIG="${MCP_PROXY_CONFIG:-/etc/mcp-proxy/mcp-proxy.json}"
MCP_PROXY_ALLOW_ORIGIN="${MCP_PROXY_ALLOW_ORIGIN:-*}"

if [ ! -f "$MCP_PROXY_CONFIG" ]; then
  echo "[start.sh] mcp-proxy config not found at $MCP_PROXY_CONFIG" >&2
  exit 1
fi

mcp-proxy \
  --host "$MCP_PROXY_HOST" \
  --port "$MCP_PROXY_PORT" \
  --pass-environment \
  --allow-origin "$MCP_PROXY_ALLOW_ORIGIN" \
  --named-server-config "$MCP_PROXY_CONFIG" &
PROXY_PID=$!
echo "[start.sh] mcp-proxy started (pid=$PROXY_PID, http://$MCP_PROXY_HOST:$MCP_PROXY_PORT)" >&2

# --- MCP gateway sidecar -----------------------------------------------------
# Authenticates Remote MCP requests with Authorization: Bearer and a Claude
# Managed Agents source IP allowlist before proxying them to mcp-proxy.
# Cloudflare Tunnel should route the public MCP hostname to this gateway, not
# directly to mcp-proxy.
MCP_GATEWAY_HOST="${MCP_GATEWAY_HOST:-127.0.0.1}"
MCP_GATEWAY_PORT="${MCP_GATEWAY_PORT:-8097}"
MCP_GATEWAY_UPSTREAM_URL="${MCP_GATEWAY_UPSTREAM_URL:-http://127.0.0.1:${MCP_PROXY_PORT}}"

if [ -z "${MCP_GATEWAY_TOKEN:-}" ]; then
  echo "[start.sh] MCP_GATEWAY_TOKEN is not set; refusing to expose the MCP gateway." >&2
  echo "[start.sh] Set it via: fly secrets set MCP_GATEWAY_TOKEN=<random-token>" >&2
  kill -TERM "$APP_PID" "$PROXY_PID" 2>/dev/null || true
  exit 1
fi

MCP_GATEWAY_HOST="$MCP_GATEWAY_HOST" \
MCP_GATEWAY_PORT="$MCP_GATEWAY_PORT" \
MCP_GATEWAY_UPSTREAM_URL="$MCP_GATEWAY_UPSTREAM_URL" \
bun /app/src/features/mcp-gateway/server.ts &
GATEWAY_PID=$!
echo "[start.sh] MCP gateway started (pid=$GATEWAY_PID, http://$MCP_GATEWAY_HOST:$MCP_GATEWAY_PORT -> $MCP_GATEWAY_UPSTREAM_URL)" >&2

# --- cloudflared sidecar ----------------------------------------------------
# Cloudflare Tunnel is the only public ingress for this deployment.
# fly.toml does not expose any [[services]] / [http_service], so without
# cloudflared the bun app and MCP gateway are unreachable from outside the VM.
# Public-hostname -> internal-port routing (app:3000, mcp-gateway:8097) is
# configured in the Cloudflare Zero Trust dashboard.
if [ -z "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]; then
  echo "[start.sh] CLOUDFLARE_TUNNEL_TOKEN is not set; refusing to start." >&2
  echo "[start.sh] Set it via: fly secrets set CLOUDFLARE_TUNNEL_TOKEN=<token>" >&2
  kill -TERM "$APP_PID" "$PROXY_PID" "$GATEWAY_PID" 2>/dev/null || true
  exit 1
fi

cloudflared tunnel \
  --no-autoupdate \
  --metrics 127.0.0.1:0 \
  run \
  --token "$CLOUDFLARE_TUNNEL_TOKEN" &
TUNNEL_PID=$!
echo "[start.sh] cloudflared started (pid=$TUNNEL_PID)" >&2

shutdown() {
  echo "[start.sh] received signal, shutting down" >&2
  kill -TERM "$APP_PID" 2>/dev/null || true
  kill -TERM "$PROXY_PID" 2>/dev/null || true
  kill -TERM "$GATEWAY_PID" 2>/dev/null || true
  kill -TERM "$TUNNEL_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}

trap shutdown TERM INT

# Wait for whichever process exits first; tear down the others so Fly can
# restart the whole machine cleanly (`[[restart]] policy = 'always'`).
set +e
wait -n "$APP_PID" "$PROXY_PID" "$GATEWAY_PID" "$TUNNEL_PID"
EXIT_CODE=$?
set -e

if ! kill -0 "$APP_PID" 2>/dev/null; then
  echo "[start.sh] bun exited (code=$EXIT_CODE); tearing down sidecars" >&2
elif ! kill -0 "$PROXY_PID" 2>/dev/null; then
  echo "[start.sh] mcp-proxy exited (code=$EXIT_CODE); tearing down bun, MCP gateway, and cloudflared" >&2
elif ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
  echo "[start.sh] MCP gateway exited (code=$EXIT_CODE); tearing down bun, mcp-proxy, and cloudflared" >&2
else
  echo "[start.sh] cloudflared exited (code=$EXIT_CODE); tearing down bun, mcp-proxy, and MCP gateway" >&2
fi

shutdown
exit "$EXIT_CODE"
