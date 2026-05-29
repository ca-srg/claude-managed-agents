# Deploying to Fly.io

This guide walks through hosting `github-issue-agent` on Fly.io with
Cloudflare Tunnel as the only public ingress.

> **App name caveat.** Fly.io blocks any app name containing the substring
> `github` (anti-phishing filter). The bundled `fly.toml` uses
> `claude-managed-agents`. Pick whatever you like, just avoid `github`.

> **Ingress note.** The committed `fly.toml` does **not** define
> `[http_service]` or `[[services]]`. The bun app (`:3000`), the mcp-proxy
> sidecar (`:8096`), and the MCP gateway sidecar (`:8097`) all bind to
> `127.0.0.1` and are reachable from the outside **only** through the
> `cloudflared` sidecar running inside the same Machine. Public-hostname →
> internal-port routing is configured in the Cloudflare Zero Trust
> dashboard. Single-Machine deployment is intentional — splitting the
> processes across Machines would break SSE session affinity for the
> Remote MCP transport.

```
[ User Browser ]                    [ Claude Managed Agents ]
    │  https://app.example.com          │  https://mcp.example.com
    ▼                                   ▼
[ Cloudflare Edge ]  ◀─── outbound tunnel only (no inbound port open)
    │
    ▼
[ Fly Machine (nrt) ]
  ├─ cloudflared tunnel run --token $CLOUDFLARE_TUNNEL_TOKEN
  ├─ bun run index.ts            (Hono SSR + run queue + SSE)   127.0.0.1:3000
  ├─ mcp-gateway (Bearer auth reverse proxy)                    127.0.0.1:8097
  ├─ mcp-proxy --named-server-config /etc/mcp-proxy/...         127.0.0.1:8096
  └─ /data volume → SQLite + agent state
```

The repo ships these supporting files:

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build: deps → Tailwind CSS → runtime (incl. mcp-proxy venv + Node.js for `npx`-based MCP servers + cloudflared deb) |
| `mcp-proxy.json` | `--named-server-config` template, baked into the image at `/etc/mcp-proxy/mcp-proxy.json` |
| `src/features/mcp-gateway/server.ts` | Bearer-auth reverse proxy that fronts `mcp-proxy` so Cloudflare Tunnel does not expose the raw MCP endpoint |
| `scripts/start.sh` | Spawns `bun`, `mcp-proxy`, `mcp-gateway`, and `cloudflared` in parallel, propagates signals, exits when any of them dies |
| `fly.toml` | Single-machine config, `/data` volume, **no public services** (Tunnel-only) |
| `.dockerignore` | Strips local state and tests from build context |

## Prerequisites

- A Fly.io account + `flyctl` installed (`brew install flyctl` / curl install)
- A Cloudflare account with a Zone (a domain) onboarded to Cloudflare
- Anthropic API key and a GitHub App with `Metadata: read`,
  `Contents: write`, `Issues: write`, and `Pull requests: write`

## 1. Create the Fly app

```bash
# from repo root
fly apps create gh-issue-agent --org personal

# 1 GB volume in the same region
fly volumes create data --size 1 --region nrt --app gh-issue-agent
```

If you prefer `fly launch`, be aware that it rewrites `fly.toml` and will
re-inject `[http_service]` / `[[services]]`. Delete those blocks again
before deploying — the deployment relies on Tunnel-only ingress.

## 1.4. Create the Cloudflare Tunnel

This deployment authenticates `cloudflared` via a Tunnel token (no
local `config.yml` or `cert.pem` needed). Routing is configured in the
dashboard, not in the repo.

1. Open <https://one.dash.cloudflare.com/> → **Networks** → **Tunnels**.
2. **Create a tunnel** → choose **Cloudflared** → give it a name
   (e.g. `gh-issue-agent`) → **Save tunnel**.
3. On the connector page, copy the **token** shown next to the
   `cloudflared tunnel run --token <TOKEN>` snippet. You do **not** need
   to install cloudflared anywhere — the token is all this Fly Machine
   needs. Keep it secret; it grants tunnel ingress to your account.
4. Click **Next** to go to the **Public Hostnames** tab and add two
   routes pointing at the in-Machine ports:

   | Subdomain | Domain | Path | Service |
   |---|---|---|---|
   | `app` (or anything you like) | your zone, e.g. `example.com` | _(empty)_ | `HTTP` → `localhost:3000` |
   | `mcp` | your zone | _(empty)_ | `HTTP` → `localhost:8097` |

   The `mcp` hostname points at the **MCP gateway** (`:8097`), not the raw
   `mcp-proxy` (`:8096`). The gateway validates both
   `Authorization: Bearer $MCP_GATEWAY_TOKEN` and the source IP against the
   Claude Managed Agents outbound CIDR before forwarding requests to
   `mcp-proxy`; do **not** route Cloudflare directly to `:8096`.

   The `Service` field must use the **scheme + host + port** form
   (`http://localhost:3000`), with HTTP (not HTTPS) since `cloudflared`
   and the app share the same Machine and TLS is terminated at the
   Cloudflare edge.
5. Save. DNS records (`app.example.com`, `mcp.example.com`) are created
   automatically as proxied CNAMEs pointing at the tunnel.

## 1.5. Configure mcp-proxy (Remote MCP)

The `mcp-proxy` sidecar exposes stdio MCP servers as HTTP/SSE endpoints,
and the **MCP gateway** (`src/features/mcp-gateway/server.ts`) sits in
front of it, validating `Authorization: Bearer $MCP_GATEWAY_TOKEN` plus a
Claude Managed Agents source IP allowlist before forwarding to `mcp-proxy`.
Claude Managed Agents authenticates against the gateway via a Vault
`static_bearer` credential.

The default template at the repo root, `mcp-proxy.json`, is copied to
`/etc/mcp-proxy/mcp-proxy.json` inside the image. To register your own
backends, edit the template and redeploy:

```jsonc
{
  "mcpServers": {
    "<server-name>": {
      "command": "npx",
      "args": ["-y", "<package-name>", "--stdio"]
    }
  }
}
```

> **Never write secrets into `mcp-proxy.json`.** `--pass-environment` is
> enabled, so anything set via `fly secrets set` is visible to spawned
> MCP servers — use the MCP server's own env var (e.g. `FIGMA_API_KEY`)
> instead of inline `args` like `--figma-api-key=...` or inline `env`
> blocks. `${VAR}` expansion is **not** performed on the JSON.

> **Server name → URL path.** The map key becomes a URL segment, so
> stick to URL-safe characters (kebab-case is recommended). Avoid spaces
> — they would force `%20` encoding when registering the URL with
> Claude.

Once deployed, each server is reachable through the Tunnel hostname you
configured in step 1.4. The gateway forwards the path verbatim:

```text
https://mcp.example.com/servers/<server-name>/mcp     # Streamable HTTP
https://mcp.example.com/servers/<server-name>/sse     # SSE (legacy)
```

Register the appropriate URL in the Claude Managed Agents `mcp_servers`
configuration, paired with a Vault `static_bearer` credential whose
`token` matches `MCP_GATEWAY_TOKEN`.

The gateway's source IP allowlist defaults to Anthropic's documented Claude
Managed Agents outbound range, `160.79.104.0/21`. It reads the original client
IP from Cloudflare's `CF-Connecting-IP` single-hop header only; it does not use
`X-Forwarded-For` for authorization because the leftmost value can be client
controlled at the edge. Keep Cloudflare Tunnel as the only public ingress so
that header comes from a trusted proxy. If Anthropic updates the range, set
`MCP_GATEWAY_ALLOWED_CLIENT_CIDRS` to a comma-separated CIDR list and redeploy.

## 2. Set Fly secrets

`CLOUDFLARE_TUNNEL_TOKEN` and `MCP_GATEWAY_TOKEN` are **required** —
`scripts/start.sh` refuses to start without them (the app would otherwise
be unreachable, or the MCP endpoint would be exposed without auth).

Generate a random gateway token (e.g. `openssl rand -hex 32`) and store
it as a secret. Any MCP server-specific secrets (e.g. `FIGMA_API_KEY`)
go here too so `--pass-environment` can forward them to the spawned
stdio MCP servers.

```bash
fly secrets set --app gh-issue-agent \
  ANTHROPIC_API_KEY='sk-ant-...' \
  GITHUB_APP_ID='123456' \
  GITHUB_APP_PRIVATE_KEY="$(cat path/to/private-key.pem)" \
  CLOUDFLARE_TUNNEL_TOKEN='eyJh...' \
  MCP_GATEWAY_TOKEN="$(openssl rand -hex 32)" \
  FIGMA_API_KEY='figd_...'   # if you enabled the figma MCP server
```

Alternatively, mount the PEM at runtime (for example on a Fly volume or another
runtime-only mount) and point the app at that file:

```bash
fly secrets set --app gh-issue-agent \
  GITHUB_APP_ID='123456' \
  GITHUB_APP_PRIVATE_KEY_PATH='/data/secrets/github-app.pem'
```

Do **not** copy the GitHub App private key into the Docker image. Baking the PEM
into an image layer can leave the credential recoverable from the image history
or registry cache. Provide it only at runtime via `GITHUB_APP_PRIVATE_KEY` or a
runtime-mounted `GITHUB_APP_PRIVATE_KEY_PATH`.

`GITHUB_APP_INSTALLATION_ID` is optional. When omitted, the app installation is
resolved from each `owner/repo` at run time.

### Caveat: Vault credential sharing in GitHub App mode

Anthropic Vault allows only one active credential for a given MCP server URL in
each vault. In GitHub App mode, the builtin GitHub MCP credential is backed by a
repository-scoped installation token. If multiple repositories run concurrently
against the same configured vault, later runs or repo-chat sessions can rotate
the shared GitHub MCP credential token and overwrite the token being used by an
earlier run.

Recommended deployment: do not set `VAULT_ID` or `config.vaultId`. The app will
create a managed vault per run/chat turn, isolating GitHub App installation
tokens across repositories. If a configured vault is mandatory, limit
`polled_repositories` and repo-chat usage to one repository per vault, or avoid
concurrent runs across repositories.

## 3. Deploy

```bash
fly deploy --app gh-issue-agent
```

Watch the logs for:

- `[start.sh] bun server started`
- `[start.sh] mcp-proxy started`
- `[start.sh] MCP gateway started`
- `[start.sh] cloudflared started` followed by a
  `Registered tunnel connection` line from cloudflared itself

```bash
fly logs --app gh-issue-agent
```

Then hit `https://app.example.com/` from a browser — it should render
the dashboard.

## 4. Day-to-day operations

```bash
# Tail logs
fly logs --app gh-issue-agent

# SSH into the running machine
fly ssh console --app gh-issue-agent

# Check disk usage (volume is mounted at /data)
fly ssh console --app gh-issue-agent -C 'df -h /data'

# Backup the SQLite db locally
fly ssh sftp get /data/dashboard.db ./dashboard.db.bak --app gh-issue-agent

# Re-deploy after code changes
fly deploy --app gh-issue-agent
```

## Troubleshooting

- **`CLOUDFLARE_TUNNEL_TOKEN is not set; refusing to start.` in logs**
  → The required secret is missing. `fly secrets set CLOUDFLARE_TUNNEL_TOKEN=...`
    and re-deploy. The Machine intentionally exits because it has no
    other way to receive public traffic.

- **Cloudflare hostname returns `Error 1033` / `1016`**
  → The tunnel has no healthy connector. Tail `fly logs --app gh-issue-agent`
    and look for cloudflared output. Common causes: invalid token (revoke
    and re-issue from the dashboard), Machine stopped (`fly machine list`),
    or the public hostname `Service` points at the wrong port.

- **Cloudflare hostname returns `502 Bad Gateway`**
  → The tunnel connected, but the target port isn't responding. Inside
    the Machine: `fly ssh console --app gh-issue-agent -C 'curl -sf http://127.0.0.1:3000/ -o /dev/null && echo OK'`.
    If bun is down, check `pgrep -fa bun` and `fly logs` for crash traces.

- **App is reachable on `<app>.fly.dev` after deploy**
  → That should be impossible with the shipped `fly.toml` (no
    `[http_service]` / `[[services]]`). Inspect with
    `fly status --app gh-issue-agent` — if any services are listed,
    `fly launch` or a stale config injected them. Re-apply the bundled
    `fly.toml` and `fly deploy` again.

- **Run lock complaint after a crash**
  → `fly ssh console --app gh-issue-agent -C 'rm /data/agent-state/run.lock.lock'`.

- **`HOST` should be `127.0.0.1`**
  → With Tunnel-only ingress the app intentionally binds to `127.0.0.1`
    so it isn't reachable from the Fly private network either. If you
    re-introduce `[http_service]` you must also flip `HOST` back to
    `0.0.0.0` or Fly's proxy will get connection-refused.

- **mcp-proxy returns `404` on `/servers/<name>/mcp`**
  → The server name doesn't match a key in `mcp-proxy.json`. URL-encode
    spaces (`%20`). Verify the running config inside the machine:
    `fly ssh console --app gh-issue-agent -C 'cat /etc/mcp-proxy/mcp-proxy.json'`.

- **mcp-proxy fails to spawn an `npx`-based server**
  → Check logs with `fly logs --app gh-issue-agent | grep mcp-proxy`.
    The first invocation downloads the package into `/home/bun/.npm`,
    which can take 10–30s; subsequent calls are cached.

- **Any of bun / mcp-proxy / cloudflared keeps restarting**
  → `start.sh` tears down the surviving processes when any of them
    dies, so a crash loop in one (e.g. an mcp-proxy config error, or
    cloudflared's token being rotated) will visibly restart the
    whole Machine. Tail `fly logs` and grep for the
    `[start.sh] ... exited` marker to see which one exits first.

## Cost notes

- `shared-cpu-1x` 1 GB machine in `nrt` is roughly **$5 / month** if running
  24/7. The Fly free allowance covers up to 3 such VMs.
- `data` volume: $0.15 / GB-month.
- Anthropic billing dwarfs hosting cost (~$0.08 per session-hour at the time
  of writing). See `README.md`.
