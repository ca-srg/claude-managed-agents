#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-bun}"
APP_UID="$(id -u "$APP_USER")"
APP_GID="$(id -g "$APP_USER")"
APP_HOME="${APP_HOME:-$(getent passwd "$APP_USER" 2>/dev/null | cut -d: -f6 || true)}"
APP_HOME="${APP_HOME:-/home/$APP_USER}"
DATA_DIR="${DATA_DIR:-/data}"
APP_DATA_DIR="${APP_DATA_DIR:-$DATA_DIR/app}"
AGENT_STATE_DIR="${AGENT_STATE_DIR:-$APP_DATA_DIR/agent-state}"
WARP_DATA_DIR="${WARP_DATA_DIR:-$DATA_DIR/cloudflare-warp}"
export DB_PATH="${DB_PATH:-$APP_DATA_DIR/dashboard.db}"

APP_PID=""
PROXY_PID=""
GATEWAY_PID=""
TUNNEL_PID=""
WARP_PID=""
STARTED_PID=""

kill_pid() {
  local pid="${1:-}"

  if [ -n "$pid" ]; then
    kill -TERM "$pid" 2>/dev/null || true
  fi
}

shutdown() {
  echo "[start.sh] received signal, shutting down" >&2
  kill_pid "$APP_PID"
  kill_pid "$PROXY_PID"
  kill_pid "$GATEWAY_PID"
  kill_pid "$TUNNEL_PID"
  kill_pid "$WARP_PID"
  wait 2>/dev/null || true
}

trap shutdown TERM INT

start_as_app_user() {
  if [ "$(id -u)" -eq "$APP_UID" ]; then
    HOME="$APP_HOME" "$@" &
  elif command -v setpriv >/dev/null 2>&1; then
    setpriv --reuid "$APP_UID" --regid "$APP_GID" --init-groups \
      env HOME="$APP_HOME" "$@" &
  else
    local quoted_command
    printf -v quoted_command "%q " "$@"
    su -s /bin/bash "$APP_USER" -c "export HOME=$(printf "%q" "$APP_HOME"); exec $quoted_command" &
  fi
  STARTED_PID=$!
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  value="${value//\"/&quot;}"
  value="${value//\'/&apos;}"
  printf "%s" "$value"
}

refuse_symlink() {
  local path="$1"

  if [ -L "$path" ]; then
    echo "[start.sh] refusing to use symlinked path: $path" >&2
    exit 1
  fi
}

path_any_exists() {
  local path

  for path in "$@"; do
    if [ -e "$path" ] || [ -L "$path" ]; then
      return 0
    fi
  done

  return 1
}

abort_if_symlinked_paths() {
  local path

  for path in "$@"; do
    refuse_symlink "$path"
  done
}

migrate_legacy_dashboard_db() {
  local legacy_paths=(
    "$DATA_DIR/dashboard.db"
    "$DATA_DIR/dashboard.db-wal"
    "$DATA_DIR/dashboard.db-shm"
  )
  local destination_paths=(
    "$APP_DATA_DIR/dashboard.db"
    "$APP_DATA_DIR/dashboard.db-wal"
    "$APP_DATA_DIR/dashboard.db-shm"
  )
  local suffix

  abort_if_symlinked_paths "${legacy_paths[@]}" "${destination_paths[@]}"

  if path_any_exists "${legacy_paths[@]}" && path_any_exists "${destination_paths[@]}"; then
    echo "[start.sh] both legacy and new dashboard DB files exist; refusing automatic migration." >&2
    echo "[start.sh] Move either $DATA_DIR/dashboard.db* or $APP_DATA_DIR/dashboard.db* aside and restart." >&2
    exit 1
  fi

  if path_any_exists "${legacy_paths[@]}" && [ ! -e "$DATA_DIR/dashboard.db" ]; then
    echo "[start.sh] legacy dashboard WAL/SHM exists without $DATA_DIR/dashboard.db; refusing migration." >&2
    exit 1
  fi

  if path_any_exists "${destination_paths[@]}" && [ ! -e "$APP_DATA_DIR/dashboard.db" ]; then
    echo "[start.sh] dashboard WAL/SHM exists without $APP_DATA_DIR/dashboard.db; refusing startup." >&2
    exit 1
  fi

  if path_any_exists "${legacy_paths[@]}"; then
    for suffix in "" "-wal" "-shm"; do
      if [ -e "$DATA_DIR/dashboard.db$suffix" ]; then
        mv "$DATA_DIR/dashboard.db$suffix" "$APP_DATA_DIR/dashboard.db$suffix"
        echo "[start.sh] migrated dashboard.db$suffix to $APP_DATA_DIR" >&2
      fi
    done
  fi
}

configure_agent_state() {
  refuse_symlink "$DATA_DIR"
  mkdir -p "$DATA_DIR"
  chown root:root "$DATA_DIR"
  chmod 0755 "$DATA_DIR"

  refuse_symlink "$APP_DATA_DIR"
  mkdir -p "$APP_DATA_DIR"

  refuse_symlink "$DATA_DIR/agent-state"
  refuse_symlink "$AGENT_STATE_DIR"
  if [ -e "$DATA_DIR/agent-state" ] && [ -e "$AGENT_STATE_DIR" ]; then
    echo "[start.sh] both legacy and new agent state directories exist; refusing automatic migration." >&2
    echo "[start.sh] Move either $DATA_DIR/agent-state or $AGENT_STATE_DIR aside and restart." >&2
    exit 1
  fi
  if [ -e "$DATA_DIR/agent-state" ] && [ ! -d "$DATA_DIR/agent-state" ]; then
    echo "[start.sh] $DATA_DIR/agent-state exists but is not a directory; refusing migration." >&2
    exit 1
  fi
  if [ -d "$DATA_DIR/agent-state" ]; then
    mv "$DATA_DIR/agent-state" "$AGENT_STATE_DIR"
    echo "[start.sh] migrated agent state to $AGENT_STATE_DIR" >&2
  fi

  if [ "$DB_PATH" = "$APP_DATA_DIR/dashboard.db" ]; then
    migrate_legacy_dashboard_db
  fi

  mkdir -p "$AGENT_STATE_DIR"
  chown "$APP_USER:$APP_USER" "$APP_DATA_DIR" "$AGENT_STATE_DIR" 2>/dev/null || true
  chmod 0750 "$APP_DATA_DIR" "$AGENT_STATE_DIR"

  for dashboard_file in "$APP_DATA_DIR"/dashboard.db*; do
    [ -e "$dashboard_file" ] || continue
    chown -h "$APP_USER:$APP_USER" "$dashboard_file" 2>/dev/null || true
  done

  # Persist runtime state (proper-lockfile, state.json, run-*.json) on the
  # mounted Fly volume. STATE_FILE / RUN_LOCK in src/shared/constants.ts are
  # resolved against process.cwd() (= /app), so we redirect that subdirectory
  # to the app data directory via a symlink instead of editing the constants.
  if [ ! -L /app/.maestro ] \
    || [ "$(readlink /app/.maestro)" != "$AGENT_STATE_DIR" ]; then
    rm -rf /app/.maestro
    ln -sfn "$AGENT_STATE_DIR" /app/.maestro
  fi
}

warp_env_is_set() {
  [ -n "${CF_WARP_ORGANIZATION:-}" ] \
    || [ -n "${CF_WARP_ACCESS_CLIENT_ID:-}" ] \
    || [ -n "${CF_WARP_ACCESS_CLIENT_SECRET:-}" ] \
    || [ -n "${CF_ACCESS_CLIENT_ID:-}" ] \
    || [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]
}

warp_access_client_id() {
  printf "%s" "${CF_WARP_ACCESS_CLIENT_ID:-${CF_ACCESS_CLIENT_ID:-}}"
}

warp_access_client_secret() {
  printf "%s" "${CF_WARP_ACCESS_CLIENT_SECRET:-${CF_ACCESS_CLIENT_SECRET:-}}"
}

require_complete_warp_env() {
  local missing=()
  local access_client_id
  local access_client_secret

  access_client_id="$(warp_access_client_id)"
  access_client_secret="$(warp_access_client_secret)"

  [ -n "${CF_WARP_ORGANIZATION:-}" ] || missing+=("CF_WARP_ORGANIZATION")
  [ -n "$access_client_id" ] || missing+=("CF_WARP_ACCESS_CLIENT_ID or CF_ACCESS_CLIENT_ID")
  [ -n "$access_client_secret" ] || missing+=("CF_WARP_ACCESS_CLIENT_SECRET or CF_ACCESS_CLIENT_SECRET")

  if [ "${#missing[@]}" -gt 0 ]; then
    echo "[start.sh] Cloudflare WARP is partially configured; missing: ${missing[*]}" >&2
    echo "[start.sh] Set all of them with fly secrets set, or unset all to skip WARP." >&2
    exit 1
  fi
}

unset_warp_env() {
  if [ -z "${CF_WARP_ACCESS_CLIENT_ID:-}" ]; then
    unset CF_ACCESS_CLIENT_ID
  fi
  if [ -z "${CF_WARP_ACCESS_CLIENT_SECRET:-}" ]; then
    unset CF_ACCESS_CLIENT_SECRET
  fi

  unset CF_WARP_ORGANIZATION
  unset CF_WARP_ACCESS_CLIENT_ID
  unset CF_WARP_ACCESS_CLIENT_SECRET
  unset CF_WARP_SERVICE_MODE
  unset CF_WARP_CONNECT_TIMEOUT_SECONDS
}

ensure_tun_device() {
  if [ -c /dev/net/tun ]; then
    chmod 0600 /dev/net/tun
    return
  fi

  mkdir -p /dev/net
  if ! mknod /dev/net/tun c 10 200 2>/dev/null; then
    echo "[start.sh] /dev/net/tun is missing and could not be created; WARP cannot start." >&2
    exit 1
  fi
  chmod 0600 /dev/net/tun
}

write_warp_mdm_xml() {
  local service_mode="${CF_WARP_SERVICE_MODE:-warp}"
  local tmp_file
  local old_umask
  local access_client_id
  local access_client_secret

  access_client_id="$(warp_access_client_id)"
  access_client_secret="$(warp_access_client_secret)"

  refuse_symlink /var/lib/cloudflare-warp/mdm.xml
  old_umask="$(umask)"
  umask 077
  tmp_file="$(mktemp /var/lib/cloudflare-warp/mdm.xml.XXXXXX)"
  cat >"$tmp_file" <<EOF
<dict>
  <key>auth_client_id</key>
  <string>$(xml_escape "$access_client_id")</string>
  <key>auth_client_secret</key>
  <string>$(xml_escape "$access_client_secret")</string>
  <key>auto_connect</key>
  <integer>1</integer>
  <key>onboarding</key>
  <false/>
  <key>organization</key>
  <string>$(xml_escape "$CF_WARP_ORGANIZATION")</string>
  <key>service_mode</key>
  <string>$(xml_escape "$service_mode")</string>
</dict>
EOF
  umask "$old_umask"

  chown root:root "$tmp_file"
  chmod 0600 "$tmp_file"
  mv -f "$tmp_file" /var/lib/cloudflare-warp/mdm.xml
}

wait_for_warp() {
  local timeout="${CF_WARP_CONNECT_TIMEOUT_SECONDS:-90}"
  local deadline
  local status_output=""

  if ! [[ "$timeout" =~ ^[1-9][0-9]*$ ]]; then
    echo "[start.sh] CF_WARP_CONNECT_TIMEOUT_SECONDS must be a positive integer." >&2
    return 1
  fi

  deadline=$((SECONDS + timeout))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! kill -0 "$WARP_PID" 2>/dev/null; then
      echo "[start.sh] warp-svc exited before reaching Connected." >&2
      return 1
    fi

    status_output="$(warp-cli status 2>&1 || true)"
    if printf "%s\n" "$status_output" | grep -Eqi '(^|[^[:alpha:]])Connected([^[:alpha:]]|$)'; then
      echo "[start.sh] Cloudflare WARP connected" >&2
      return 0
    fi

    if printf "%s\n" "$status_output" | grep -Eqi '(^|[^[:alpha:]])Disconnected([^[:alpha:]]|$)'; then
      warp-cli connect >/dev/null 2>&1 || true
    fi

    sleep 2
  done

  echo "[start.sh] timed out waiting for Cloudflare WARP to connect after ${timeout}s" >&2
  if [ -n "$status_output" ]; then
    printf "[start.sh] last warp-cli status: %s\n" "$status_output" >&2
  fi
  return 1
}

start_warp_if_configured() {
  if ! warp_env_is_set; then
    echo "[start.sh] Cloudflare WARP mdm.xml is not configured; skipping Zero Trust device enrollment" >&2
    return
  fi

  require_complete_warp_env

  if [ "$(id -u)" -ne 0 ]; then
    echo "[start.sh] Cloudflare WARP requires root privileges; run the image as root." >&2
    exit 1
  fi

  if ! command -v warp-svc >/dev/null 2>&1 || ! command -v warp-cli >/dev/null 2>&1; then
    echo "[start.sh] cloudflare-warp is not installed in the image." >&2
    exit 1
  fi

  refuse_symlink "$WARP_DATA_DIR"
  install -d -o root -g root -m 0700 "$WARP_DATA_DIR"
  install -d -o root -g root -m 0755 /run/cloudflare-warp

  if [ ! -L /var/lib/cloudflare-warp ] \
    || [ "$(readlink /var/lib/cloudflare-warp)" != "$WARP_DATA_DIR" ]; then
    rm -rf /var/lib/cloudflare-warp
    ln -sfn "$WARP_DATA_DIR" /var/lib/cloudflare-warp
  fi

  ensure_tun_device
  write_warp_mdm_xml

  env \
    -u CF_WARP_ORGANIZATION \
    -u CF_WARP_ACCESS_CLIENT_ID \
    -u CF_WARP_ACCESS_CLIENT_SECRET \
    -u CF_ACCESS_CLIENT_ID \
    -u CF_ACCESS_CLIENT_SECRET \
    -u CF_WARP_SERVICE_MODE \
    -u CF_WARP_CONNECT_TIMEOUT_SECONDS \
    warp-svc &
  WARP_PID=$!
  echo "[start.sh] warp-svc started (pid=$WARP_PID)" >&2

  if ! wait_for_warp; then
    unset_warp_env
    kill_pid "$WARP_PID"
    wait "$WARP_PID" 2>/dev/null || true
    exit 1
  fi

  # mcp-proxy runs with --pass-environment so MCP subprocesses can receive
  # their own secrets. Do not propagate the WARP enrollment token to those
  # subprocesses after mdm.xml has been written and warp-svc is connected.
  unset_warp_env
}

# Persist runtime state (proper-lockfile, state.json, run-*.json) on the
# mounted Fly volume. STATE_FILE / RUN_LOCK in src/shared/constants.ts are
# resolved against process.cwd() (= /app), so we redirect that subdirectory
# to the app data directory via a symlink instead of editing the constants.
configure_agent_state

# --- Cloudflare WARP Zero Trust device enrollment ---------------------------
# When CF_WARP_ORGANIZATION plus CF_WARP_ACCESS_CLIENT_* (or legacy
# CF_ACCESS_CLIENT_* fallback names) are provided, generate mdm.xml from runtime
# secrets and start warp-svc before the app. The WARP registration state is
# persisted under $WARP_DATA_DIR so restarts do not create duplicate devices.
start_warp_if_configured

# --- main app ---------------------------------------------------------------
start_as_app_user bun /app/index.ts
APP_PID=$STARTED_PID
echo "[start.sh] bun server started (pid=$APP_PID)" >&2

# --- mcp-proxy sidecar ------------------------------------------------------
# Exposes the named-server stdio MCP servers in $MCP_PROXY_CONFIG as
# Streamable HTTP / SSE endpoints under /servers/<name>/mcp and
# /servers/<name>/sse respectively. Consumed by Claude Managed Agents as a
# Remote MCP server through the MCP gateway below.
MCP_PROXY_HOST="${MCP_PROXY_HOST:-0.0.0.0}"
MCP_PROXY_PORT="${MCP_PROXY_PORT:-8096}"
MCP_PROXY_CONFIG="${MCP_PROXY_CONFIG:-$DATA_DIR/mcp-proxy.json}"
MCP_PROXY_CONFIG_TEMPLATE="${MCP_PROXY_CONFIG_TEMPLATE:-/etc/mcp-proxy/mcp-proxy.json}"
MCP_PROXY_ALLOW_ORIGIN="${MCP_PROXY_ALLOW_ORIGIN:-*}"

# The image rootfs is ephemeral: anything outside the /data volume resets to
# the baked-in image on every machine restart. Keep the runtime mcp-proxy
# config on /data so SFTP-uploaded changes (see Makefile) survive restarts,
# and seed it from the baked-in template the first time the volume is empty.
refuse_symlink "$MCP_PROXY_CONFIG"
if [ ! -f "$MCP_PROXY_CONFIG" ]; then
  if [ ! -f "$MCP_PROXY_CONFIG_TEMPLATE" ]; then
    echo "[start.sh] mcp-proxy config missing at $MCP_PROXY_CONFIG and no template at $MCP_PROXY_CONFIG_TEMPLATE" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$MCP_PROXY_CONFIG")"
  cp "$MCP_PROXY_CONFIG_TEMPLATE" "$MCP_PROXY_CONFIG"
  echo "[start.sh] seeded $MCP_PROXY_CONFIG from $MCP_PROXY_CONFIG_TEMPLATE" >&2
fi
chown root:root "$MCP_PROXY_CONFIG" 2>/dev/null || true
chmod 0644 "$MCP_PROXY_CONFIG" 2>/dev/null || true

start_as_app_user /opt/mcp-proxy/bin/mcp-proxy \
  --host "$MCP_PROXY_HOST" \
  --port "$MCP_PROXY_PORT" \
  --pass-environment \
  --allow-origin "$MCP_PROXY_ALLOW_ORIGIN" \
  --named-server-config "$MCP_PROXY_CONFIG"
PROXY_PID=$STARTED_PID
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
  shutdown
  exit 1
fi

start_as_app_user env \
  MCP_GATEWAY_HOST="$MCP_GATEWAY_HOST" \
  MCP_GATEWAY_PORT="$MCP_GATEWAY_PORT" \
  MCP_GATEWAY_UPSTREAM_URL="$MCP_GATEWAY_UPSTREAM_URL" \
  bun /app/src/features/mcp-gateway/server.ts
GATEWAY_PID=$STARTED_PID
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
  shutdown
  exit 1
fi

start_as_app_user cloudflared tunnel \
  --no-autoupdate \
  --metrics 127.0.0.1:0 \
  run \
  --token "$CLOUDFLARE_TUNNEL_TOKEN"
TUNNEL_PID=$STARTED_PID
echo "[start.sh] cloudflared started (pid=$TUNNEL_PID)" >&2

# Wait for whichever process exits first; tear down the others so Fly can
# restart the whole machine cleanly (`[[restart]] policy = 'always'`).
PIDS=("$APP_PID" "$PROXY_PID" "$GATEWAY_PID" "$TUNNEL_PID")
if [ -n "$WARP_PID" ]; then
  PIDS+=("$WARP_PID")
fi

set +e
wait -n "${PIDS[@]}"
EXIT_CODE=$?
set -e

if [ -n "$WARP_PID" ] && ! kill -0 "$WARP_PID" 2>/dev/null; then
  echo "[start.sh] warp-svc exited (code=$EXIT_CODE); tearing down bun, mcp-proxy, MCP gateway, and cloudflared" >&2
elif ! kill -0 "$APP_PID" 2>/dev/null; then
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
