# AGENTS.md — github-issue-agent

## ランタイムとツールチェイン

- **Bun 1.3+** — TS を直接実行。`package.json` に `engines` 指定は無いが、Docker base image は `oven/bun:1.3-debian`
- **TypeScript** — `strict: true` + `noUncheckedIndexedAccess: true`。`tsconfig.json` の include は `src/**/*` と `test/**/*` のみ (`scripts/**/*` は typecheck 対象外)
- **パスエイリアス** — `@/*` → `./src/*`。import は `@/shared/config` のように書く
- **Biome** — formatter + linter 一体。space indent 2, line width 100, recommended rules。対象は `src/**/*`, `tailwind.config.ts`, `package.json`
- **SDK** — `@anthropic-ai/sdk@0.95.1` (lockfile でピン留め)。Managed Agents Beta multi-agent (coordinator topology) を使用
- **Tailwind CSS v4** — WebUI のスタイリングに使用
- **lockfile** — `bun.lock` (text 形式)。`bun.lockb` は使っていない

## コマンド

```bash
bun run start              # bun run index.ts
bun run dev                # bun run --watch index.ts
bun run build              # = bun run build:css (CSS minify。no-op ではない)
bun run build:css          # tailwindcss -o dist/dashboard.css --minify
bun run dev:css            # tailwindcss watch
bun run typecheck          # tsc --noEmit
bun run lint               # biome check .
bun test                   # 全テスト
bun test path/to/file.ts   # 単一ファイル
bun test --coverage        # カバレッジ (line 75% / function 50% 閾値: bunfig.toml)
```

検証順: `lint` → `typecheck` → `test`。**CI ではこれらは走らない** (`.github/workflows/` は `fly-deploy.yml` のみで、Fly.io デプロイ専用)。ローカルで通すのは開発者責任。

## ローカル開発

ローカル開発手順 (前提パッケージ、`bun run start` 実行、検証、トラブル
シューティング) と、Claude Managed Agents から手元の MCP server に到達する
ための **ngrok-backed dev tunnel** (`ENABLE_DEV_TUNNEL=true` で
`mcp-proxy` + `mcp-gateway` + ngrok を自動起動し、`mcp_servers` テーブルを
公開 URL で upsert する仕組み) は `docs/DEVELOPMENT.md` に集約している。
新規環境のセットアップや tunnel 関連の挙動を変える前にまずこのドキュメント
を参照すること。

## アーキテクチャ

Vertical Slice Architecture。`src/features/` の各ディレクトリが 1 つのユースケースを自己完結的に持ち、レイヤー横断の共有コードは `src/shared/` に置く。

```
src/
  features/
    run-api/                # HTTP API routes (POST /api/runs, SSE multiplexer 等)
    run-execution/          # Orchestration core (runIssueOrchestration, event-bridge)
    run-queue/              # FIFO queue + DB-persisted status
    run-stop/               # Run cancellation
    dashboard/              # Hono SSR + Tailwind WebUI (pages, components, i18n)
    decomposition/          # issue → sub-issue 分解 (github-write)
    finalize-pr/            # 最終 PR 作成
    github-trigger/         # GitHub Issue polling → /api/runs auto-enqueue (@bot run / label)
    preflight/              # 実行前バリデーション
    mcp-gateway/            # Managed Agents から到達可能な MCP gateway (sidecar)
    repo-chat/              # WebUI 上の repo に対する対話セッション
  shared/
    agents/                 # parent/child agent definition, registry, environment, prompts
    github/                 # Octokit wrapper, 型, issue read プリミティブ
    persistence/            # SQLite db module + zod schemas (db.ts: SCHEMA_SQL, schemas.ts)
    prompts/                # default prompt seeding + loader
    run-events/             # EventEmitter + DB-backed event log + Last-Event-ID
    session.ts              # Managed Agents イベントループ
    config.ts               # zod スキーマ + 環境変数オーバーライド
    state.ts                # .github-issue-agent/ 下の JSON 状態 + proper-lockfile
    vault.ts                # Anthropic Vault / MCP credential 管理
    signals.ts              # SIGINT/SIGTERM/uncaught cleanup registry
    logging.ts              # pino ログ (token 自動マスク)
    constants.ts            # モデル名, MCP URL, ツール名, ファイルパス定数
    pricing.ts              # session cost 計算 (claude-opus-4-7 等)
    tool-schema-core.ts     # zod → Anthropic tool schema の変換ヘルパ
    types.ts                # RunStatus/RunPhase/RunEvent/RunSummary 等
index.ts                    # HTTP サーバーのエントリポイント (bun run index.ts)
```

## 設計パターン

- **Vertical Slice**: feature 内ファイル構成は均一ではない。`decomposition/` と `finalize-pr/` は `handler.ts` + `schemas.ts` + `tool-definition.ts` の Anthropic tool 構成だが、他 feature は `server.ts`, `poller.ts`, `sse.ts`, `validate.ts` 等で構成される。新規 tool を追加する際だけ 3 ファイル構成を踏襲
- **Hono SSR**: WebUI は Hono ベースの SSR。クライアントサイド JS は最小限
- **DI**: 主要モジュール (`persistence`, `registry`, `logging`) は `createXxxModule(overrides)` で依存注入可。テストでは実 I/O をモック
- **Agent registry**: エージェント定義のハッシュ比較で変更時のみ API に update。child を先に作成 → parent の `multiagent.coordinator` roster に child の `{id, version}` を埋め込む順序で登録
- **Multi-agent coordinator topology**: parent は `multiagent: { type: "coordinator", agents: [...] }` を持ち、child (`github-issue-implementer`) への delegation は API がネイティブ実行。`spawn_child_task` カスタムツールは廃止。delegation 進捗は `agent.thread_created` / `agent.thread_message_(sent|received)` / `session.thread_status_*` で観測。delegation depth は `registry.ts` の `buildCoordinatorRoster()` で 1 固定
- **Sidecar 構成 (Fly)**: `scripts/start.sh` は app 本体に加え mcp-proxy / MCP gateway / cloudflared を起動する。詳細は `docs/mcp.md`

## UI/UX 実装

- **`src/features/dashboard/` の WebUI を実装・修正する際は必ず `frontend-design` スキルをロード**。新規ページ・コンポーネント追加、レイアウト変更、Tailwind スタイル調整、視覚的ポリッシュ、レスポンシブ対応が対象
- WebUI 文言は i18n 必須。`src/features/dashboard/i18n.ts` の `t()` / `tPlural()` 経由で en / ja 両対応にする。ハードコード禁止
- locale 決定順: `dashboard_locale` cookie → `Accept-Language` → default `en`。切替は `GET /locale/:locale?next=...` で `Set-Cookie`
- スキルロード後は `@designer` サブエージェントへの委任を優先検討
- 純粋なバックエンドロジックのみの変更は対象外

## DB / 永続化

- ランタイム DB: `.github-issue-agent/dashboard.db` (SQLite + WAL)
- スキーマ: SQL は `src/shared/persistence/db.ts` の `SCHEMA_SQL`、zod は `src/shared/persistence/schemas.ts`
- **WebUI で CRUD する table が複数存在** (env や config ファイルではなく DB が source of truth):
  - `prompts` / `prompt_revisions` — agent system prompt
  - `polled_repositories` — github-trigger の監視対象 (旧 `GITHUB_TRIGGER_REPOS` env は廃止)
  - `mcp_servers` — Managed Agents が接続する MCP server (builtin: `github` = `https://api.githubcopilot.com/mcp/`, GitHub App installation token を実行時に利用)
  - `repo_prompts` / `repo_prompt_revisions` — repo 別 prompt override
  - `repo_environments` / `repo_environment_revisions` — repo 別の環境変数 / setup スクリプト
  - `repo_chat_state` / `repo_chat_threads` / `repo_chat_messages` — repo-chat feature
- 他: `runs`, `sessions`, `session_usage`, `run_events`, `sub_issues`, `github_trigger_dedupe`

## Prompts

- デフォルトキー: `parent.system`, `child.system`, `parent.runtime`, `child.runtime`
- 起動時に `index.ts` が `seedDefaultPrompts({ db, logger })` を呼ぶ。`db.seedPromptIfMissing()` で idempotent
- `loadAgentSystemPrompts()` が DB から `parent.system` / `child.system` を読み、失敗時は source default に fallback
- **runtime template (`*.runtime`) は UI 上 read-only**。編集対象は `*.system` のみ

## テスト

- ソース横の `__tests__/` に colocate するのが基本
- **加えて以下にもテストが存在** (見落としやすい):
  - `test/e2e/` — E2E (`prompts.e2e.*.js` 含む。Biome 対象外)
  - `test/integration/` — integration
  - `test/parent-tools.test.ts` 等のトップレベルテスト
  - `scripts/e2e-real.test.ts`, `scripts/replay-qa.test.ts`
- `bunfig.toml` で `test/setup.ts` を preload (現在は空)
- `test/fixtures/` に Anthropic API のフェイク (`fake-anthropic.ts`, `fake-anthropic-sessions.ts`)
- E2E (`scripts/e2e-real.ts`) は実 API 呼び出し: `E2E=1 TEST_REPO=<owner>/<repo> TEST_ISSUE=<n>` が必須。`docs/e2e-setup.md` 参照
- Dry-run E2E: `scripts/e2e-dry-run.ts` (`E2E_DRY_RUN=1`)
- Cleanup 検証: `scripts/verify-cleanup.ts` (Vault / session の削除確認)

## 環境変数

主要なもののみ。網羅は `src/shared/config.ts` / `index.ts` / `.env.example` を参照。

| 変数 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API キー (必須) |
| `GITHUB_APP_ID` / `_PRIVATE_KEY` / `_PRIVATE_KEY_PATH` / `_INSTALLATION_ID` | GitHub App 認証。`_INSTALLATION_ID` は省略可で repo から自動解決 |
| `PORT` / `HOST` | listen ポート / bind host (default: 3000 / 127.0.0.1。公開時は `HOST=0.0.0.0`) |
| `DB_PATH` | SQLite path (default: `.github-issue-agent/dashboard.db`) |
| `CONFIG_PATH` | `github-issue-agent.config.ts` のパスを上書き |
| `LOG_LEVEL` / `LOG_FILE` | pino ログ設定 (default: `info` / stderr) |
| `PARENT_MODEL` / `CHILD_MODEL` | モデル名オーバーライド |
| `MAX_SUB_ISSUES` / `MAX_RUN_MINUTES` | config 上限の env オーバーライド |
| `VAULT_ID` | 既存 Anthropic Vault を再利用する場合に指定 (無指定なら managed vault を毎回作成) |
| `GITHUB_TRIGGER_POLL_INTERVAL_SECONDS` | Issue auto-trigger polling 間隔 (default: 60) |
| `GITHUB_BOT_MENTION` | issue コメント先頭 `@<bot> run` トリガー (default: `bot`) |
| `GITHUB_TRIGGER_LABEL` | このラベル付与でトリガー (default: `agent-run`) |
| `MCP_GATEWAY_HOST` / `_PORT` / `_TOKEN` / `_UPSTREAM_URL` | mcp-gateway sidecar 設定 |
| `MCP_PROXY_HOST` / `_PORT` / `_CONFIG` / `_ALLOW_ORIGIN` | mcp-proxy sidecar 設定 |
| `CLOUDFLARE_TUNNEL_TOKEN` | Fly 上で cloudflared 経由公開する場合 |

> **NOTE**: 監視対象リポジトリは env ではなく WebUI (`/repositories` の "Add polled repository") で管理する。Poller は常時起動し、テーブルが空のときは各サイクルが no-op になる。

## Vault / MCP credential

- `src/shared/vault.ts` が Managed Agents Vault と MCP credential を管理
- `VAULT_ID` または `config.vaultId` 指定があれば既存 vault を reuse → cleanup でも削除しない
- 指定が無ければ managed vault を毎回作成 → run cleanup で削除
- MCP credential は `mcp_server_url` 単位で reuse。新規は `static_bearer` で作成
- MCP token は caller が `process.env[server.tokenEnvName]` から解決して渡す (vault モジュールは env を直接読まない)。GitHub App mode の builtin GitHub MCP だけは installation token を caller が渡し、既存 credential も更新する
- SDK に Vault API が無いケースは `VaultApiUnavailable` を throw

## SDK バージョン依存

- `@anthropic-ai/sdk@0.95.1` 動作確認済 (`bun.lock` で固定)
- `thinking` / `budget_tokens` は SDK 未対応のため無効化。grep ヒント:
  - 現行: `TODO(sdk-thinking)` / `MAX_THINKING_BUDGET_DEFERRED` (`src/shared/constants.ts`)
  - **child 側に古い `TODO(sdk-v0.91)` / `thinking_deferred: "sdk-v0.91"` / `@anthropic-ai/sdk@0.90.0` コメントが残存**。修正時は両方検索すること
- config test が `thinking` / `budget_tokens` を unknown key として拒否するため、復活させる際はスキーマ更新も必要
- Anthropic 側の Managed Agents 制約 (agent 数 / thread 数 / 1 agent 当たり MCP server 数等) は `docs/mcp.md` 参照

## 注意事項

- `.github-issue-agent/` は gitignore 済みのランタイムディレクトリ (DB, state.json, run-*.json)
- `src/shared/logging.ts` が GitHub credential / Anthropic key を自動マスクする。ログに credential が漏れる場合はここを確認
- `docs/mcp.md` は SDK `0.90.0 / v0.91` 前提の古い表記が混在しているので、SDK 制約の事実関係は `src/shared/constants.ts` と `src/shared/agents/` を優先
- Fly デプロイは `git push` ベース (`.github/workflows/fly-deploy.yml` が `flyctl deploy --remote-only`)。手元から `flyctl deploy` する場合は `docs/deploy-fly.md`
