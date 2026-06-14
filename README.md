# maestro

**English** | [日本語](README_ja.md)

An HTTP server agent that automatically decomposes GitHub issues and ships implementation PRs.
The WebUI lets you trigger the equivalent of `--issue 21925 --repo CyberAgentSRG/server` from your browser.

![maestro — Decompose GitHub issues. Ship pull requests. Autonomously.](docs/ogp.jpeg)

## Overview

`maestro` accepts a GitHub issue as a parent task, automatically breaks it down into multiple child issues (sub-tasks), implements each of them, and finally consolidates the work into a single pull request.

It is built on top of the Anthropic Managed Agents API (`@anthropic-ai/sdk`); the agents operate on your GitHub repository directly to drive each task to completion.

## Architecture

`maestro` runs as a Bun + Hono service with SQLite as its local source of truth. A run can be started from the WebUI/API or by the GitHub trigger poller, then a serial run queue executes the orchestration. Each execution resolves a repo-scoped GitHub App token, prepares the Anthropic cloud environment, vault-backed MCP credentials, and versioned parent/child agents, then creates a Managed Agents session. The parent coordinator delegates implementation work to the child implementer through Managed Agents multi-agent threads; app-side custom tools create sub-issues and the final PR, while MCP calls go from Anthropic to the configured MCP servers.

```mermaid
flowchart TD
  Operator["Browser / operator"]
  GitHubTrigger["GitHub issue labels/comments<br/>(polled)"]

  subgraph App["Bun + Hono service"]
    Dashboard["Dashboard WebUI"]
    RunAPI["Run API<br/>/api/runs + SSE"]
    Poller["GitHub trigger poller"]
    Queue["Run queue<br/>serial worker"]
    Execution["Run execution<br/>runIssueOrchestration"]
    Reaper["Stale run reaper"]
    EventBus["Run events<br/>SQLite + live fanout"]
    DevTunnel["Optional dev tunnel<br/>ngrok + mcp-gateway + mcp-proxy"]
    CustomTools["Custom tool handlers<br/>create_sub_issue / create_final_pr"]
  end

  DB[(SQLite dashboard.db<br/>runs / sessions / events<br/>prompts / repositories / MCP servers<br/>repo envs / agent registry)]
  State[".maestro<br/>runtime state + locks"]

  subgraph Anthropic["Anthropic Claude Managed Agents"]
    Env["Cloud environment"]
    Vault["Vault<br/>MCP credentials"]
    AgentRegistry["Agent registry<br/>create/update versions"]
    Parent["Parent coordinator agent<br/>maestro-orchestrator"]
    Child["Child implementer agent<br/>maestro-implementer"]
    Session["Run session<br/>primary + child threads"]
  end

  subgraph External["External systems"]
    GitHubAuth["GitHub App auth<br/>installation token"]
    GitHub["GitHub API / repository"]
    GitHubMCP["GitHub MCP"]
    LinearMCP["Linear MCP"]
    CustomMCP["Custom MCP servers"]
  end

  Operator --> Dashboard
  Operator --> RunAPI
  Dashboard --> Queue
  RunAPI --> Queue
  RunAPI --> EventBus
  GitHubTrigger --> Poller
  Poller --> DB
  Poller --> GitHubAuth
  Poller --> Queue
  Queue --> DB
  Queue --> Execution
  Queue --> EventBus
  Reaper --> DB
  Reaper --> Session
  Reaper --> EventBus
  EventBus --> DB

  Execution --> GitHubAuth
  GitHubAuth --> GitHub
  Execution --> DB
  Execution --> State
  Execution --> Env
  Execution --> Vault
  Execution --> AgentRegistry
  Execution --> Session
  Execution --> EventBus

  AgentRegistry --> DB
  AgentRegistry --> Child
  AgentRegistry --> Parent
  Session --> Parent
  Parent -->|multiagent.coordinator threads| Child
  Parent --> CustomTools
  CustomTools --> GitHub
  CustomTools --> DB

  DB -->|mcp_servers rows| AgentRegistry
  Parent --> GitHubMCP
  Child --> GitHubMCP
  Parent --> LinearMCP
  Child --> LinearMCP
  Parent --> CustomMCP
  Child --> CustomMCP
  Vault -. credentials .-> GitHubMCP
  Vault -. credentials .-> LinearMCP
  Vault -. credentials .-> CustomMCP
  DevTunnel --> CustomMCP
  DevTunnel -->|sync tunnel URLs| DB
  RunAPI -. SSE session events .-> Session
```

## Quick Start

```bash
bun install
export ANTHROPIC_API_KEY=...
export GITHUB_APP_ID=...
export GITHUB_APP_PRIVATE_KEY_PATH=/path/to/github-app.pem
bun run start
# → Listening on http://127.0.0.1:3000
```

Open http://127.0.0.1:3000 in your browser.

For local development (including the **ngrok-backed dev tunnel** that lets
Claude Managed Agents reach your local MCP servers), see
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Screenshots

![Run new form](docs/screenshots/run-new.png)
![Runs list](docs/screenshots/runs-list.png)

## Environment Variables

| Variable                      | Default                            | Description                                                                                                  |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PORT`                        | `3000`                             | listen port                                                                                                  |
| `HOST`                        | `127.0.0.1`                        | bind host (set to `0.0.0.0` to expose)                                                                       |
| `DB_PATH`                     | `.maestro/dashboard.db`            | SQLite db                                                                                                    |
| `CONFIG_PATH`                 | (none)                             | optional config TS path                                                                                      |
| `ANTHROPIC_API_KEY`           | (required)                         | Anthropic API key                                                                                            |
| `GITHUB_APP_ID`               | (required)                         | GitHub App ID                                                                                                |
| `GITHUB_APP_PRIVATE_KEY`      | (required unless path is set)      | GitHub App private key. Escaped `\n` is accepted                                                             |
| `GITHUB_APP_PRIVATE_KEY_PATH` | (none)                             | Path to a GitHub App private key PEM file. Used when `GITHUB_APP_PRIVATE_KEY` is not set                     |
| `GITHUB_APP_INSTALLATION_ID`  | (auto)                             | Optional installation ID. If omitted, the app installation is resolved from each `owner/repo`                 |
| `LOG_LEVEL`                   | `info`                             | log level                                                                                                    |
| `LOG_FILE`                    | stderr                             | log file path                                                                                                |

GitHub App permissions should include `Metadata: read`, `Contents: write`, `Issues: write`, and `Pull requests: write`. Add `Workflows: write` only if agents are expected to edit workflow files.

Do not bake the GitHub App private key PEM into a Docker image. Provide it at runtime with `GITHUB_APP_PRIVATE_KEY` (inline env var) or `GITHUB_APP_PRIVATE_KEY_PATH` pointing to a runtime-mounted file such as `/data/secrets/github-app.pem`.

In GitHub App mode, prefer managed vaults (no `VAULT_ID`) when running multiple repositories: a configured shared vault has one GitHub MCP credential per URL, so repository-scoped installation tokens can overwrite each other. See `docs/deploy-fly.md#caveat-vault-credential-sharing-in-github-app-mode`.

## HTTP API

### POST /api/runs

```json
{ "issue": 42, "repo": "owner/name", "dryRun": false }
```

returns `{ "runId": "uuid" }`

### GET /api/runs

returns `{ "runs": [...], "total": N }`

### GET /api/runs/:runId

returns full run detail

### POST /api/runs/:runId/stop

returns `{ "outcome": "stopped" | "..." }`

### GET /api/runs/:runId/events

Server-Sent Events stream. Supports `Last-Event-ID` for resume.
Event kinds: `phase`, `session`, `subIssue`, `log`, `complete`, `error`.

## WebUI flow

1. Open `http://127.0.0.1:3000/runs/new` in your browser
2. Enter `Issue Number` (e.g. `21925`) and `Repo` (e.g. `CyberAgentSRG/server`)
3. (Optional) Check `Dry-run` to compute the decomposition plan only
4. Submit → you are redirected to `/runs/:runId/live`, which shows real-time progress over SSE

## Prompt Management

You can **view and edit the agents' system prompts** from the WebUI. Edited values are persisted to SQLite (`.maestro/dashboard.db`) and automatically loaded into the Anthropic-side agent definition on the next run.

Open the **Prompts** tab in the header to navigate to the prompt list (`/prompts`) and edit them.

## Configuration

Customize behavior by creating a `maestro.config.ts` file.

```ts
import type { Config } from "./src/shared/config";

const config: Config = {
  models: { parent: "claude-opus-4-8", child: "claude-sonnet-4-6" },
  maxSubIssues: 10,
  maxRunMinutes: 120,
  maxChildMinutes: 30,
  pr: { draft: true, base: "main" },
  commitStyle: "conventional",
  git: {
    authorName: "claude-agent[bot]",
    authorEmail: "claude-agent@users.noreply.github.com",
  },
};

export default config;
```

The default parent model is `claude-opus-4-8`; the default child model remains `claude-sonnet-4-6`. You can override either model with `models.parent` / `models.child` or the `PARENT_MODEL` / `CHILD_MODEL` environment variables when your Anthropic workspace supports a different model.

## Cost

Costs depend on the configured models and current Anthropic pricing. The default parent/child pair is `claude-opus-4-8` / `claude-sonnet-4-6`.

The total cost from issue decomposition to sub-task completion depends on the size of the issue and the number of child tasks generated. Anthropic's pricing changes over time, so check the official docs for the latest rates.

## Deployment

See `docs/deploy-fly.md` for Fly.io deployment steps. The repository ships with `Dockerfile`, `fly.toml`, and `scripts/start.sh`.

## E2E Tests

```bash
E2E=1 TEST_REPO=<owner>/<repo> TEST_ISSUE=<n> bun run scripts/e2e-real.ts
```

See `docs/e2e-setup.md` for details.

## Troubleshooting

- **Stale lockfile**: `rm .maestro/run.lock.lock`
- **No history in the WebUI**: you need to run an issue at least once to populate the DB
- **Port conflict**: `PORT=3097 bun run start`
