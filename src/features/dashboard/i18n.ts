import { AsyncLocalStorage } from "node:async_hooks";

export const SUPPORTED_LOCALES = ["en", "ja"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE_NAME = "dashboard_locale";

type I18nContext = {
  locale: Locale;
  currentPath: string;
};

type TranslationParams = Record<string, boolean | number | string | null | undefined>;

const i18nContext = new AsyncLocalStorage<I18nContext>();

const JA_TRANSLATIONS: Record<string, string> = {
  "github-issue dashboard": "github-issue ダッシュボード",
  dashboard: "ダッシュボード",
  Runs: "実行",
  "New Run": "新規実行",
  Repositories: "リポジトリ",
  "MCP Servers": "MCP サーバー",
  Prompts: "プロンプト",
  Language: "言語",
  English: "English",
  Japanese: "日本語",
  "SSR + progressive enhancement · built with Hono + bun:sqlite":
    "SSR + プログレッシブエンハンスメント · Hono + bun:sqlite",
  "SSR · no JS · built with Hono + bun:sqlite": "SSR · JS なし · Hono + bun:sqlite",

  repositories: "リポジトリ",
  prompts: "プロンプト",
  environment: "環境",
  live: "ライブ",
  chat: "チャット",
  run: "実行",
  repo: "リポジトリ",
  prompt: "プロンプト",
  issue: "Issue",
  origin: "起点",
  branch: "ブランチ",
  started: "開始日時",
  status: "ステータス",
  tasks: "タスク",
  tokens: "トークン",
  cost: "コスト",
  pr: "PR",
  details: "詳細",
  key: "キー",
  editable: "編集可",
  revisions: "リビジョン",
  updated: "更新日時",
  agent: "エージェント",
  server: "サーバー",
  url: "URL",
  token: "トークン",
  policy: "ポリシー",
  state: "状態",
  env: "環境変数",
  actions: "操作",

  Save: "保存",
  Cancel: "キャンセル",
  Edit: "編集",
  Configure: "設定",
  Delete: "削除",
  Enable: "有効化",
  Disable: "無効化",
  restore: "復元",
  edit: "編集",
  seed: "初期値",
  current: "現在",
  configured: "設定済み",
  "not-configured": "未設定",
  enabled: "有効",
  disabled: "無効",
  loaded: "読み込み済み",
  missing: "未設定",
  "not required": "不要",
  builtin: "組み込み",
  active: "稼働中",
  paused: "一時停止中",
  allow: "許可",
  ask: "確認",
  completed: "完了",
  failed: "失敗",
  running: "実行中",
  queued: "キュー待ち",
  aborted: "中止",
  errored: "エラー",
  "timed out": "タイムアウト",
  "idle reached": "アイドル到達",
  pending: "待機中",
  success: "成功",
  failure: "失敗",
  "failure details": "失敗の詳細",
  "failure type": "失敗種別",
  "in-progress": "進行中",
  info: "情報",

  "Not Found": "見つかりません",
  "Bad Request": "不正なリクエスト",
  "← back to repositories": "← リポジトリへ戻る",
  "← back to prompts": "← プロンプトへ戻る",

  "agent ran against {count} repository": "agent は {count} 件のリポジトリで実行されました",
  "agent ran against {count} repositories": "agent は {count} 件のリポジトリで実行されました",
  "Watch a repository for auto-trigger": "自動トリガー対象のリポジトリを監視",
  "Add an": "追加した",
  "to poll for": "を監視し、",
  comments: "コメントと",
  "label events.": "ラベルイベントを検出します。",
  Repository: "リポジトリ",
  "Add to polled list": "監視リストに追加",
  "Managed Agents usage": "Managed Agents 使用量",
  "total cost": "合計コスト",
  input: "入力",
  output: "出力",
  cache: "キャッシュ",
  "Aggregated from {count} repo with usage · {requests} model requests":
    "使用量がある {count} 件のリポジトリから集計 · {requests} 件のモデルリクエスト",
  "Aggregated from {count} repos with usage · {requests} model requests":
    "使用量がある {count} 件のリポジトリから集計 · {requests} 件のモデルリクエスト",
  "{count} run": "{count} 件の実行",
  "{count} runs": "{count} 件の実行",
  "cost:": "コスト:",
  polled: "監視中",
  "polled (paused)": "監視中（一時停止）",
  "No runs yet": "まだ実行はありません",
  "Run a GitHub or Linear issue from New Run; history appears here.":
    "新規実行から GitHub または Linear の issue を指定して実行すると、ここに履歴が表示されます。",
  "Start your first run": "最初の実行を開始",
  "No runs for {repo}": "{repo} の実行はありません",
  "No runs for this repository yet.": "このリポジトリに対してまだ実行履歴がありません。",

  "Start New Run": "新規実行を開始",
  "Configure and enqueue a new managed agent run for GitHub or Linear.":
    "GitHub または Linear を起点に Managed Agent の実行を設定し、キューに追加します。",
  "Run origin": "実行の起点",
  "GitHub Issue": "GitHub Issue",
  Linear: "Linear",
  "Read the GitHub issue and close it from the final PR.":
    "GitHub Issue を読み取り、最終 PR で close します。",
  "Read the Linear issue through the enabled Linear MCP server.":
    "有効な Linear MCP サーバー経由で Linear issue を読み取ります。",
  "Issue Number": "Issue 番号",
  "GitHub Issue Number": "GitHub Issue 番号",
  "Linear Issue": "Linear Issue",
  "Required when Linear is selected.": "Linear を選択した場合に必須です。",
  "Vault ID": "Vault ID",
  "Config Path": "設定ファイルパス",
  "(Optional)": "（任意）",
  "Format: owner/repository": "形式: owner/repository",
  "Reuse an existing Anthropic vault": "既存の Anthropic vault を再利用します",
  "Dry Run": "ドライラン",
  "Enqueue the run in dry-run mode without remote execution.":
    "リモート実行せず、ドライランモードでキューに追加します。",
  "Start Run": "実行を開始",
  'unsupported locale "{locale}"': 'サポートされていないロケール "{locale}" です。',
  "runQueue is not configured for this dashboard":
    "このダッシュボードに runQueue が設定されていません。",
  "Issue number must be a positive integer.": "Issue 番号は正の整数である必要があります。",
  "Linear issue must not be empty.": "Linear issue は空にできません。",
  "Run origin must be GitHub Issue or Linear.":
    "実行の起点は GitHub Issue または Linear を選択してください。",
  "Repository must match owner/repository.":
    "リポジトリは owner/repository 形式で入力してください。",
  "Vault ID must not be empty.": "Vault ID は空にできません。",
  "Config path must not be empty.": "設定ファイルパスは空にできません。",
  "Dry run must be true or false.": "ドライランは true または false である必要があります。",
  "Invalid run form submission.": "実行フォームの送信内容が不正です。",

  "system prompts: editable / runtime templates: read-only":
    "system prompt は編集可 / runtime template は読み取り専用",
  "No prompts seeded yet": "プロンプトはまだ初期化されていません",
  'Restart the CLI or run "serve" to seed defaults.':
    'CLI を再起動するか "serve" を実行してデフォルトを投入してください。',
  "read-only": "読み取り専用",
  "view →": "表示 →",
  "Repository overrides": "リポジトリ別オーバーライド",
  "Per-repository additions on top of the global system prompts.":
    "グローバル system prompt に追加するリポジトリ別の指示です。",
  "No repository overrides configured.": "リポジトリ別オーバーライドは未設定です。",
  "Saved with same content — no new revision created.":
    "同じ内容で保存されました — 新しいリビジョンは作成されていません。",
  "Already at this revision — restore had no effect.":
    "すでにこのリビジョンです — 復元による変更はありません。",
  "This is a hardcoded runtime template. Read-only in MVP.":
    "これはハードコードされた runtime template です。MVP では読み取り専用です。",
  "diff (vs previous revision)": "差分（前回リビジョンとの比較）",
  history: "履歴",

  "Repository prompts": "リポジトリ別プロンプト",
  "Override the global system prompt with repository-specific instructions. Configured overrides are appended to each runtime prompt.":
    "グローバル system prompt にリポジトリ固有の指示を追加します。設定されたオーバーライドは各 runtime prompt に追記されます。",
  "Environment packages": "環境パッケージ",
  "Pre-install apt/npm/pip/go/cargo/gem packages for this repository's agent runs.":
    "このリポジトリの agent 実行前に apt/npm/pip/go/cargo/gem パッケージをインストールします。",
  "{count} run recorded for this repository.":
    "このリポジトリには {count} 件の実行が記録されています。",
  "{count} runs recorded for this repository.":
    "このリポジトリには {count} 件の実行が記録されています。",
  "View all runs →": "すべての実行を見る →",
  "Usage summary": "使用量サマリー",
  "Accumulated Anthropic Managed Agents token volume and estimated cost for this repository.":
    "このリポジトリの Anthropic Managed Agents の累積トークン量と推定コストです。",
  "{count} model request": "{count} 件のモデルリクエスト",
  "{count} model requests": "{count} 件のモデルリクエスト",
  "no usage recorded yet": "使用量はまだ記録されていません",
  "total tokens": "合計トークン",
  "cache create": "キャッシュ作成",
  "cache read": "キャッシュ読取",
  "model requests": "モデルリクエスト",
  "Parent orchestration instructions.": "parent のオーケストレーション指示です。",
  "Child execution instructions.": "child の実行指示です。",
  "GitHub Issue auto-trigger": "GitHub Issue 自動トリガー",
  "Polls this repository for": "このリポジトリで",
  "issue comments and": "Issue コメントと",
  "label additions, automatically enqueuing a run when matched. The poller runs continuously; toggle off to pause without losing dedupe history.":
    "ラベル追加を監視し、一致したときに自動で実行をキューに追加します。ポーラーは継続的に動作します。重複排除履歴を保持したまま一時停止できます。",
  "Not polled yet": "まだ監視していません",
  "This repo is not yet polled. Add it to start receiving auto-triggers.":
    "このリポジトリはまだ監視対象ではありません。追加すると自動トリガーを受け取れます。",
  "Enable polling for this repo": "このリポジトリの監視を有効化",
  "Polling active": "監視は有効です",
  "Polling paused": "監視は一時停止中です",
  "New matching issue comments or label events will enqueue runs automatically.":
    "一致する Issue コメントやラベルイベントがあると、自動的に実行をキューに追加します。",
  "Dedupe history is retained while the poller skips this repository.":
    "ポーラーはこのリポジトリをスキップしますが、重複排除の履歴は保持されます。",
  added: "追加日時",
  "last updated": "最終更新",
  "bot mention": "bot メンション",
  "trigger label": "トリガーラベル",
  "Pause polling": "監視を一時停止",
  "Resume polling": "監視を再開",
  "Remove from polled list": "監視リストから削除",
  packages: "パッケージ",
  "anthropic env": "Anthropic 環境",
  "not yet synced": "未同期",
  "No repository-specific packages configured. Runs use the base environment only.":
    "リポジトリ固有のパッケージは未設定です。実行にはベース環境のみを使用します。",
  "Repository chat": "リポジトリチャット",
  "Read-only inspection": "読み取り専用の確認",
  "Ask about settings, MCP availability, and repository contents before starting an agent run.":
    "agent 実行前に、設定、MCP 利用状況、リポジトリ内容について確認できます。",
  "Open chat →": "チャットを開く →",
  "Chat with {repo}": "{repo} とチャット",
  "Chat error": "チャットエラー",
  "auto-trigger": "自動トリガー",
  "{count} package": "{count} 個のパッケージ",
  "{count} packages": "{count} 個のパッケージ",
  "base only": "ベースのみ",
  "open settings →": "設定を開く →",
  total: "合計",
  "open MCP servers →": "MCP サーバーを開く →",
  "Managed Agents mounts this repository for read-only inspection during each chat turn.":
    "各チャットターンで Managed Agents がこのリポジトリを読み取り専用確認用にマウントします。",
  "Suggested questions": "候補の質問",
  "Start with a suggested question or ask about this repository directly.":
    "候補から始めるか、このリポジトリについて直接質問してください。",
  "No messages yet": "まだメッセージはありません",
  you: "あなた",
  assistant: "アシスタント",
  "Context included": "含めるコンテキスト",
  "Repository settings": "リポジトリ設定",
  "MCP availability": "MCP 利用状況",
  "Repository contents": "リポジトリ内容",
  "Recent runs": "最近の実行",
  "Ask a question": "質問",
  "Ask a question about this repository…": "このリポジトリについて質問…",
  "Submitting creates a short-lived Managed Agents session and reloads this page with the latest answer.":
    "Managed Agents セッションを作成し、回答を更新します。",
  Send: "送信",
  "Chat history": "チャット履歴",
  "New chat →": "新しいチャット →",
  "Summarize repository setup": "リポジトリ設定を要約",
  "Check MCP readiness": "MCP の準備状況を確認",
  "Review environment packages": "環境パッケージを確認",
  "Inspect repository contents": "リポジトリ内容を調べる",
  "Find recent run failures": "最近の実行失敗を探す",
  "chat message must be 1-4000 characters": "チャットメッセージは 1〜4000 文字で入力してください。",
  "invalid chat context flags": "チャットコンテキスト指定が不正です。",

  "Override editor": "オーバーライドエディタ",
  "Repository-specific additions for {repo}.": "{repo} 用のリポジトリ固有の追加指示です。",
  "Remove override": "オーバーライドを削除",
  "Global prompt (read-only)": "グローバルプロンプト（読み取り専用）",
  "Base {promptKey} prompt used before this repository override is appended.":
    "このリポジトリのオーバーライドが追記される前に使われるベースの {promptKey} プロンプトです。",
  "view global →": "グローバルを表示 →",
  "Diff vs previous revision": "前回リビジョンとの差分",
  History: "履歴",
  "Override removed. This repository now uses the global prompt only.":
    "オーバーライドを削除しました。このリポジトリはグローバルプロンプトのみを使用します。",
  "This override is appended to the global": "このオーバーライドはグローバル",
  "prompt as a": "プロンプトに",
  "section. Leave empty (remove) to fall back to the global prompt only.":
    "セクションとして追記されます。空にして削除すると、グローバルプロンプトのみへ戻ります。",

  "Package editor": "パッケージエディタ",
  "Repository-specific packages pre-installed for": "事前インストールするリポジトリ固有パッケージ:",
  "Remove configuration": "設定を削除",
  "Anthropic state (read-only)": "Anthropic 状態（読み取り専用）",
  "The cloud environment is created or updated lazily when the next repository run starts.":
    "クラウド環境は次回のリポジトリ実行開始時に遅延作成または更新されます。",
  "environment id": "環境 ID",
  "definition hash": "定義ハッシュ",
  "Always includes:": "常に含む:",
  "Always included": "常に含まれる",
  "Examples:": "例:",
  "package specs": "パッケージ指定",
  "Base packages are always auto-merged at runtime: apt includes git, and npm includes bun. Leave all fields empty to use only the base environment. Saves update the database now; Anthropic environments sync lazily on the next run.":
    "ベースパッケージは実行時に常に自動マージされます: apt には git、npm には bun が含まれます。すべてのフィールドを空にするとベース環境のみを使用します。保存すると DB は即時更新され、Anthropic 環境は次回実行時に遅延同期されます。",
  "One package per line. Enhanced mode turns entries into removable chips.":
    "1 行に 1 パッケージ。拡張モードでは項目を削除可能なチップに変換します。",
  "Saved with the same package lists — no new revision created.":
    "同じパッケージリストで保存されました — 新しいリビジョンは作成されていません。",
  "Environment package configuration removed. This repository now uses only base packages.":
    "環境パッケージ設定を削除しました。このリポジトリはベースパッケージのみを使用します。",
  expand: "展開",
  collapse: "折りたたむ",
  "No extra packages. Base packages only.":
    "追加パッケージはありません。ベースパッケージのみです。",
  "no extra packages": "追加パッケージなし",

  "Managed Agents integrations": "Managed Agents 連携",
  "Register remote MCP endpoints that the coordinator and implementer can use during GitHub issue automation. The GitHub MCP server is built in and remains protected, while its token environment variable and policy can still be tuned here.":
    "GitHub Issue 自動化中に coordinator と implementer が利用できるリモート MCP エンドポイントを登録します。GitHub MCP サーバーは組み込みで保護されますが、トークン環境変数とポリシーはここで調整できます。",
  registered: "登録数",
  "missing env": "未設定 env",
  "Add MCP server": "MCP サーバーを追加",
  "Add an HTTP(S) MCP endpoint. Optionally provide an environment variable containing a bearer token; leave it blank for public endpoints. Tokens are never stored in the dashboard database.":
    "HTTP(S) MCP エンドポイントを追加します。必要に応じて bearer token を保持する環境変数を指定し、公開エンドポイントでは空欄にできます。トークンはダッシュボード DB に保存されません。",
  Name: "名前",
  URL: "URL",
  "Token env var": "トークン環境変数",
  "Permission policy": "権限ポリシー",
  "Used as the Managed Agents mcp_server_name.":
    "Managed Agents の mcp_server_name として使用します。",
  "Leave blank for public or unauthenticated MCP servers.":
    "公開または未認証の MCP サーバーでは空欄にします。",
  "Enable immediately": "すぐに有効化",
  "Disabled servers remain saved but are not used.":
    "無効なサーバーは保存されますが使用されません。",
  "Configured servers": "設定済みサーバー",
  "Toggle availability without deleting credentials. Missing configured environment variables are highlighted before the next agent registration run.":
    "認証情報を削除せずに利用可否を切り替えます。設定済み環境変数の不足は次回 agent 登録前に強調表示されます。",
  "No MCP servers configured": "MCP サーバーは未設定です",
  "The builtin GitHub MCP server should be seeded automatically when the database initializes.":
    "DB 初期化時に組み込み GitHub MCP サーバーが自動投入されるはずです。",
  "MCP server added.": "MCP サーバーを追加しました。",
  "A MCP server with that name already exists.": "同じ名前の MCP サーバーがすでに存在します。",
  "MCP server disabled.": "MCP サーバーを無効化しました。",
  "MCP server enabled.": "MCP サーバーを有効化しました。",
  "Invalid MCP server form submission.": "MCP サーバーフォームの送信内容が不正です。",
  "MCP server removed.": "MCP サーバーを削除しました。",
  "MCP servers": "MCP サーバー",
  "Edit the Managed Agents MCP server record. Builtin servers keep their canonical identity locked so agent definitions can rely on stable names and URLs.":
    "Managed Agents MCP サーバーレコードを編集します。組み込みサーバーは名前と URL を固定し、agent 定義が安定して参照できるようにします。",
  "← Back to MCP servers": "← MCP サーバーへ戻る",
  "This builtin MCP server cannot be deleted or disabled, and its name/URL are read-only. Token env and permission policy remain configurable.":
    "この組み込み MCP サーバーは削除または無効化できず、名前と URL は読み取り専用です。トークン環境変数と権限ポリシーは設定できます。",
  "Server settings": "サーバー設定",
  "Environment variables are checked on this dashboard process only.":
    "環境変数はこのダッシュボードプロセス上でのみ確認されます。",
  "Builtin server name is locked.": "組み込みサーバー名は固定されています。",
  "Changing the name updates mcp_server_name for future agent definitions.":
    "名前を変更すると、以後の agent 定義の mcp_server_name が更新されます。",
  "Builtin server URL is locked.": "組み込みサーバー URL は固定されています。",
  "HTTP(S) endpoint only.": "HTTP(S) エンドポイントのみ。",
  "Current process env:": "現在のプロセス環境変数:",
  "Builtin GitHub MCP uses GitHub App authorization; no environment variable is required.":
    "組み込み GitHub MCP は GitHub App 認可を使用するため、環境変数は不要です。",
  "No token env var configured; connection will be attempted unauthenticated.":
    "トークン環境変数は未設定です。接続は未認証で試行されます。",
  "MCP tool calls run automatically. Confirmation-based approval is not available yet.":
    "MCP ツール呼び出しは自動許可されます。確認ベースの承認はまだ利用できません。",
  Enabled: "有効",
  "Enabled servers are included in future parent/child agent definitions.":
    "有効なサーバーは今後の parent/child agent 定義に含まれます。",
  Metadata: "メタデータ",
  created: "作成日時",
  id: "ID",
  is: "は",
  "is loaded": "は読み込み済みです",
  "is missing": "は未設定です",
  "env loaded": "env 読み込み済み",
  "env missing": "env 未設定",
  "Saved with the same MCP server settings — no changes applied.":
    "同じ MCP サーバー設定で保存されました — 変更はありません。",
  "MCP server updated.": "MCP サーバーを更新しました。",
  "mcp server fields must be strings": "MCP サーバーフィールドは文字列である必要があります。",
  "valid mcp server id required": "有効な MCP サーバー ID が必要です。",
  "mcp server #{id} not found": "MCP サーバー #{id} が見つかりません。",
  "builtin MCP server cannot be deleted": "組み込み MCP サーバーは削除できません。",
  "builtin GitHub MCP server cannot be disabled":
    "組み込み GitHub MCP サーバーは無効化できません。",
  "invalid mcp server": "MCP サーバーが不正です。",
  'MCP permission policy "always_ask" is not supported until tool confirmations are implemented':
    'tool confirmation が実装されるまで、MCP 権限ポリシー "always_ask" は利用できません。',

  overview: "概要",
  usage: "使用量",
  "stop run": "実行を停止",
  "Requests cancellation through the run queue and waits for the run to stop.":
    "実行キュー経由でキャンセルを要求し、実行停止を待ちます。",
  "stop this run": "この実行を停止",
  sessions: "セッション",
  "sub issues": "サブ Issue",
  "session metrics": "セッションメトリクス",
  "no sessions recorded": "セッションはまだ記録されていません",
  events: "イベント",
  "tool calls": "ツール呼び出し",
  "tool errors": "ツールエラー",
  duration: "期間",
  "errors / calls": "エラー / 呼び出し",
  "model usage": "モデル使用量",
  requests: "リクエスト",
  "no sub issues created yet": "サブ Issue はまだ作成されていません",
  "live tail": "ライブテール",
  "no sessions to tail": "テール対象のセッションはありません",
  "live tail is unavailable: ANTHROPIC_API_KEY was not configured when starting":
    "ライブテールは利用できません: 起動時に ANTHROPIC_API_KEY が設定されていませんでした",
  "live tail requires JavaScript. Use": "ライブテールには JavaScript が必要です。",
  "on the CLI to inspect events from the terminal instead.":
    "を CLI に指定すると、代わりにターミナルからイベントを確認できます。",
  "click to start tailing": "クリックしてテール開始",
  start: "開始",
  stop: "停止",
  clear: "クリア",
  "raw stream": "raw stream",
  "live run": "ライブ実行",
  Error: "エラー",
  phases: "フェーズ",
  "live log": "ライブログ",
  "Failed to parse live event payload": "ライブイベント payload の解析に失敗しました",

  "prompt body": "プロンプト本文",
  "Add package": "パッケージを追加",
  "Add package spec": "パッケージ指定を追加",
  "Remove {name}": "{name} を削除",
  "Package specs must be 1-200 characters with no whitespace.":
    "パッケージ指定は 1〜200 文字で、空白を含められません。",
};

function interpolate(template: string, params?: TranslationParams): string {
  if (params === undefined) {
    return template;
  }

  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    const value = params[key];
    return value === undefined || value === null ? match : String(value);
  });
}

export function isLocale(value: string | undefined): value is Locale {
  return value === "en" || value === "ja";
}

export function currentLocale(): Locale {
  return i18nContext.getStore()?.locale ?? DEFAULT_LOCALE;
}

export function currentRequestPath(): string {
  return i18nContext.getStore()?.currentPath ?? "/";
}

export function withDashboardI18n<T>(context: I18nContext, callback: () => T): T {
  return i18nContext.run(context, callback);
}

export function t(text: string, params?: TranslationParams): string {
  const template = currentLocale() === "ja" ? (JA_TRANSLATIONS[text] ?? text) : text;
  return interpolate(template, params);
}

export function tPlural(
  count: number,
  singular: string,
  plural: string,
  params: TranslationParams = {},
): string {
  return t(count === 1 ? singular : plural, { count, ...params });
}

export function localeDisplayName(locale: Locale): string {
  return locale === "en" ? t("English") : t("Japanese");
}

export function localeSwitcherHref(locale: Locale): string {
  return `/locale/${locale}?next=${encodeURIComponent(currentRequestPath())}`;
}

export function localeFromCookieHeader(cookieHeader: string | undefined): Locale | null {
  if (cookieHeader === undefined || cookieHeader.length === 0) {
    return null;
  }

  for (const cookie of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = cookie.trim().split("=");
    if (rawName !== LOCALE_COOKIE_NAME) {
      continue;
    }

    let value: string;
    try {
      value = decodeURIComponent(rawValue.join("="));
    } catch {
      continue;
    }

    if (isLocale(value)) {
      return value;
    }
  }

  return null;
}

// Parses an RFC 9110 / RFC 4647 Accept-Language header and returns the highest
// priority entry whose primary subtag matches one of SUPPORTED_LOCALES. The
// qvalue ("q=...") is honored so that e.g. `en;q=0.8,ja;q=0.9` prefers `ja`.
// A wildcard tag (`*`) is intentionally ignored: callers should fall back to
// DEFAULT_LOCALE explicitly when no supported language is requested.
export function localeFromAcceptLanguageHeader(
  acceptLanguageHeader: string | undefined,
): Locale | null {
  if (acceptLanguageHeader === undefined || acceptLanguageHeader.length === 0) {
    return null;
  }

  type Entry = { locale: Locale; q: number; order: number };
  const entries: Entry[] = [];

  const parts = acceptLanguageHeader.split(",");
  for (let index = 0; index < parts.length; index += 1) {
    const part = (parts[index] ?? "").trim();
    if (part.length === 0) {
      continue;
    }

    const [tagRaw, ...paramsRaw] = part.split(";");
    const tag = (tagRaw ?? "").trim().toLowerCase();
    if (tag.length === 0 || tag === "*") {
      continue;
    }

    let q = 1;
    for (const param of paramsRaw) {
      const [rawName, rawValue] = param.split("=");
      if ((rawName ?? "").trim().toLowerCase() !== "q" || rawValue === undefined) {
        continue;
      }
      const parsed = Number(rawValue.trim());
      if (Number.isFinite(parsed)) {
        q = Math.min(1, Math.max(0, parsed));
      }
    }

    const primary = tag.split("-")[0];
    if (primary !== undefined && isLocale(primary)) {
      entries.push({ locale: primary, q, order: index });
    }
  }

  if (entries.length === 0) {
    return null;
  }

  entries.sort((a, b) => b.q - a.q || a.order - b.order);
  const top = entries[0];
  if (top === undefined || top.q <= 0) {
    return null;
  }
  return top.locale;
}

export function localeCookie(locale: Locale): string {
  return `${LOCALE_COOKIE_NAME}=${encodeURIComponent(
    locale,
  )}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
}

export function sanitizeLocaleRedirectPath(value: string | undefined): string {
  if (
    value === undefined ||
    value.length === 0 ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return "/";
  }

  return value;
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return relativeTime(seconds, "s", "秒");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return relativeTime(minutes, "m", "分");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relativeTime(hours, "h", "時間");
  const days = Math.floor(hours / 24);
  if (days < 30) return relativeTime(days, "d", "日");
  return new Date(iso).toISOString().slice(0, 10);
}

function relativeTime(count: number, englishUnit: string, japaneseUnit: string): string {
  return currentLocale() === "ja" ? `${count}${japaneseUnit}前` : `${count}${englishUnit} ago`;
}
