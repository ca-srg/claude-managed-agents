# syntax=docker/dockerfile:1.7

# github-issue-agent runtime image.
#
# Layout:
#   /app           - application code (read-only at runtime)
#   /data          - mounted Fly volume; SQLite + agent state live here
#   /app/.github-issue-agent -> /data/agent-state (symlink, set by start.sh)

ARG BUN_IMAGE=oven/bun:1.3-debian

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock bunfig.toml tsconfig.json tailwind.config.ts ./
COPY src ./src
RUN bun run build:css

FROM ${BUN_IMAGE} AS runtime

# tini: proper PID 1 / signal forwarding.
# bash: scripts/start.sh uses `set -o pipefail`, which dash does not support.
# python3 / python3-venv: required for the mcp-proxy sidecar (PyPI install).
# nodejs / npm: stdio MCP servers in mcp-proxy.json are spawned via `npx`.
#   GHCR has only alpine images of sparfenyuk/mcp-proxy and they are not ABI
#   compatible with this Debian/glibc runtime, so we install mcp-proxy from
#   PyPI directly into an isolated venv at /opt/mcp-proxy.
ARG MCP_PROXY_VERSION=0.11.0
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    tini ca-certificates bash \
    python3 python3-venv \
    nodejs npm \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/mcp-proxy \
  && /opt/mcp-proxy/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/mcp-proxy/bin/pip install --no-cache-dir "mcp-proxy==${MCP_PROXY_VERSION}"

# cloudflared: Cloudflare Tunnel sidecar. The app and MCP gateway are exposed
# only through the tunnel; Fly.io does not publish either port directly
# (see fly.toml — no [http_service] / [[services]] blocks).
# Routing from public hostname -> internal port is configured in the
# Cloudflare Zero Trust dashboard (Tunnels -> Public Hostnames). Authenticate
# the daemon by setting CLOUDFLARE_TUNNEL_TOKEN via `fly secrets set`.
ARG CLOUDFLARED_VERSION=2026.5.0
ADD https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64.deb /tmp/cloudflared.deb
RUN dpkg -i /tmp/cloudflared.deb \
  && rm /tmp/cloudflared.deb

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY index.ts ./index.ts
COPY src ./src
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY scripts ./scripts
COPY --from=build /app/dist ./dist

# mcp-proxy named-server config template. Override at runtime via the
# MCP_PROXY_CONFIG env var or by rebuilding with a customised template.
COPY mcp-proxy.json /etc/mcp-proxy/mcp-proxy.json

RUN mkdir -p /data /home/bun/.npm \
  && chown -R bun:bun /data /app /home/bun \
  && chmod 0644 /etc/mcp-proxy/mcp-proxy.json \
  && chmod +x ./scripts/start.sh

USER bun

# Defaults; override in fly.toml or via `fly secrets set` as needed.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/dashboard.db \
    LOG_LEVEL=info \
    NODE_ENV=production \
    PATH="/opt/mcp-proxy/bin:${PATH}" \
    MCP_PROXY_HOST=0.0.0.0 \
    MCP_PROXY_PORT=8096 \
    MCP_PROXY_CONFIG=/etc/mcp-proxy/mcp-proxy.json \
    MCP_PROXY_ALLOW_ORIGIN=* \
    MCP_GATEWAY_HOST=127.0.0.1 \
    MCP_GATEWAY_PORT=8097 \
    MCP_GATEWAY_UPSTREAM_URL=http://127.0.0.1:8096

EXPOSE 3000 8096 8097

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./scripts/start.sh"]
