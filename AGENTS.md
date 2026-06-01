# AGENTS.md — github-issue-agent

## 作業ルール

- このリポジトリには別のエージェントも作業しているため、他のエージェントが変更したものはそのままにしておいてください。

## コマンド

- Bun 1.3+ 前提。lockfile は text 形式の `bun.lock`。`bun.lockb` / npm / pnpm / yarn lock は使わない。
- セットアップ: `bun install --frozen-lockfile`。通常のローカル開発は `bun install` でも可。
- 起動: `bun run start` (= `bun run index.ts`)。watch は `bun run dev`。
- 検証順: `bun run lint` → `bun run typecheck` → `bun test`。通常 CI はこの 3 つをまとめて走らせない。
- 単体/範囲テスト: `bun test path/to/file.ts` または `bun test src/features/dev-tunnel`。coverage は `bun test --coverage` (line 75% / function 50%)。
- `bun run build` は dashboard CSS だけを生成する (`src/features/dashboard/styles/tailwind.css` → `dist/dashboard.css`)。UI/CSS 変更時は走らせる。
- Live E2E は課金・実 repo 書き込みあり: `E2E=1 TEST_REPO=<owner>/<repo> TEST_ISSUE=<n> bun run scripts/e2e-real.ts`。dry-run harness は `E2E_DRY_RUN=1 TEST_REPO=<owner>/<repo> TEST_ISSUE=<n> bun run scripts/e2e-dry-run.ts`。

## ツールチェインの癖

- TypeScript は `strict` + `noUncheckedIndexedAccess` + `moduleResolution: Bundler`。JSX は Hono (`jsxImportSource: hono/jsx`)。
- path alias は `@/*` → `./src/*`。import は `@/shared/config` 形式を使う。
- `tsconfig.json` の include は `src/**/*` と `test/**/*` のみ。`scripts/**/*` は通常 typecheck 対象外だが、`scripts/*.test.ts` は `bun test` で実行される。
- Biome は formatter+linter 一体。対象は `src/**/*.ts(x)`, `tailwind.config.ts`, `package.json`。`test/e2e/prompts.e2e.*.js` は formatter/linter 無効。
- `@anthropic-ai/sdk` は lockfile 上 `0.95.1`。Managed Agents の `thinking` / `budget_tokens` は未対応として無効化中。触る前に `TODO(sdk-thinking)`, `TODO(sdk-v0.91)`, `MAX_THINKING_BUDGET_DEFERRED` を検索する。

## CI / GitHub Actions

- `.github/workflows/e2e.yml` は PR/manual で real E2E を実行する。Dependabot/fork PR では secrets 前提のためスキップ条件あり。
- `.github/workflows/zizmor.yml` は workflow security scan。`.github/workflows/fly-deploy.yml` は `main` push で `flyctl deploy --remote-only`。
- GitHub Actions は SHA pin + `# vX` コメントのスタイル。`.github/dependabot.yml` が actions だけ weekly update する。

## アーキテクチャ

- Entry point は `index.ts`。DB 初期化、prompt seed、agent registry、run queue、stale-run-reaper、GitHub trigger poller、optional dev tunnel、Hono API/WebUI をここで配線する。
- Vertical Slice Architecture。`src/features/*` が use case、`src/shared/*` が横断コード。現在の feature には `dev-tunnel` と `stale-run-reaper` も含まれる。
- HTTP API は GitHub issue と Linear issue origin を扱う。`origin` 省略時は `github_issue`。Linear は `linearIssue` identifier/URL を使う。
- 新規 Anthropic custom tool を作る時だけ `handler.ts` + `schemas.ts` + `tool-definition.ts` の構成を踏襲する。既存では `decomposition/` と `finalize-pr/`。
- WebUI は Hono SSR + 最小限の client JS。静的 asset root は `./dist`。

## Managed Agents / MCP

- Parent は `github-issue-orchestrator`、child は `github-issue-implementer`。Managed Agents multi-agent coordinator topology を使う。
- `src/shared/agents/registry.ts` は child を先に create/update し、parent の `multiagent.coordinator` roster に child `{id, version}` を埋め込む。registry state は DB の `agent_registry_state`。
- `spawn_child_task` custom tool は廃止済み。parent custom tools は `create_final_pr` と `create_sub_issue` だけ (`src/parent-tools.ts`)。
- Delegation 観測イベント名は `session.thread_created`, `agent.thread_message_sent/received`, `session.thread_status_*`。
- MCP toolsets は DB の `mcp_servers` から agent definition に入る。`src/parent-tools.ts` に MCP tool を足さない。
- Builtin GitHub MCP は name `github`, URL `https://api.githubcopilot.com/mcp/`。GitHub App installation token を repo ごとに mint して使う。
- Linear origin は enabled MCP server URL `https://mcp.linear.app/mcp` が必須。managed vault credential を作る run ではその row の `token_env_name` も必須。

## DB / 永続化

- SQLite default は `.github-issue-agent/dashboard.db`。schema source of truth は `src/shared/persistence/db.ts` の `SCHEMA_SQL`。
- `.github-issue-agent/` は gitignore 済みの runtime state (DB, lock, state, run JSON)。stale lock だけなら `.github-issue-agent/run.lock.lock` を疑う。
- WebUI 管理データは env/config ではなく DB が source of truth: prompts, polled repositories, MCP servers, repo prompts, repo environments, repo chat, agent registry state。
- GitHub trigger の監視 repo は `/repositories` で `polled_repositories` に追加する。旧 `GITHUB_TRIGGER_REPOS` env は使わない。poller は常時起動し、空なら no-op。
- Prompt keys は `parent.system`, `child.system`, `parent.runtime`, `child.runtime`。UI で編集できるのは `*.system`、runtime template は read-only。
- Config は `github-issue-agent.config.ts/json` または `CONFIG_PATH`。schema は strict。env override は `PARENT_MODEL`, `CHILD_MODEL`, `MAX_SUB_ISSUES`, `MAX_RUN_MINUTES`, `VAULT_ID` のみ。

## WebUI / i18n

- `src/features/dashboard/` の UI 実装・レイアウト・Tailwind 調整では必ず `frontend-design` skill をロードし、必要なら `@designer` に委任する。
- WebUI 文言は `src/features/dashboard/i18n.ts` の `t()` / `tPlural()` 経由で en/ja 両対応。ハードコードしない。
- locale 決定順は `dashboard_locale` cookie → `Accept-Language` → `en`。切替 route は `GET /locale/:locale?next=...`。

## テストの置き場所と fixture

- 基本は source 横 `__tests__/`。加えて `test/e2e/`, `test/integration/`, top-level `test/*.test.ts`, `scripts/*.test.ts` がある。
- `bunfig.toml` で `test/setup.ts` を preload。Anthropic API fake は `test/fixtures/fake-anthropic*.ts`。
- Real E2E は disposable repo と live credentials が必要。成功/失敗時に PR, branch, sub-issue, Vault/Session を best-effort cleanup する。詳細は `docs/e2e-setup.md`。

## 環境・運用 gotchas

- 起動必須 env は `ANTHROPIC_API_KEY`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` または `GITHUB_APP_PRIVATE_KEY_PATH`。PAT 認証は無い。`GITHUB_APP_INSTALLATION_ID` は repo から自動解決可。
- GitHub App mode で複数 repo を扱う時は shared `VAULT_ID` を避ける。MCP credential は URL 単位なので repo-scoped installation token が上書きされ得る。
- `ENABLE_DEV_TUNNEL=true` は Python `mcp-proxy` + Bun `mcp-gateway` subprocess + ngrok を起動し、`mcp_servers` を tunnel URL に upsert する。`NGROK_AUTHTOKEN` と固定 `MCP_GATEWAY_TOKEN` が必須。詳細は `docs/DEVELOPMENT.md`。
- Fly runtime は `scripts/start.sh` が app, mcp-proxy, MCP gateway, cloudflared を起動する。`CLOUDFLARE_TUNNEL_TOKEN` 未設定では start.sh が拒否する。
- Fly の DB default は `/data/app/dashboard.db`。start.sh は `/app/.github-issue-agent` を volume 上の agent-state へ symlink する。
- `docs/mcp.md` には SDK `0.90.0` / `v0.91` 前提の古い記述が残る。SDK 制約は `src/shared/constants.ts` と `src/shared/agents/*` を優先する。
