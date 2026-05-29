import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  BUILTIN_GITHUB_MCP_NAME,
  BUILTIN_GITHUB_MCP_TOKEN_ENV,
  GITHUB_MCP_URL,
} from "@/shared/constants";
import type { createLogger } from "@/shared/logging";
import type {
  EditablePromptKey,
  McpPermissionPolicy,
  PromptKey,
  PromptRevisionRow,
  PromptRevisionSource,
  PromptRow,
  RepoChatMessageRole,
  RepoChatMessageRow,
  RepoChatState,
  RepoChatThreadRow,
  RepoEnvironmentPackages,
  RepoEnvironmentRevisionRow,
  RepoEnvironmentRevisionSource,
  RepoEnvironmentRow,
  RepoPromptAgent,
  RepoPromptRevisionRow,
  RepoPromptRevisionSource,
  RepoPromptRow,
  SessionUsageRow,
} from "@/shared/persistence/schemas";
import {
  EditablePromptKeySchema,
  emptySessionUsage,
  emptyUsageAggregate,
  McpServerCreateInputSchema,
  McpServerNameSchema,
  McpServerRowSchema,
  McpServerUpdateInputSchema,
  PromptKeySchema,
  PromptRevisionRowSchema,
  PromptRevisionSourceSchema,
  PromptRowSchema,
  PromptSaveInputSchema,
  RepoChatMessageRowSchema,
  RepoChatStateSchema,
  RepoChatThreadRowSchema,
  RepoEnvironmentIdentifierSchema,
  RepoEnvironmentPackagesSchema,
  RepoEnvironmentRestoreInputSchema,
  RepoEnvironmentRevisionRowSchema,
  RepoEnvironmentRevisionSourceSchema,
  RepoEnvironmentRowSchema,
  RepoEnvironmentSaveInputSchema,
  RepoPromptAgentSchema,
  RepoPromptIdentifierSchema,
  RepoPromptRestoreInputSchema,
  RepoPromptRevisionRowSchema,
  RepoPromptRevisionSourceSchema,
  RepoPromptRowSchema,
  RepoPromptSaveInputSchema,
  RepoSlugSchema,
  RestoreInputSchema,
  RunEventKindSchema,
  RunEventSchema,
  RunPhaseSchema,
  RunStateSchema,
  RunStatusSchema,
  RunSummarySchema,
  SessionResultSchema,
  SessionUsageRowSchema,
  SubIssueSchema,
  type UsageAggregate,
  UsageAggregateSchema,
} from "@/shared/persistence/schemas";
import { calculateCostUsd } from "@/shared/pricing";
import {
  fallbackRunOrigin,
  githubIssueOrigin,
  linearIssueOrigin,
  type RunOrigin,
} from "@/shared/run-origin";
import type { SessionResult } from "@/shared/session";
import type {
  RunEvent,
  RunEventKind,
  RunPhase,
  RunState,
  RunStatus,
  RunSummary,
} from "@/shared/types";

type DbLogger = Pick<ReturnType<typeof createLogger>, "warn">;

type StatementLike<Row = unknown, Params extends unknown[] = unknown[]> = {
  all(...params: Params): Row[];
  get(...params: Params): Row | null | undefined;
  run(...params: Params): unknown;
};

type DatabaseLike = {
  close(): void;
  exec(sql: string): void;
  query<Row = unknown, Params extends unknown[] = unknown[]>(
    sql: string,
  ): StatementLike<Row, Params>;
  transaction<Args extends unknown[]>(callback: (...args: Args) => void): (...args: Args) => void;
};

type DatabaseConstructor = new (databasePath: string) => DatabaseLike;

const require = createRequire(import.meta.url);
const { Database } = require("bun:sqlite") as { Database: DatabaseConstructor };

const DEFAULT_DB_PATH = ".github-issue-agent/dashboard.db";
const DEFAULT_LIST_RUNS_LIMIT = 100;
const RUN_ID_SCHEMA = RunStateSchema.shape.runId;
const REPO_SCHEMA = RunStateSchema.shape.repo;
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    issue_number INTEGER,
    branch TEXT,
    started_at TEXT,
    pr_url TEXT,
    vault_id TEXT,
    pid INTEGER,
    origin_type TEXT NOT NULL DEFAULT 'github_issue',
    origin_identifier TEXT,
    origin_url TEXT,
    origin_title TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    phase TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    events_processed INTEGER,
    tool_invocations INTEGER,
    tool_errors INTEGER,
    duration_ms INTEGER,
    aborted INTEGER,
    errored INTEGER,
    idle_reached INTEGER,
    timed_out INTEGER,
    last_event_id TEXT
  );
  CREATE TABLE IF NOT EXISTS session_usage (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
    model_request_count INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, model)
  );
  CREATE INDEX IF NOT EXISTS idx_session_usage_session ON session_usage(session_id);
  CREATE TABLE IF NOT EXISTS run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sub_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    issue_id INTEGER NOT NULL,
    issue_number INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prompts (
    prompt_key TEXT PRIMARY KEY,
    current_revision_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prompt_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_key TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('seed','edit','restore'))
  );
  CREATE TABLE IF NOT EXISTS repo_prompts (
    repo TEXT NOT NULL,
    agent TEXT NOT NULL CHECK(agent IN ('parent','child')),
    current_revision_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo, agent)
  );
  CREATE TABLE IF NOT EXISTS repo_prompt_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    agent TEXT NOT NULL CHECK(agent IN ('parent','child')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('edit','restore'))
  );
  CREATE INDEX IF NOT EXISTS idx_runs_repo ON runs(repo);
  CREATE INDEX IF NOT EXISTS idx_sessions_run ON sessions(run_id);
  CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);
  CREATE INDEX IF NOT EXISTS idx_sub_issues_run ON sub_issues(run_id);
  CREATE INDEX IF NOT EXISTS idx_prompt_revisions_key ON prompt_revisions(prompt_key, id DESC);
  CREATE INDEX IF NOT EXISTS idx_prompt_revisions_sha ON prompt_revisions(prompt_key, body_sha256);
  CREATE INDEX IF NOT EXISTS idx_repo_prompt_revisions_target
    ON repo_prompt_revisions(repo, agent, id DESC);
  CREATE INDEX IF NOT EXISTS idx_repo_prompt_revisions_sha
    ON repo_prompt_revisions(repo, agent, body_sha256);
  CREATE TABLE IF NOT EXISTS repo_environments (
    repo TEXT PRIMARY KEY,
    environment_id TEXT,
    definition_hash TEXT,
    current_revision_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS repo_environment_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    packages TEXT NOT NULL,
    created_at TEXT NOT NULL,
    packages_sha256 TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('edit','restore'))
  );
  CREATE INDEX IF NOT EXISTS idx_repo_environment_revisions_target
    ON repo_environment_revisions(repo, id DESC);
  CREATE INDEX IF NOT EXISTS idx_repo_environment_revisions_sha
    ON repo_environment_revisions(repo, packages_sha256);
  CREATE INDEX IF NOT EXISTS idx_repo_prompts_repo ON repo_prompts(repo);
  CREATE TABLE IF NOT EXISTS github_trigger_dedupe (
    dedupe_key TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('comment','label')),
    source_id TEXT NOT NULL,
    run_id TEXT,
    processed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gh_trigger_dedupe_repo
    ON github_trigger_dedupe(repo, processed_at DESC);
  CREATE TABLE IF NOT EXISTS polled_repositories (
    repo TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_polled_repositories_enabled
    ON polled_repositories(enabled);
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    token_env_name TEXT NOT NULL DEFAULT '',
    permission_policy TEXT NOT NULL DEFAULT 'always_allow'
      CHECK(permission_policy IN ('always_allow','always_ask')),
    enabled INTEGER NOT NULL DEFAULT 1,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled
    ON mcp_servers(enabled);
  CREATE TABLE IF NOT EXISTS repo_chat_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    agent_id TEXT,
    agent_version INTEGER,
    agent_definition_hash TEXT,
    environment_id TEXT,
    environment_definition_hash TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS repo_chat_threads (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_repo_chat_threads_repo
    ON repo_chat_threads(repo, updated_at DESC);
  CREATE TABLE IF NOT EXISTS repo_chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES repo_chat_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_repo_chat_messages_thread
    ON repo_chat_messages(thread_id, created_at ASC);
`;

type RunRow = {
  runId: string;
  repo: string;
  issueNumber: number | null;
  branch: string | null;
  startedAt: string | null;
  prUrl: string | null;
  vaultId: string | null;
  pid: number | null;
  originType: string | null;
  originIdentifier: string | null;
  originUrl: string | null;
  originTitle: string | null;
};

type RunsTableColumnRow = {
  name: string;
};

type RunSummaryRow = {
  branch: string | null;
  issueNumber: number | null;
  originType: string | null;
  originIdentifier: string | null;
  originUrl: string | null;
  originTitle: string | null;
  phase: string | null;
  prUrl: string | null;
  repo: string;
  runId: string;
  startedAt: string | null;
  status: string;
};

type RunStatusRow = {
  status: string;
};

type RunEventRow = {
  id: string;
  runId: string;
  ts: string;
  kind: string;
  payload: string;
};

type RunEventOrder = "asc" | "desc";

type StatementRunResult = {
  changes?: number;
};

type SessionRow = {
  sessionId: string;
  runId: string;
  eventsProcessed: number;
  toolInvocations: number;
  toolErrors: number;
  durationMs: number;
  aborted: number;
  errored: number;
  idleReached: number;
  timedOut: number;
  lastEventId: string | null;
};

type SubIssueRow = {
  taskId: string;
  issueId: number;
  issueNumber: number;
};

type RepositorySummaryRow = {
  repo: string;
  runCount: number;
  lastRunAt: string | null;
};

type SessionUsageDbRow = {
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  modelRequestCount: number;
  costUsd: number;
};

type UsageAggregateDbRow = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  modelRequestCount: number | null;
  costUsd: number | null;
};

type RepoUsageAggregateDbRow = UsageAggregateDbRow & {
  repo: string;
};

type RunUsageAggregateDbRow = UsageAggregateDbRow & {
  runId: string;
};

type PromptWithBodyRow = PromptRow & {
  body: string;
};

type PromptCurrentRevisionRow = PromptRevisionRow & {
  currentRevisionId: number;
  updatedAt: string;
};

type PromptSavePublicInput = {
  body: string;
  key: EditablePromptKey;
  source: "edit" | "seed";
};

type PromptSaveTransactionInput = {
  allowDuplicateBody: boolean;
  body: string;
  bodySha256: string;
  key: EditablePromptKey;
  now: string;
  source: PromptRevisionSource;
};

type PromptSaveResult = {
  isNoChange: boolean;
  revisionId: number;
};

type PromptRestoreTransactionInput = {
  key: EditablePromptKey;
  revisionId: number;
  now: string;
};

type PromptRestoreResult = {
  alreadyCurrent: boolean;
  newRevisionId: number;
};

type PromptSeedTransactionInput = {
  body: string;
  bodySha256: string;
  key: PromptKey;
  now: string;
  source: PromptRevisionSource;
};

type PromptSeedResult = {
  seeded: boolean;
};

type RepoEnvironmentWithPackagesJsonRow = RepoEnvironmentRow & {
  packages: string;
};

type RepoEnvironmentRevisionJsonRow = Omit<RepoEnvironmentRevisionRow, "packages"> & {
  packages: string;
};

type RepoEnvironmentCurrentRevisionJsonRow = RepoEnvironmentRevisionJsonRow & {
  currentRevisionId: number;
  definitionHash: string | null;
  environmentId: string | null;
  updatedAt: string;
};

type RepoEnvironmentCurrentRevision = RepoEnvironmentRevisionRow & {
  currentRevisionId: number;
  definitionHash: string | null;
  environmentId: string | null;
  updatedAt: string;
};

type RepoEnvironmentSaveTransactionInput = {
  allowDuplicatePackages: boolean;
  now: string;
  packagesJson: string;
  packagesSha256: string;
  repo: string;
  source: RepoEnvironmentRevisionSource;
};

type RepoEnvironmentSaveResult = {
  isNoChange: boolean;
  revisionId: number;
};

type RepoEnvironmentRestoreTransactionInput = {
  now: string;
  repo: string;
  revisionId: number;
};

type RepoEnvironmentRestoreResult = {
  alreadyCurrent: boolean;
  newRevisionId: number;
};

type RepoEnvironmentOverrideSummaryRow = {
  repo: string;
  environmentId: string | null;
  definitionHash: string | null;
  currentRevisionId: number;
  revisionCount: number;
  updatedAt: string;
};

type RepoPromptWithBodyRow = RepoPromptRow & {
  body: string;
};

type RepoPromptCurrentRevisionRow = RepoPromptRevisionRow & {
  currentRevisionId: number;
  updatedAt: string;
};

type RepoPromptSaveTransactionInput = {
  agent: RepoPromptAgent;
  allowDuplicateBody: boolean;
  body: string;
  bodySha256: string;
  now: string;
  repo: string;
  source: RepoPromptRevisionSource;
};

type RepoPromptSaveResult = {
  isNoChange: boolean;
  revisionId: number;
};

type RepoPromptRestoreTransactionInput = {
  agent: RepoPromptAgent;
  now: string;
  repo: string;
  revisionId: number;
};

type RepoPromptRestoreResult = {
  alreadyCurrent: boolean;
  newRevisionId: number;
};

type RepoPromptOverrideSummaryRow = {
  repo: string;
  agent: RepoPromptAgent;
  currentRevisionId: number;
  updatedAt: string;
  revisionCount: number;
};

export type GithubTriggerSource = "comment" | "label";

const GITHUB_TRIGGER_SOURCES: ReadonlySet<GithubTriggerSource> = new Set(["comment", "label"]);

function parseGithubTriggerSource(value: string): GithubTriggerSource {
  if (!GITHUB_TRIGGER_SOURCES.has(value as GithubTriggerSource)) {
    throw new Error(`invalid github trigger source: ${value}`);
  }

  return value as GithubTriggerSource;
}

export type PolledRepository = {
  addedAt: string;
  enabled: boolean;
  repo: string;
  updatedAt: string;
};

type PolledRepositoryRow = {
  addedAt: string;
  enabled: number;
  repo: string;
  updatedAt: string;
};

// Public MCP server row exposed by the db module. Booleans are normalized
// from SQLite's INTEGER storage.
export type McpServer = {
  id: number;
  name: string;
  url: string;
  /** Blank means this remote MCP server is used without a bearer-token credential. */
  tokenEnvName: string;
  permissionPolicy: McpPermissionPolicy;
  enabled: boolean;
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
};

// Raw SQLite row. `enabled` / `is_builtin` are stored as 0/1.
type McpServerDbRow = {
  id: number;
  name: string;
  url: string;
  tokenEnvName: string;
  permissionPolicy: string;
  enabled: number;
  isBuiltin: number;
  createdAt: string;
  updatedAt: string;
};

type RepoChatStateDbRow = {
  agentDefinitionHash: string | null;
  agentId: string | null;
  agentVersion: number | null;
  environmentDefinitionHash: string | null;
  environmentId: string | null;
  updatedAt: string;
};

type RepoChatThreadSummaryRow = {
  lastChatAt: string | null;
  repo: string;
  threadCount: number;
};

type PreparedStatements = {
  deleteSubIssuesByRun: StatementLike<unknown, [string]>;
  getPromptByKey: StatementLike<PromptWithBodyRow, [PromptKey]>;
  getPromptCurrentRevisionByKey: StatementLike<PromptCurrentRevisionRow, [PromptKey]>;
  getPromptRevisionByKeyAndId: StatementLike<PromptRevisionRow, [PromptKey, number]>;
  getPromptRevisionsByKey: StatementLike<PromptRevisionRow, [PromptKey]>;
  getPromptRowByKey: StatementLike<PromptRow, [PromptKey]>;
  getRunById: StatementLike<RunRow, [string]>;
  getRunStatus: StatementLike<RunStatusRow, [string]>;
  getRunsByRepo: StatementLike<RunRow, [string]>;
  insertRunEvent: StatementLike<unknown, [string, string, string, RunEventKind, string]>;
  getSessionIdsByRun: StatementLike<{ sessionId: string }, [string]>;
  getSessionsByRun: StatementLike<SessionRow, [string]>;
  getSubIssuesByRun: StatementLike<SubIssueRow, [string]>;
  insertPrompt: StatementLike<unknown, [PromptKey, number, string]>;
  insertPromptRevision: StatementLike<
    { id: number },
    [PromptKey, string, string, string, PromptRevisionSource]
  >;
  insertRun: StatementLike<
    unknown,
    [
      string,
      string,
      number | null,
      string,
      string,
      string | null,
      string | null,
      number | null,
      string,
      string | null,
      string | null,
      string | null,
    ]
  >;
  insertSession: StatementLike<
    unknown,
    [string, string, number, number, number, number, number, number, number, number, string | null]
  >;
  insertSessionUsage: StatementLike<
    unknown,
    [string, string, number, number, number, number, number, number]
  >;
  deleteSessionUsageBySession: StatementLike<unknown, [string]>;
  getSessionUsageBySession: StatementLike<SessionUsageDbRow, [string]>;
  getSessionUsagesByRun: StatementLike<SessionUsageDbRow, [string]>;
  aggregateUsageByRun: StatementLike<UsageAggregateDbRow, [string]>;
  aggregateUsageByRepo: StatementLike<UsageAggregateDbRow, [string]>;
  aggregateUsageGlobal: StatementLike<UsageAggregateDbRow, []>;
  aggregateUsageByRepoAll: StatementLike<RepoUsageAggregateDbRow, []>;
  aggregateUsageByAllRuns: StatementLike<RunUsageAggregateDbRow, []>;
  insertSubIssue: StatementLike<unknown, [string, string, number, number]>;
  listRepositories: StatementLike<RepositorySummaryRow, []>;
  listRuns: StatementLike<RunSummaryRow, [number]>;
  listRunsByRepo: StatementLike<RunSummaryRow, [string, number]>;
  listRunsByStatus: StatementLike<RunSummaryRow, [RunStatus, number]>;
  listRunsByStatusAndRepo: StatementLike<RunSummaryRow, [RunStatus, string, number]>;
  listRunEvents: StatementLike<RunEventRow, [string, number]>;
  listRunEventsAfter: StatementLike<RunEventRow, [string, string, number]>;
  listRunEventsDesc: StatementLike<RunEventRow, [string, number]>;
  listRunEventsAfterDesc: StatementLike<RunEventRow, [string, string, number]>;
  resyncOrphanedRuns: StatementLike<unknown, []>;
  setRunPhase: StatementLike<unknown, [RunPhase | null, string]>;
  setRunStatus: StatementLike<unknown, [RunStatus, string]>;
  upsertPrompt: StatementLike<unknown, [PromptKey, number, string]>;
  // Repo environments
  deleteRepoEnvironmentByRepo: StatementLike<unknown, [string]>;
  deleteRepoEnvironmentRevisionsByRepo: StatementLike<unknown, [string]>;
  getRepoEnvironmentByRepo: StatementLike<RepoEnvironmentWithPackagesJsonRow, [string]>;
  getRepoEnvironmentCurrentRevisionByRepo: StatementLike<
    RepoEnvironmentCurrentRevisionJsonRow,
    [string]
  >;
  getRepoEnvironmentRevisionByRepoAndId: StatementLike<
    RepoEnvironmentRevisionJsonRow,
    [string, number]
  >;
  getRepoEnvironmentRevisionsByRepo: StatementLike<RepoEnvironmentRevisionJsonRow, [string]>;
  getRepoEnvironmentRowByRepo: StatementLike<RepoEnvironmentRow, [string]>;
  insertRepoEnvironment: StatementLike<unknown, [string, number, string]>;
  insertRepoEnvironmentRevision: StatementLike<
    { id: number },
    [string, string, string, string, RepoEnvironmentRevisionSource]
  >;
  listRepoEnvironmentOverrides: StatementLike<RepoEnvironmentOverrideSummaryRow, []>;
  listRepoEnvironmentOverridesByRepo: StatementLike<RepoEnvironmentOverrideSummaryRow, [string]>;
  setRepoEnvironmentAnthropicState: StatementLike<unknown, [string, string, string, string]>;
  upsertRepoEnvironment: StatementLike<unknown, [string, number, string]>;
  // Repo prompts
  deleteRepoPromptByKey: StatementLike<unknown, [string, RepoPromptAgent]>;
  deleteRepoPromptRevisionsByKey: StatementLike<unknown, [string, RepoPromptAgent]>;
  getRepoPromptByKey: StatementLike<RepoPromptWithBodyRow, [string, RepoPromptAgent]>;
  getRepoPromptCurrentRevisionByKey: StatementLike<
    RepoPromptCurrentRevisionRow,
    [string, RepoPromptAgent]
  >;
  getRepoPromptRevisionByKeyAndId: StatementLike<
    RepoPromptRevisionRow,
    [string, RepoPromptAgent, number]
  >;
  getRepoPromptRevisionsByKey: StatementLike<RepoPromptRevisionRow, [string, RepoPromptAgent]>;
  getRepoPromptRowByKey: StatementLike<RepoPromptRow, [string, RepoPromptAgent]>;
  insertRepoPrompt: StatementLike<unknown, [string, RepoPromptAgent, number, string]>;
  insertRepoPromptRevision: StatementLike<
    { id: number },
    [string, RepoPromptAgent, string, string, string, RepoPromptRevisionSource]
  >;
  listRepoPromptOverrides: StatementLike<RepoPromptOverrideSummaryRow, []>;
  listRepoPromptOverridesByRepo: StatementLike<RepoPromptOverrideSummaryRow, [string]>;
  upsertRepoPrompt: StatementLike<unknown, [string, RepoPromptAgent, number, string]>;
  // GitHub trigger dedupe
  countGithubTriggerDedupe: StatementLike<{ count: number }, [string]>;
  insertGithubTriggerDedupe: StatementLike<
    unknown,
    [string, string, number, GithubTriggerSource, string, string | null, string]
  >;
  // Polled repositories (auto-trigger targets configured via the WebUI)
  deletePolledRepository: StatementLike<unknown, [string]>;
  getPolledRepository: StatementLike<PolledRepositoryRow, [string]>;
  listPolledRepositories: StatementLike<PolledRepositoryRow, []>;
  listEnabledPolledRepositories: StatementLike<PolledRepositoryRow, []>;
  setPolledRepositoryEnabled: StatementLike<unknown, [number, string, string]>;
  upsertPolledRepository: StatementLike<unknown, [string, number, string, string]>;
  // MCP servers (configurable from the WebUI)
  deleteMcpServer: StatementLike<unknown, [number]>;
  getMcpServerById: StatementLike<McpServerDbRow, [number]>;
  getMcpServerByName: StatementLike<McpServerDbRow, [string]>;
  insertMcpServer: StatementLike<
    { id: number },
    [string, string, string, McpPermissionPolicy, number, number, string, string]
  >;
  listMcpServers: StatementLike<McpServerDbRow, []>;
  listEnabledMcpServers: StatementLike<McpServerDbRow, []>;
  setMcpServerEnabled: StatementLike<unknown, [number, string, number]>;
  updateMcpServer: StatementLike<
    unknown,
    [string, string, string, McpPermissionPolicy, number, string, number]
  >;
  updateBuiltinMcpServer: StatementLike<
    unknown,
    [string, McpPermissionPolicy, number, string, number]
  >;
  // Repository chat
  getRepoChatState: StatementLike<RepoChatStateDbRow, []>;
  upsertRepoChatAgentState: StatementLike<unknown, [string, number, string, string]>;
  upsertRepoChatEnvironmentState: StatementLike<unknown, [string, string, string]>;
  getRepoChatThreadById: StatementLike<RepoChatThreadRow, [string]>;
  insertRepoChatThread: StatementLike<unknown, [string, string, string, string, string]>;
  listRepoChatRepositories: StatementLike<RepoChatThreadSummaryRow, []>;
  listRepoChatThreadsByRepo: StatementLike<RepoChatThreadRow, [string, number]>;
  touchRepoChatThread: StatementLike<unknown, [string, string]>;
  insertRepoChatMessage: StatementLike<
    unknown,
    [string, string, RepoChatMessageRole, string, string | null, string]
  >;
  listRepoChatMessagesByThread: StatementLike<RepoChatMessageRow, [string]>;
};

type PreparedRuntime = {
  replaceRunAndSubIssues: (run: RunState) => void;
  restorePromptToRevisionTransaction: (
    input: PromptRestoreTransactionInput,
    setResult: (result: PromptRestoreResult) => void,
  ) => void;
  savePromptRevisionTransaction: (
    input: PromptSaveTransactionInput,
    setResult: (result: PromptSaveResult) => void,
  ) => void;
  saveRepoEnvironmentRevisionTransaction: (
    input: RepoEnvironmentSaveTransactionInput,
    setResult: (result: RepoEnvironmentSaveResult) => void,
  ) => void;
  restoreRepoEnvironmentToRevisionTransaction: (
    input: RepoEnvironmentRestoreTransactionInput,
    setResult: (result: RepoEnvironmentRestoreResult) => void,
  ) => void;
  deleteRepoEnvironmentTransaction: (
    input: { repo: string },
    setResult: (result: { deleted: boolean }) => void,
  ) => void;
  saveRepoPromptRevisionTransaction: (
    input: RepoPromptSaveTransactionInput,
    setResult: (result: RepoPromptSaveResult) => void,
  ) => void;
  restoreRepoPromptToRevisionTransaction: (
    input: RepoPromptRestoreTransactionInput,
    setResult: (result: RepoPromptRestoreResult) => void,
  ) => void;
  deleteRepoPromptTransaction: (
    input: { agent: RepoPromptAgent; repo: string },
    setResult: (result: { deleted: boolean }) => void,
  ) => void;
  seedPromptIfMissingTransaction: (
    input: PromptSeedTransactionInput,
    setResult: (result: PromptSeedResult) => void,
  ) => void;
  statements: PreparedStatements;
};

export type DbModuleDependencies = {
  cwd: () => string;
  logger?: DbLogger;
  openDatabase: (databasePath: string) => DatabaseLike;
};

function resolveDatabasePath(databasePath: string | undefined, cwd: string): string {
  if (databasePath === ":memory:") {
    return databasePath;
  }

  return resolve(cwd, databasePath ?? DEFAULT_DB_PATH);
}

function normalizePromptBody(body: string): string {
  return body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function hashPromptBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function canonicalizePackages(packages: RepoEnvironmentPackages): string {
  const parsedPackages = RepoEnvironmentPackagesSchema.parse(packages);
  const canonicalPackages: Record<string, string[]> = {};

  for (const manager of Object.keys(parsedPackages).sort() as Array<
    keyof RepoEnvironmentPackages
  >) {
    canonicalPackages[manager] = [...parsedPackages[manager]].sort();
  }

  return JSON.stringify(canonicalPackages);
}

function hashPackagesJson(json: string): string {
  return createHash("sha256").update(json).digest("hex");
}

function parsePromptWithBody(row: PromptWithBodyRow): {
  body: string;
  currentRevisionId: number;
  promptKey: PromptKey;
  updatedAt: string;
} {
  const promptRow = PromptRowSchema.parse(row);

  return {
    body: PromptRevisionRowSchema.shape.body.parse(row.body),
    currentRevisionId: promptRow.currentRevisionId,
    promptKey: promptRow.promptKey,
    updatedAt: promptRow.updatedAt,
  };
}

function parsePromptCurrentRevision(row: PromptCurrentRevisionRow): PromptCurrentRevisionRow {
  const revisionRow = PromptRevisionRowSchema.parse(row);
  const promptRow = PromptRowSchema.parse(row);

  return {
    ...revisionRow,
    currentRevisionId: promptRow.currentRevisionId,
    updatedAt: promptRow.updatedAt,
  };
}

function parseInsertedPromptRevisionId(row: { id: number } | null | undefined): number {
  if (row == null) {
    throw new Error("Failed to insert prompt revision");
  }

  return PromptRevisionRowSchema.shape.id.parse(row.id);
}

function parseInsertedRepoEnvironmentRevisionId(row: { id: number } | null | undefined): number {
  if (row == null) {
    throw new Error("Failed to insert repo environment revision");
  }

  return RepoEnvironmentRevisionRowSchema.shape.id.parse(row.id);
}

function parseInsertedRepoPromptRevisionId(row: { id: number } | null | undefined): number {
  if (row == null) {
    throw new Error("Failed to insert repo prompt revision");
  }

  return RepoPromptRevisionRowSchema.shape.id.parse(row.id);
}

function parseRepoEnvironmentRevisionJsonRow(
  row: RepoEnvironmentRevisionJsonRow,
): RepoEnvironmentRevisionRow {
  return RepoEnvironmentRevisionRowSchema.parse({
    ...row,
    packages: JSON.parse(row.packages),
  });
}

function parseRepoEnvironmentWithPackages(row: RepoEnvironmentWithPackagesJsonRow): {
  currentRevisionId: number;
  definitionHash: string | null;
  environmentId: string | null;
  packages: RepoEnvironmentPackages;
  repo: string;
  updatedAt: string;
} {
  const environmentRow = RepoEnvironmentRowSchema.parse(row);

  return {
    currentRevisionId: environmentRow.currentRevisionId,
    definitionHash: environmentRow.definitionHash,
    environmentId: environmentRow.environmentId,
    packages: RepoEnvironmentPackagesSchema.parse(JSON.parse(row.packages)),
    repo: environmentRow.repo,
    updatedAt: environmentRow.updatedAt,
  };
}

function parseRepoEnvironmentCurrentRevision(
  row: RepoEnvironmentCurrentRevisionJsonRow,
): RepoEnvironmentCurrentRevision {
  const revisionRow = parseRepoEnvironmentRevisionJsonRow(row);
  const environmentRow = RepoEnvironmentRowSchema.parse(row);

  return {
    ...revisionRow,
    currentRevisionId: environmentRow.currentRevisionId,
    definitionHash: environmentRow.definitionHash,
    environmentId: environmentRow.environmentId,
    updatedAt: environmentRow.updatedAt,
  };
}

function parseRepoPromptWithBody(row: RepoPromptWithBodyRow): {
  agent: RepoPromptAgent;
  body: string;
  currentRevisionId: number;
  repo: string;
  updatedAt: string;
} {
  const promptRow = RepoPromptRowSchema.parse(row);

  return {
    agent: promptRow.agent,
    body: RepoPromptRevisionRowSchema.shape.body.parse(row.body),
    currentRevisionId: promptRow.currentRevisionId,
    repo: promptRow.repo,
    updatedAt: promptRow.updatedAt,
  };
}

function parseRepoPromptCurrentRevision(
  row: RepoPromptCurrentRevisionRow,
): RepoPromptCurrentRevisionRow {
  const revisionRow = RepoPromptRevisionRowSchema.parse(row);
  const promptRow = RepoPromptRowSchema.parse(row);

  return {
    ...revisionRow,
    currentRevisionId: promptRow.currentRevisionId,
    updatedAt: promptRow.updatedAt,
  };
}

function normalizeListRunsLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIST_RUNS_LIMIT;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("listRuns limit must be a positive integer");
  }

  return limit;
}

function normalizeRunEventsLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return -1;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("listRunEvents limit must be a positive integer");
  }

  return limit;
}

function normalizeRunEventsOrder(order: RunEventOrder | undefined): RunEventOrder {
  if (order === undefined) {
    return "asc";
  }

  if (order !== "asc" && order !== "desc") {
    throw new Error("listRunEvents order must be 'asc' or 'desc'");
  }

  return order;
}

function stringifyRunEventPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);

  if (serialized === undefined) {
    throw new Error("run event payload must be JSON-serializable");
  }

  return serialized;
}

function parseRunEventRow(row: RunEventRow): RunEvent {
  const parsedEvent = RunEventSchema.parse({
    id: row.id,
    kind: RunEventKindSchema.parse(row.kind),
    payload: JSON.parse(row.payload),
    runId: row.runId,
    ts: row.ts,
  });

  return {
    id: parsedEvent.id,
    kind: parsedEvent.kind,
    payload: parsedEvent.payload,
    runId: parsedEvent.runId,
    ts: parsedEvent.ts,
  };
}

function readChanges(result: unknown): number {
  const maybeResult = result as StatementRunResult | undefined;

  return maybeResult?.changes ?? 0;
}

function parseRunSummaryRow(row: RunSummaryRow): RunSummary {
  const origin = hydrateRunOrigin(row);

  return RunSummarySchema.parse({
    branch: row.branch ?? undefined,
    issueNumber: row.issueNumber,
    ...(origin ? { origin } : {}),
    phase: row.phase ?? undefined,
    prUrl: row.prUrl ?? undefined,
    repo: row.repo,
    runId: row.runId,
    startedAt: row.startedAt,
    status: row.status,
  });
}

function hydrateRunOrigin(row: {
  issueNumber: number | null;
  originIdentifier: string | null;
  originTitle: string | null;
  originType: string | null;
  originUrl: string | null;
  repo: string;
}): RunOrigin | undefined {
  if (row.originType === "linear_issue") {
    if (!row.originIdentifier) {
      return undefined;
    }

    return linearIssueOrigin({
      identifier: row.originIdentifier,
      title: row.originTitle,
      url: row.originUrl,
    });
  }

  if (row.issueNumber === null) {
    return undefined;
  }

  return githubIssueOrigin({
    issueNumber: row.issueNumber,
    repo: row.repo,
    title: row.originTitle,
    url: row.originUrl,
  });
}

function runOriginPersistenceFields(run: RunState): {
  originIdentifier: string | null;
  originTitle: string | null;
  originType: string;
  originUrl: string | null;
} {
  const origin = fallbackRunOrigin(run);

  if (origin?.type === "linear_issue") {
    return {
      originIdentifier: origin.identifier,
      originTitle: origin.title ?? null,
      originType: origin.type,
      originUrl: origin.url ?? null,
    };
  }

  if (origin?.type === "github_issue") {
    return {
      originIdentifier: null,
      originTitle: origin.title ?? null,
      originType: origin.type,
      originUrl: origin.url ?? null,
    };
  }

  return {
    originIdentifier: null,
    originTitle: null,
    originType: "github_issue",
    originUrl: null,
  };
}

export function createDbModule(dbPath?: string, overrides: Partial<DbModuleDependencies> = {}) {
  const dependencies: DbModuleDependencies = {
    cwd: () => process.cwd(),
    openDatabase: (databasePath) => new Database(databasePath),
    ...overrides,
  };
  const db = dependencies.openDatabase(resolveDatabasePath(dbPath, dependencies.cwd()));
  let runtime: PreparedRuntime | null = null;

  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");

  function hasRunsColumn(name: string): boolean {
    return (
      db
        .query<RunsTableColumnRow, [string]>(
          "SELECT name FROM pragma_table_info('runs') WHERE name = ?1",
        )
        .get(name) != null
    );
  }

  function migrateRunsAddColumn(name: string, sql: string): void {
    if (hasRunsColumn(name)) {
      return;
    }

    db.exec(sql);
  }

  function migrateRunsColumns(): void {
    migrateRunsAddColumn(
      "status",
      "ALTER TABLE runs ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'",
    );
    migrateRunsAddColumn("phase", "ALTER TABLE runs ADD COLUMN phase TEXT");
    migrateRunsAddColumn("pid", "ALTER TABLE runs ADD COLUMN pid INTEGER");
    migrateRunsAddColumn(
      "origin_type",
      "ALTER TABLE runs ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'github_issue'",
    );
    migrateRunsAddColumn("origin_identifier", "ALTER TABLE runs ADD COLUMN origin_identifier TEXT");
    migrateRunsAddColumn("origin_url", "ALTER TABLE runs ADD COLUMN origin_url TEXT");
    migrateRunsAddColumn("origin_title", "ALTER TABLE runs ADD COLUMN origin_title TEXT");
  }

  function getRuntime(): PreparedRuntime {
    if (runtime !== null) {
      return runtime;
    }

    db.exec(SCHEMA_SQL);
    migrateRunsColumns();

    const statements: PreparedStatements = {
      deleteSubIssuesByRun: db.query("DELETE FROM sub_issues WHERE run_id = ?1"),
      getPromptByKey: db.query<PromptWithBodyRow, [PromptKey]>(
        `SELECT
           p.prompt_key AS promptKey,
           p.current_revision_id AS currentRevisionId,
           r.body,
           p.updated_at AS updatedAt
         FROM prompts p
         JOIN prompt_revisions r
           ON r.id = p.current_revision_id
          AND r.prompt_key = p.prompt_key
         WHERE p.prompt_key = ?1`,
      ),
      getPromptCurrentRevisionByKey: db.query<PromptCurrentRevisionRow, [PromptKey]>(
        `SELECT
           r.id,
           r.prompt_key AS promptKey,
           r.body,
           r.created_at AS createdAt,
           r.body_sha256 AS bodySha256,
           r.source,
           p.current_revision_id AS currentRevisionId,
           p.updated_at AS updatedAt
         FROM prompts p
         JOIN prompt_revisions r
           ON r.id = p.current_revision_id
          AND r.prompt_key = p.prompt_key
         WHERE p.prompt_key = ?1`,
      ),
      getPromptRevisionByKeyAndId: db.query<PromptRevisionRow, [PromptKey, number]>(
        `SELECT
           id,
           prompt_key AS promptKey,
           body,
           created_at AS createdAt,
           body_sha256 AS bodySha256,
           source
         FROM prompt_revisions
         WHERE prompt_key = ?1
           AND id = ?2`,
      ),
      getPromptRevisionsByKey: db.query<PromptRevisionRow, [PromptKey]>(
        `SELECT
           id,
           prompt_key AS promptKey,
           body,
           created_at AS createdAt,
           body_sha256 AS bodySha256,
           source
         FROM prompt_revisions
         WHERE prompt_key = ?1
         ORDER BY id DESC`,
      ),
      getPromptRowByKey: db.query<PromptRow, [PromptKey]>(
        `SELECT
           prompt_key AS promptKey,
           current_revision_id AS currentRevisionId,
           updated_at AS updatedAt
         FROM prompts
         WHERE prompt_key = ?1`,
      ),
      getRunById: db.query<RunRow, [string]>(
        `SELECT
           run_id AS runId,
           repo,
           issue_number AS issueNumber,
           branch,
           started_at AS startedAt,
           pr_url AS prUrl,
           vault_id AS vaultId,
           pid,
           origin_type AS originType,
           origin_identifier AS originIdentifier,
           origin_url AS originUrl,
           origin_title AS originTitle
         FROM runs
         WHERE run_id = ?1`,
      ),
      getRunStatus: db.query<RunStatusRow, [string]>(
        `SELECT status
         FROM runs
         WHERE run_id = ?1`,
      ),
      getRunsByRepo: db.query<RunRow, [string]>(
        `SELECT
           run_id AS runId,
           repo,
           issue_number AS issueNumber,
           branch,
           started_at AS startedAt,
           pr_url AS prUrl,
           vault_id AS vaultId,
           pid,
           origin_type AS originType,
           origin_identifier AS originIdentifier,
           origin_url AS originUrl,
           origin_title AS originTitle
         FROM runs
         WHERE repo = ?1
         ORDER BY started_at DESC`,
      ),
      getSessionIdsByRun: db.query<{ sessionId: string }, [string]>(
        `SELECT session_id AS sessionId
         FROM sessions
         WHERE run_id = ?1
         ORDER BY rowid ASC`,
      ),
      getSessionsByRun: db.query<SessionRow, [string]>(
        `SELECT
           session_id AS sessionId,
           run_id AS runId,
           events_processed AS eventsProcessed,
           tool_invocations AS toolInvocations,
           tool_errors AS toolErrors,
           duration_ms AS durationMs,
           aborted,
           errored,
           idle_reached AS idleReached,
           timed_out AS timedOut,
           last_event_id AS lastEventId
         FROM sessions
         WHERE run_id = ?1
         ORDER BY rowid ASC`,
      ),
      getSubIssuesByRun: db.query<SubIssueRow, [string]>(
        `SELECT
           task_id AS taskId,
           issue_id AS issueId,
           issue_number AS issueNumber
         FROM sub_issues
         WHERE run_id = ?1
         ORDER BY id ASC`,
      ),
      insertPrompt: db.query(
        `INSERT INTO prompts (
           prompt_key,
           current_revision_id,
           updated_at
         ) VALUES (?1, ?2, ?3)`,
      ),
      insertPromptRevision: db.query<
        { id: number },
        [PromptKey, string, string, string, PromptRevisionSource]
      >(
        `INSERT INTO prompt_revisions (
           prompt_key,
           body,
           created_at,
           body_sha256,
           source
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         RETURNING id`,
      ),
      insertRun: db.query(
        `INSERT INTO runs (
            run_id,
            repo,
           issue_number,
           branch,
           started_at,
           pr_url,
           vault_id,
           pid,
           origin_type,
           origin_identifier,
           origin_url,
           origin_title
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(run_id) DO UPDATE SET
           repo = excluded.repo,
           issue_number = excluded.issue_number,
           branch = excluded.branch,
           started_at = excluded.started_at,
            pr_url = excluded.pr_url,
            vault_id = excluded.vault_id,
            pid = excluded.pid,
            origin_type = excluded.origin_type,
            origin_identifier = excluded.origin_identifier,
            origin_url = excluded.origin_url,
            origin_title = excluded.origin_title`,
      ),
      insertRunEvent: db.query(
        `INSERT INTO run_events (
           id,
           run_id,
           ts,
           kind,
           payload
         ) VALUES (?1, ?2, ?3, ?4, ?5)`,
      ),
      insertSession: db.query(
        `INSERT OR REPLACE INTO sessions (
            session_id,
            run_id,
           events_processed,
           tool_invocations,
           tool_errors,
           duration_ms,
           aborted,
           errored,
           idle_reached,
           timed_out,
           last_event_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ),
      insertSessionUsage: db.query(
        `INSERT INTO session_usage (
           session_id,
           model,
           input_tokens,
           output_tokens,
           cache_creation_input_tokens,
           cache_read_input_tokens,
           model_request_count,
           cost_usd
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(session_id, model) DO UPDATE SET
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cache_creation_input_tokens = excluded.cache_creation_input_tokens,
           cache_read_input_tokens = excluded.cache_read_input_tokens,
           model_request_count = excluded.model_request_count,
           cost_usd = excluded.cost_usd`,
      ),
      deleteSessionUsageBySession: db.query(`DELETE FROM session_usage WHERE session_id = ?1`),
      getSessionUsageBySession: db.query<SessionUsageDbRow, [string]>(
        `SELECT
           session_id AS sessionId,
           model,
           input_tokens AS inputTokens,
           output_tokens AS outputTokens,
           cache_creation_input_tokens AS cacheCreationInputTokens,
           cache_read_input_tokens AS cacheReadInputTokens,
           model_request_count AS modelRequestCount,
           cost_usd AS costUsd
         FROM session_usage
         WHERE session_id = ?1
         ORDER BY model ASC`,
      ),
      getSessionUsagesByRun: db.query<SessionUsageDbRow, [string]>(
        `SELECT
           u.session_id AS sessionId,
           u.model AS model,
           u.input_tokens AS inputTokens,
           u.output_tokens AS outputTokens,
           u.cache_creation_input_tokens AS cacheCreationInputTokens,
           u.cache_read_input_tokens AS cacheReadInputTokens,
           u.model_request_count AS modelRequestCount,
           u.cost_usd AS costUsd
         FROM session_usage u
         JOIN sessions s ON s.session_id = u.session_id
         WHERE s.run_id = ?1
         ORDER BY s.rowid ASC, u.model ASC`,
      ),
      aggregateUsageByRun: db.query<UsageAggregateDbRow, [string]>(
        `SELECT
           SUM(u.input_tokens) AS inputTokens,
           SUM(u.output_tokens) AS outputTokens,
           SUM(u.cache_creation_input_tokens) AS cacheCreationInputTokens,
           SUM(u.cache_read_input_tokens) AS cacheReadInputTokens,
           SUM(u.model_request_count) AS modelRequestCount,
           SUM(u.cost_usd) AS costUsd
         FROM session_usage u
         JOIN sessions s ON s.session_id = u.session_id
         WHERE s.run_id = ?1`,
      ),
      aggregateUsageByRepo: db.query<UsageAggregateDbRow, [string]>(
        `SELECT
           SUM(u.input_tokens) AS inputTokens,
           SUM(u.output_tokens) AS outputTokens,
           SUM(u.cache_creation_input_tokens) AS cacheCreationInputTokens,
           SUM(u.cache_read_input_tokens) AS cacheReadInputTokens,
           SUM(u.model_request_count) AS modelRequestCount,
           SUM(u.cost_usd) AS costUsd
         FROM session_usage u
         JOIN sessions s ON s.session_id = u.session_id
         JOIN runs r ON r.run_id = s.run_id
         WHERE r.repo = ?1`,
      ),
      aggregateUsageGlobal: db.query<UsageAggregateDbRow, []>(
        `SELECT
           SUM(input_tokens) AS inputTokens,
           SUM(output_tokens) AS outputTokens,
           SUM(cache_creation_input_tokens) AS cacheCreationInputTokens,
           SUM(cache_read_input_tokens) AS cacheReadInputTokens,
           SUM(model_request_count) AS modelRequestCount,
           SUM(cost_usd) AS costUsd
         FROM session_usage`,
      ),
      aggregateUsageByRepoAll: db.query<RepoUsageAggregateDbRow, []>(
        `SELECT
           r.repo AS repo,
           SUM(u.input_tokens) AS inputTokens,
           SUM(u.output_tokens) AS outputTokens,
           SUM(u.cache_creation_input_tokens) AS cacheCreationInputTokens,
           SUM(u.cache_read_input_tokens) AS cacheReadInputTokens,
           SUM(u.model_request_count) AS modelRequestCount,
           SUM(u.cost_usd) AS costUsd
         FROM session_usage u
         JOIN sessions s ON s.session_id = u.session_id
         JOIN runs r ON r.run_id = s.run_id
         GROUP BY r.repo`,
      ),
      aggregateUsageByAllRuns: db.query<RunUsageAggregateDbRow, []>(
        `SELECT
           s.run_id AS runId,
           SUM(u.input_tokens) AS inputTokens,
           SUM(u.output_tokens) AS outputTokens,
           SUM(u.cache_creation_input_tokens) AS cacheCreationInputTokens,
           SUM(u.cache_read_input_tokens) AS cacheReadInputTokens,
           SUM(u.model_request_count) AS modelRequestCount,
           SUM(u.cost_usd) AS costUsd
         FROM session_usage u
         JOIN sessions s ON s.session_id = u.session_id
         GROUP BY s.run_id`,
      ),
      insertSubIssue: db.query(
        `INSERT INTO sub_issues (
           run_id,
           task_id,
           issue_id,
           issue_number
         ) VALUES (?1, ?2, ?3, ?4)`,
      ),
      listRepositories: db.query<RepositorySummaryRow>(
        `SELECT
           repo,
           COUNT(*) AS runCount,
           MAX(started_at) AS lastRunAt
         FROM runs
           GROUP BY repo
           ORDER BY MAX(started_at) DESC`,
      ),
      listRuns: db.query<RunSummaryRow, [number]>(
        `SELECT
           run_id AS runId,
           issue_number AS issueNumber,
           repo,
           branch,
           started_at AS startedAt,
           status,
           phase,
           pr_url AS prUrl,
           origin_type AS originType,
           origin_identifier AS originIdentifier,
           origin_url AS originUrl,
           origin_title AS originTitle
         FROM runs
         ORDER BY started_at DESC
         LIMIT ?1`,
      ),
      listRunsByRepo: db.query<RunSummaryRow, [string, number]>(
        `SELECT
           run_id AS runId,
           issue_number AS issueNumber,
           repo,
           branch,
           started_at AS startedAt,
           status,
           phase,
           pr_url AS prUrl,
           origin_type AS originType,
           origin_identifier AS originIdentifier,
           origin_url AS originUrl,
           origin_title AS originTitle
         FROM runs
         WHERE repo = ?1
         ORDER BY started_at DESC
         LIMIT ?2`,
      ),
      listRunsByStatus: db.query<RunSummaryRow, [RunStatus, number]>(
        `SELECT
           run_id AS runId,
           issue_number AS issueNumber,
           repo,
           branch,
           started_at AS startedAt,
           status,
           phase,
           pr_url AS prUrl,
           origin_type AS originType,
           origin_identifier AS originIdentifier,
           origin_url AS originUrl,
           origin_title AS originTitle
         FROM runs
         WHERE status = ?1
         ORDER BY started_at DESC
         LIMIT ?2`,
      ),
      listRunsByStatusAndRepo: db.query<RunSummaryRow, [RunStatus, string, number]>(
        `SELECT
            run_id AS runId,
           issue_number AS issueNumber,
           repo,
           branch,
           started_at AS startedAt,
           status,
           phase,
           pr_url AS prUrl,
           origin_type AS originType,
           origin_identifier AS originIdentifier,
           origin_url AS originUrl,
           origin_title AS originTitle
         FROM runs
         WHERE status = ?1
           AND repo = ?2
          ORDER BY started_at DESC
          LIMIT ?3`,
      ),
      listRunEvents: db.query<RunEventRow, [string, number]>(
        `SELECT
           id,
           run_id AS runId,
           ts,
           kind,
           payload
         FROM run_events
         WHERE run_id = ?1
         ORDER BY id ASC
         LIMIT ?2`,
      ),
      listRunEventsAfter: db.query<RunEventRow, [string, string, number]>(
        `SELECT
           id,
           run_id AS runId,
           ts,
           kind,
           payload
         FROM run_events
         WHERE run_id = ?1
           AND id > ?2
         ORDER BY id ASC
         LIMIT ?3`,
      ),
      listRunEventsDesc: db.query<RunEventRow, [string, number]>(
        `SELECT
           id,
           run_id AS runId,
           ts,
           kind,
           payload
         FROM run_events
         WHERE run_id = ?1
         ORDER BY id DESC
         LIMIT ?2`,
      ),
      listRunEventsAfterDesc: db.query<RunEventRow, [string, string, number]>(
        `SELECT
           id,
           run_id AS runId,
           ts,
           kind,
           payload
         FROM run_events
         WHERE run_id = ?1
           AND id > ?2
         ORDER BY id DESC
         LIMIT ?3`,
      ),
      resyncOrphanedRuns: db.query(
        `UPDATE runs
          SET status = 'aborted'
         WHERE status = 'running'
            OR status = 'queued'`,
      ),
      setRunPhase: db.query(
        `UPDATE runs
         SET phase = ?1
         WHERE run_id = ?2`,
      ),
      setRunStatus: db.query(
        `UPDATE runs
         SET status = ?1
         WHERE run_id = ?2`,
      ),
      upsertPrompt: db.query(
        `INSERT INTO prompts (
           prompt_key,
           current_revision_id,
           updated_at
         ) VALUES (?1, ?2, ?3)
         ON CONFLICT(prompt_key) DO UPDATE SET
           current_revision_id = excluded.current_revision_id,
           updated_at = excluded.updated_at`,
      ),
      deleteRepoEnvironmentByRepo: db.query("DELETE FROM repo_environments WHERE repo = ?1"),
      deleteRepoEnvironmentRevisionsByRepo: db.query(
        "DELETE FROM repo_environment_revisions WHERE repo = ?1",
      ),
      getRepoEnvironmentByRepo: db.query<RepoEnvironmentWithPackagesJsonRow, [string]>(
        `SELECT
           p.repo AS repo,
           p.environment_id AS environmentId,
           p.definition_hash AS definitionHash,
           p.current_revision_id AS currentRevisionId,
           r.packages,
           p.updated_at AS updatedAt
         FROM repo_environments p
         JOIN repo_environment_revisions r
           ON r.id = p.current_revision_id
          AND r.repo = p.repo
         WHERE p.repo = ?1`,
      ),
      getRepoEnvironmentCurrentRevisionByRepo: db.query<
        RepoEnvironmentCurrentRevisionJsonRow,
        [string]
      >(
        `SELECT
           r.id,
           r.repo,
           r.packages,
           r.created_at AS createdAt,
           r.packages_sha256 AS packagesSha256,
           r.source,
           p.environment_id AS environmentId,
           p.definition_hash AS definitionHash,
           p.current_revision_id AS currentRevisionId,
           p.updated_at AS updatedAt
         FROM repo_environments p
         JOIN repo_environment_revisions r
           ON r.id = p.current_revision_id
          AND r.repo = p.repo
         WHERE p.repo = ?1`,
      ),
      getRepoEnvironmentRevisionByRepoAndId: db.query<
        RepoEnvironmentRevisionJsonRow,
        [string, number]
      >(
        `SELECT
           id,
           repo,
           packages,
           created_at AS createdAt,
           packages_sha256 AS packagesSha256,
           source
         FROM repo_environment_revisions
         WHERE repo = ?1
           AND id = ?2`,
      ),
      getRepoEnvironmentRevisionsByRepo: db.query<RepoEnvironmentRevisionJsonRow, [string]>(
        `SELECT
           id,
           repo,
           packages,
           created_at AS createdAt,
           packages_sha256 AS packagesSha256,
           source
         FROM repo_environment_revisions
         WHERE repo = ?1
         ORDER BY id DESC`,
      ),
      getRepoEnvironmentRowByRepo: db.query<RepoEnvironmentRow, [string]>(
        `SELECT
           repo,
           environment_id AS environmentId,
           definition_hash AS definitionHash,
           current_revision_id AS currentRevisionId,
           updated_at AS updatedAt
         FROM repo_environments
         WHERE repo = ?1`,
      ),
      insertRepoEnvironment: db.query(
        `INSERT INTO repo_environments (
           repo,
           environment_id,
           definition_hash,
           current_revision_id,
           updated_at
         ) VALUES (?1, NULL, NULL, ?2, ?3)`,
      ),
      insertRepoEnvironmentRevision: db.query<
        { id: number },
        [string, string, string, string, RepoEnvironmentRevisionSource]
      >(
        `INSERT INTO repo_environment_revisions (
           repo,
           packages,
           created_at,
           packages_sha256,
           source
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         RETURNING id`,
      ),
      listRepoEnvironmentOverrides: db.query<RepoEnvironmentOverrideSummaryRow>(
        `SELECT
           p.repo AS repo,
           p.environment_id AS environmentId,
           p.definition_hash AS definitionHash,
           p.current_revision_id AS currentRevisionId,
           p.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM repo_environment_revisions r
              WHERE r.repo = p.repo) AS revisionCount
         FROM repo_environments p
         ORDER BY p.updated_at DESC`,
      ),
      listRepoEnvironmentOverridesByRepo: db.query<RepoEnvironmentOverrideSummaryRow, [string]>(
        `SELECT
           p.repo AS repo,
           p.environment_id AS environmentId,
           p.definition_hash AS definitionHash,
           p.current_revision_id AS currentRevisionId,
           p.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM repo_environment_revisions r
              WHERE r.repo = p.repo) AS revisionCount
         FROM repo_environments p
         WHERE p.repo = ?1
         ORDER BY p.repo ASC`,
      ),
      setRepoEnvironmentAnthropicState: db.query(
        `UPDATE repo_environments
         SET environment_id = ?1,
             definition_hash = ?2,
             updated_at = ?3
         WHERE repo = ?4`,
      ),
      upsertRepoEnvironment: db.query(
        `INSERT INTO repo_environments (
           repo,
           environment_id,
           definition_hash,
           current_revision_id,
           updated_at
         ) VALUES (?1, NULL, NULL, ?2, ?3)
         ON CONFLICT(repo) DO UPDATE SET
           current_revision_id = excluded.current_revision_id,
           updated_at = excluded.updated_at`,
      ),
      deleteRepoPromptByKey: db.query("DELETE FROM repo_prompts WHERE repo = ?1 AND agent = ?2"),
      deleteRepoPromptRevisionsByKey: db.query(
        "DELETE FROM repo_prompt_revisions WHERE repo = ?1 AND agent = ?2",
      ),
      getRepoPromptByKey: db.query<RepoPromptWithBodyRow, [string, RepoPromptAgent]>(
        `SELECT
           p.repo AS repo,
           p.agent AS agent,
           p.current_revision_id AS currentRevisionId,
           r.body,
           p.updated_at AS updatedAt
         FROM repo_prompts p
         JOIN repo_prompt_revisions r
           ON r.id = p.current_revision_id
          AND r.repo = p.repo
          AND r.agent = p.agent
         WHERE p.repo = ?1
           AND p.agent = ?2`,
      ),
      getRepoPromptCurrentRevisionByKey: db.query<
        RepoPromptCurrentRevisionRow,
        [string, RepoPromptAgent]
      >(
        `SELECT
           r.id,
           r.repo,
           r.agent,
           r.body,
           r.created_at AS createdAt,
           r.body_sha256 AS bodySha256,
           r.source,
           p.current_revision_id AS currentRevisionId,
           p.updated_at AS updatedAt
         FROM repo_prompts p
         JOIN repo_prompt_revisions r
           ON r.id = p.current_revision_id
          AND r.repo = p.repo
          AND r.agent = p.agent
         WHERE p.repo = ?1
           AND p.agent = ?2`,
      ),
      getRepoPromptRevisionByKeyAndId: db.query<
        RepoPromptRevisionRow,
        [string, RepoPromptAgent, number]
      >(
        `SELECT
           id,
           repo,
           agent,
           body,
           created_at AS createdAt,
           body_sha256 AS bodySha256,
           source
         FROM repo_prompt_revisions
         WHERE repo = ?1
           AND agent = ?2
           AND id = ?3`,
      ),
      getRepoPromptRevisionsByKey: db.query<RepoPromptRevisionRow, [string, RepoPromptAgent]>(
        `SELECT
           id,
           repo,
           agent,
           body,
           created_at AS createdAt,
           body_sha256 AS bodySha256,
           source
         FROM repo_prompt_revisions
         WHERE repo = ?1
           AND agent = ?2
         ORDER BY id DESC`,
      ),
      getRepoPromptRowByKey: db.query<RepoPromptRow, [string, RepoPromptAgent]>(
        `SELECT
           repo,
           agent,
           current_revision_id AS currentRevisionId,
           updated_at AS updatedAt
         FROM repo_prompts
         WHERE repo = ?1
           AND agent = ?2`,
      ),
      insertRepoPrompt: db.query(
        `INSERT INTO repo_prompts (
           repo,
           agent,
           current_revision_id,
           updated_at
         ) VALUES (?1, ?2, ?3, ?4)`,
      ),
      insertRepoPromptRevision: db.query<
        { id: number },
        [string, RepoPromptAgent, string, string, string, RepoPromptRevisionSource]
      >(
        `INSERT INTO repo_prompt_revisions (
           repo,
           agent,
           body,
           created_at,
           body_sha256,
           source
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         RETURNING id`,
      ),
      listRepoPromptOverrides: db.query<RepoPromptOverrideSummaryRow>(
        `SELECT
           p.repo AS repo,
           p.agent AS agent,
           p.current_revision_id AS currentRevisionId,
           p.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM repo_prompt_revisions r
              WHERE r.repo = p.repo AND r.agent = p.agent) AS revisionCount
         FROM repo_prompts p
         ORDER BY p.updated_at DESC`,
      ),
      listRepoPromptOverridesByRepo: db.query<RepoPromptOverrideSummaryRow, [string]>(
        `SELECT
           p.repo AS repo,
           p.agent AS agent,
           p.current_revision_id AS currentRevisionId,
           p.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM repo_prompt_revisions r
              WHERE r.repo = p.repo AND r.agent = p.agent) AS revisionCount
         FROM repo_prompts p
         WHERE p.repo = ?1
         ORDER BY p.agent ASC`,
      ),
      upsertRepoPrompt: db.query(
        `INSERT INTO repo_prompts (
           repo,
           agent,
           current_revision_id,
           updated_at
         ) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(repo, agent) DO UPDATE SET
           current_revision_id = excluded.current_revision_id,
           updated_at = excluded.updated_at`,
      ),
      countGithubTriggerDedupe: db.query<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM github_trigger_dedupe
         WHERE dedupe_key = ?1`,
      ),
      insertGithubTriggerDedupe: db.query<
        unknown,
        [string, string, number, GithubTriggerSource, string, string | null, string]
      >(
        `INSERT OR IGNORE INTO github_trigger_dedupe (
           dedupe_key,
           repo,
           issue_number,
           source,
           source_id,
           run_id,
           processed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ),
      deletePolledRepository: db.query("DELETE FROM polled_repositories WHERE repo = ?1"),
      getPolledRepository: db.query<PolledRepositoryRow, [string]>(
        `SELECT
           repo,
           enabled,
           added_at AS addedAt,
           updated_at AS updatedAt
         FROM polled_repositories
         WHERE repo = ?1`,
      ),
      listPolledRepositories: db.query<PolledRepositoryRow, []>(
        `SELECT
           repo,
           enabled,
           added_at AS addedAt,
           updated_at AS updatedAt
         FROM polled_repositories
         ORDER BY repo ASC`,
      ),
      listEnabledPolledRepositories: db.query<PolledRepositoryRow, []>(
        `SELECT
           repo,
           enabled,
           added_at AS addedAt,
           updated_at AS updatedAt
         FROM polled_repositories
         WHERE enabled = 1
         ORDER BY repo ASC`,
      ),
      setPolledRepositoryEnabled: db.query(
        `UPDATE polled_repositories
         SET enabled = ?1,
             updated_at = ?2
         WHERE repo = ?3`,
      ),
      upsertPolledRepository: db.query(
        `INSERT INTO polled_repositories (
           repo,
           enabled,
           added_at,
           updated_at
         ) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(repo) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at`,
      ),
      deleteMcpServer: db.query("DELETE FROM mcp_servers WHERE id = ?1 AND is_builtin = 0"),
      getMcpServerById: db.query<McpServerDbRow, [number]>(
        `SELECT
           id,
           name,
           url,
           token_env_name AS tokenEnvName,
           permission_policy AS permissionPolicy,
           enabled,
           is_builtin AS isBuiltin,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM mcp_servers
         WHERE id = ?1`,
      ),
      getMcpServerByName: db.query<McpServerDbRow, [string]>(
        `SELECT
           id,
           name,
           url,
           token_env_name AS tokenEnvName,
           permission_policy AS permissionPolicy,
           enabled,
           is_builtin AS isBuiltin,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM mcp_servers
         WHERE name = ?1`,
      ),
      insertMcpServer: db.query<
        { id: number },
        [string, string, string, McpPermissionPolicy, number, number, string, string]
      >(
        `INSERT INTO mcp_servers (
           name,
           url,
           token_env_name,
           permission_policy,
           enabled,
           is_builtin,
           created_at,
           updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         RETURNING id`,
      ),
      listMcpServers: db.query<McpServerDbRow, []>(
        `SELECT
           id,
           name,
           url,
           token_env_name AS tokenEnvName,
           permission_policy AS permissionPolicy,
           enabled,
           is_builtin AS isBuiltin,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM mcp_servers
         ORDER BY is_builtin DESC, name ASC`,
      ),
      listEnabledMcpServers: db.query<McpServerDbRow, []>(
        `SELECT
           id,
           name,
           url,
           token_env_name AS tokenEnvName,
           permission_policy AS permissionPolicy,
           enabled,
           is_builtin AS isBuiltin,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM mcp_servers
         WHERE enabled = 1
         ORDER BY is_builtin DESC, name ASC`,
      ),
      setMcpServerEnabled: db.query(
        `UPDATE mcp_servers
         SET enabled = ?1,
             updated_at = ?2
         WHERE id = ?3`,
      ),
      // Non-builtin update: allows changing name/url/token/policy/enabled.
      updateMcpServer: db.query(
        `UPDATE mcp_servers
         SET name = ?1,
             url = ?2,
             token_env_name = ?3,
             permission_policy = ?4,
             enabled = ?5,
             updated_at = ?6
         WHERE id = ?7 AND is_builtin = 0`,
      ),
      // Builtin update: locks url/name. Only token/policy/enabled are mutable.
      updateBuiltinMcpServer: db.query(
        `UPDATE mcp_servers
         SET token_env_name = ?1,
             permission_policy = ?2,
             enabled = ?3,
             updated_at = ?4
         WHERE id = ?5 AND is_builtin = 1`,
      ),
      getRepoChatState: db.query<RepoChatStateDbRow, []>(
        `SELECT
           agent_id AS agentId,
           agent_version AS agentVersion,
           agent_definition_hash AS agentDefinitionHash,
           environment_id AS environmentId,
           environment_definition_hash AS environmentDefinitionHash,
           updated_at AS updatedAt
         FROM repo_chat_state
         WHERE id = 1`,
      ),
      upsertRepoChatAgentState: db.query(
        `INSERT INTO repo_chat_state (
           id,
           agent_id,
           agent_version,
           agent_definition_hash,
           updated_at
         ) VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
           agent_id = excluded.agent_id,
           agent_version = excluded.agent_version,
           agent_definition_hash = excluded.agent_definition_hash,
           updated_at = excluded.updated_at`,
      ),
      upsertRepoChatEnvironmentState: db.query(
        `INSERT INTO repo_chat_state (
           id,
           environment_id,
           environment_definition_hash,
           updated_at
         ) VALUES (1, ?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET
           environment_id = excluded.environment_id,
           environment_definition_hash = excluded.environment_definition_hash,
           updated_at = excluded.updated_at`,
      ),
      getRepoChatThreadById: db.query<RepoChatThreadRow, [string]>(
        `SELECT
           id,
           repo,
           title,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM repo_chat_threads
         WHERE id = ?1`,
      ),
      insertRepoChatThread: db.query(
        `INSERT INTO repo_chat_threads (
           id,
           repo,
           title,
           created_at,
           updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5)`,
      ),
      listRepoChatRepositories: db.query<RepoChatThreadSummaryRow, []>(
        `SELECT
           repo,
           COUNT(*) AS threadCount,
           MAX(updated_at) AS lastChatAt
         FROM repo_chat_threads
         GROUP BY repo
         ORDER BY lastChatAt DESC`,
      ),
      listRepoChatThreadsByRepo: db.query<RepoChatThreadRow, [string, number]>(
        `SELECT
           id,
           repo,
           title,
           created_at AS createdAt,
           updated_at AS updatedAt
         FROM repo_chat_threads
         WHERE repo = ?1
         ORDER BY updated_at DESC
         LIMIT ?2`,
      ),
      touchRepoChatThread: db.query(
        `UPDATE repo_chat_threads
         SET updated_at = ?1
         WHERE id = ?2`,
      ),
      insertRepoChatMessage: db.query(
        `INSERT INTO repo_chat_messages (
           id,
           thread_id,
           role,
           content,
           session_id,
           created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ),
      listRepoChatMessagesByThread: db.query<RepoChatMessageRow, [string]>(
        `SELECT
           id,
           thread_id AS threadId,
           role,
           content,
           session_id AS sessionId,
           created_at AS createdAt
         FROM repo_chat_messages
         WHERE thread_id = ?1
         ORDER BY created_at ASC`,
      ),
    };
    const replaceRunAndSubIssues = db.transaction((run: RunState) => {
      const originFields = runOriginPersistenceFields(run);
      statements.insertRun.run(
        run.runId,
        run.repo,
        run.issueNumber,
        run.branch,
        run.startedAt,
        run.prUrl ?? null,
        run.vaultId ?? null,
        run.pid ?? null,
        originFields.originType,
        originFields.originIdentifier,
        originFields.originUrl,
        originFields.originTitle,
      );

      statements.deleteSubIssuesByRun.run(run.runId);

      for (const subIssue of run.subIssues) {
        statements.insertSubIssue.run(
          run.runId,
          subIssue.taskId,
          subIssue.issueId,
          subIssue.issueNumber,
        );
      }
    });

    function insertPromptRevision(input: {
      body: string;
      bodySha256: string;
      key: PromptKey;
      now: string;
      source: PromptRevisionSource;
    }): number {
      return parseInsertedPromptRevisionId(
        statements.insertPromptRevision.get(
          input.key,
          input.body,
          input.now,
          input.bodySha256,
          input.source,
        ),
      );
    }

    function insertRevisionAndUpsertPrompt(input: {
      body: string;
      bodySha256: string;
      key: PromptKey;
      now: string;
      source: PromptRevisionSource;
    }): number {
      const revisionId = insertPromptRevision(input);
      statements.upsertPrompt.run(input.key, revisionId, input.now);
      return revisionId;
    }

    const savePromptRevisionTransaction = db.transaction(
      (input: PromptSaveTransactionInput, setResult: (result: PromptSaveResult) => void) => {
        const currentRow = statements.getPromptCurrentRevisionByKey.get(input.key);

        if (currentRow != null) {
          const currentRevision = parsePromptCurrentRevision(currentRow);

          if (!input.allowDuplicateBody && currentRevision.bodySha256 === input.bodySha256) {
            setResult({
              isNoChange: true,
              revisionId: currentRevision.currentRevisionId,
            });
            return;
          }
        }

        const revisionId = insertRevisionAndUpsertPrompt(input);
        setResult({ isNoChange: false, revisionId });
      },
    );

    const restorePromptToRevisionTransaction = db.transaction(
      (input: PromptRestoreTransactionInput, setResult: (result: PromptRestoreResult) => void) => {
        const targetRow = statements.getPromptRevisionByKeyAndId.get(input.key, input.revisionId);

        if (targetRow == null) {
          throw new Error(`Prompt revision ${input.revisionId} not found for ${input.key}`);
        }

        const targetRevision = PromptRevisionRowSchema.parse(targetRow);
        const currentRow = statements.getPromptCurrentRevisionByKey.get(input.key);

        if (currentRow != null) {
          const currentRevision = parsePromptCurrentRevision(currentRow);

          if (targetRevision.body === currentRevision.body) {
            setResult({
              alreadyCurrent: true,
              newRevisionId: currentRevision.currentRevisionId,
            });
            return;
          }
        }

        const newRevisionId = insertRevisionAndUpsertPrompt({
          body: targetRevision.body,
          bodySha256: hashPromptBody(targetRevision.body),
          key: input.key,
          now: input.now,
          source: PromptRevisionSourceSchema.parse("restore"),
        });
        setResult({ alreadyCurrent: false, newRevisionId });
      },
    );

    const seedPromptIfMissingTransaction = db.transaction(
      (input: PromptSeedTransactionInput, setResult: (result: PromptSeedResult) => void) => {
        const promptRow = statements.getPromptRowByKey.get(input.key);

        if (promptRow != null) {
          PromptRowSchema.parse(promptRow);
          setResult({ seeded: false });
          return;
        }

        const revisionId = insertPromptRevision(input);
        statements.insertPrompt.run(input.key, revisionId, input.now);
        setResult({ seeded: true });
      },
    );

    function insertRepoEnvironmentRevisionRow(input: {
      now: string;
      packagesJson: string;
      packagesSha256: string;
      repo: string;
      source: RepoEnvironmentRevisionSource;
    }): number {
      return parseInsertedRepoEnvironmentRevisionId(
        statements.insertRepoEnvironmentRevision.get(
          input.repo,
          input.packagesJson,
          input.now,
          input.packagesSha256,
          input.source,
        ),
      );
    }

    function insertRepoEnvironmentRevisionAndUpsert(input: {
      now: string;
      packagesJson: string;
      packagesSha256: string;
      repo: string;
      source: RepoEnvironmentRevisionSource;
    }): number {
      const revisionId = insertRepoEnvironmentRevisionRow(input);
      statements.upsertRepoEnvironment.run(input.repo, revisionId, input.now);
      return revisionId;
    }

    const saveRepoEnvironmentRevisionTransaction = db.transaction(
      (
        input: RepoEnvironmentSaveTransactionInput,
        setResult: (result: RepoEnvironmentSaveResult) => void,
      ) => {
        const currentRow = statements.getRepoEnvironmentCurrentRevisionByRepo.get(input.repo);

        if (currentRow != null) {
          const currentRevision = parseRepoEnvironmentCurrentRevision(currentRow);

          if (
            !input.allowDuplicatePackages &&
            currentRevision.packagesSha256 === input.packagesSha256
          ) {
            setResult({
              isNoChange: true,
              revisionId: currentRevision.currentRevisionId,
            });
            return;
          }
        }

        const revisionId = insertRepoEnvironmentRevisionAndUpsert(input);
        setResult({ isNoChange: false, revisionId });
      },
    );

    const restoreRepoEnvironmentToRevisionTransaction = db.transaction(
      (
        input: RepoEnvironmentRestoreTransactionInput,
        setResult: (result: RepoEnvironmentRestoreResult) => void,
      ) => {
        const targetRow = statements.getRepoEnvironmentRevisionByRepoAndId.get(
          input.repo,
          input.revisionId,
        );

        if (targetRow == null) {
          throw new Error(
            `Repo environment revision ${input.revisionId} not found for ${input.repo}`,
          );
        }

        const targetRevision = parseRepoEnvironmentRevisionJsonRow(targetRow);
        const currentRow = statements.getRepoEnvironmentCurrentRevisionByRepo.get(input.repo);

        if (currentRow != null) {
          const currentRevision = parseRepoEnvironmentCurrentRevision(currentRow);

          if (targetRevision.packagesSha256 === currentRevision.packagesSha256) {
            setResult({
              alreadyCurrent: true,
              newRevisionId: currentRevision.currentRevisionId,
            });
            return;
          }
        }

        const packagesJson = canonicalizePackages(targetRevision.packages);
        const newRevisionId = insertRepoEnvironmentRevisionAndUpsert({
          now: input.now,
          packagesJson,
          packagesSha256: hashPackagesJson(packagesJson),
          repo: input.repo,
          source: RepoEnvironmentRevisionSourceSchema.parse("restore"),
        });
        setResult({ alreadyCurrent: false, newRevisionId });
      },
    );

    const deleteRepoEnvironmentTransaction = db.transaction(
      (input: { repo: string }, setResult: (result: { deleted: boolean }) => void) => {
        const environmentRow = statements.getRepoEnvironmentRowByRepo.get(input.repo);

        if (environmentRow == null) {
          setResult({ deleted: false });
          return;
        }

        statements.deleteRepoEnvironmentByRepo.run(input.repo);
        statements.deleteRepoEnvironmentRevisionsByRepo.run(input.repo);
        setResult({ deleted: true });
      },
    );

    function insertRepoPromptRevisionRow(input: {
      agent: RepoPromptAgent;
      body: string;
      bodySha256: string;
      now: string;
      repo: string;
      source: RepoPromptRevisionSource;
    }): number {
      return parseInsertedRepoPromptRevisionId(
        statements.insertRepoPromptRevision.get(
          input.repo,
          input.agent,
          input.body,
          input.now,
          input.bodySha256,
          input.source,
        ),
      );
    }

    function insertRepoPromptRevisionAndUpsert(input: {
      agent: RepoPromptAgent;
      body: string;
      bodySha256: string;
      now: string;
      repo: string;
      source: RepoPromptRevisionSource;
    }): number {
      const revisionId = insertRepoPromptRevisionRow(input);
      statements.upsertRepoPrompt.run(input.repo, input.agent, revisionId, input.now);
      return revisionId;
    }

    const saveRepoPromptRevisionTransaction = db.transaction(
      (
        input: RepoPromptSaveTransactionInput,
        setResult: (result: RepoPromptSaveResult) => void,
      ) => {
        const currentRow = statements.getRepoPromptCurrentRevisionByKey.get(
          input.repo,
          input.agent,
        );

        if (currentRow != null) {
          const currentRevision = parseRepoPromptCurrentRevision(currentRow);

          if (!input.allowDuplicateBody && currentRevision.bodySha256 === input.bodySha256) {
            setResult({
              isNoChange: true,
              revisionId: currentRevision.currentRevisionId,
            });
            return;
          }
        }

        const revisionId = insertRepoPromptRevisionAndUpsert(input);
        setResult({ isNoChange: false, revisionId });
      },
    );

    const restoreRepoPromptToRevisionTransaction = db.transaction(
      (
        input: RepoPromptRestoreTransactionInput,
        setResult: (result: RepoPromptRestoreResult) => void,
      ) => {
        const targetRow = statements.getRepoPromptRevisionByKeyAndId.get(
          input.repo,
          input.agent,
          input.revisionId,
        );

        if (targetRow == null) {
          throw new Error(
            `Repo prompt revision ${input.revisionId} not found for ${input.repo}/${input.agent}`,
          );
        }

        const targetRevision = RepoPromptRevisionRowSchema.parse(targetRow);
        const currentRow = statements.getRepoPromptCurrentRevisionByKey.get(
          input.repo,
          input.agent,
        );

        if (currentRow != null) {
          const currentRevision = parseRepoPromptCurrentRevision(currentRow);

          if (targetRevision.body === currentRevision.body) {
            setResult({
              alreadyCurrent: true,
              newRevisionId: currentRevision.currentRevisionId,
            });
            return;
          }
        }

        const newRevisionId = insertRepoPromptRevisionAndUpsert({
          agent: input.agent,
          body: targetRevision.body,
          bodySha256: hashPromptBody(targetRevision.body),
          now: input.now,
          repo: input.repo,
          source: RepoPromptRevisionSourceSchema.parse("restore"),
        });
        setResult({ alreadyCurrent: false, newRevisionId });
      },
    );

    const deleteRepoPromptTransaction = db.transaction(
      (
        input: { agent: RepoPromptAgent; repo: string },
        setResult: (result: { deleted: boolean }) => void,
      ) => {
        const promptRow = statements.getRepoPromptRowByKey.get(input.repo, input.agent);

        if (promptRow == null) {
          setResult({ deleted: false });
          return;
        }

        statements.deleteRepoPromptByKey.run(input.repo, input.agent);
        statements.deleteRepoPromptRevisionsByKey.run(input.repo, input.agent);
        setResult({ deleted: true });
      },
    );

    runtime = {
      deleteRepoEnvironmentTransaction,
      deleteRepoPromptTransaction,
      replaceRunAndSubIssues,
      restorePromptToRevisionTransaction,
      restoreRepoEnvironmentToRevisionTransaction,
      restoreRepoPromptToRevisionTransaction,
      savePromptRevisionTransaction,
      saveRepoEnvironmentRevisionTransaction,
      saveRepoPromptRevisionTransaction,
      seedPromptIfMissingTransaction,
      statements,
    };
    seedBuiltinMcpServersIfMissing(statements);

    return runtime;
  }

  /**
   * Insert the builtin GitHub MCP row on first run. Idempotent: subsequent
   * calls observe the existing row and normalize its legacy token-env
   * placeholder. The row's `name` and `url` are locked by the DB layer (only
   * token/policy/enabled can change via the WebUI); see `updateBuiltinMcpServer`.
   */
  function seedBuiltinMcpServersIfMissing(statements: PreparedStatements): void {
    const existing = statements.getMcpServerByName.get(BUILTIN_GITHUB_MCP_NAME);
    if (existing != null) {
      if (existing.tokenEnvName !== BUILTIN_GITHUB_MCP_TOKEN_ENV) {
        statements.updateBuiltinMcpServer.run(
          BUILTIN_GITHUB_MCP_TOKEN_ENV,
          existing.permissionPolicy as McpPermissionPolicy,
          existing.enabled,
          new Date().toISOString(),
          existing.id,
        );
      }
      return;
    }

    const now = new Date().toISOString();
    statements.insertMcpServer.get(
      BUILTIN_GITHUB_MCP_NAME,
      GITHUB_MCP_URL,
      BUILTIN_GITHUB_MCP_TOKEN_ENV,
      "always_allow",
      1,
      1,
      now,
      now,
    );
  }

  function hydrateRun(row: RunRow): RunState {
    const { statements } = getRuntime();
    const origin = hydrateRunOrigin(row);

    return RunStateSchema.parse({
      branch: row.branch,
      issueNumber: row.issueNumber,
      ...(origin ? { origin } : {}),
      pid: row.pid ?? undefined,
      prUrl: row.prUrl ?? undefined,
      repo: row.repo,
      runId: row.runId,
      sessionIds: statements.getSessionIdsByRun
        .all(row.runId)
        .map((sessionRow) => sessionRow.sessionId),
      startedAt: row.startedAt,
      subIssues: statements.getSubIssuesByRun
        .all(row.runId)
        .map((subIssueRow) => SubIssueSchema.parse(subIssueRow)),
      vaultId: row.vaultId ?? undefined,
    });
  }

  function initDb(): void {
    getRuntime();
  }

  function insertRun(run: RunState): void {
    getRuntime().replaceRunAndSubIssues(RunStateSchema.parse(run));
  }

  function insertRunEvent(event: RunEvent): void {
    const parsedEvent = RunEventSchema.parse(event);

    getRuntime().statements.insertRunEvent.run(
      parsedEvent.id,
      RUN_ID_SCHEMA.parse(parsedEvent.runId),
      parsedEvent.ts,
      RunEventKindSchema.parse(parsedEvent.kind),
      stringifyRunEventPayload(parsedEvent.payload),
    );
  }

  function listRunEvents(opts: {
    fromEventId?: string;
    limit?: number;
    order?: RunEventOrder;
    runId: string;
  }): RunEvent[] {
    const parsedRunId = RUN_ID_SCHEMA.parse(opts.runId);
    const limit = normalizeRunEventsLimit(opts.limit);
    const order = normalizeRunEventsOrder(opts.order);
    const { statements } = getRuntime();

    if (opts.fromEventId !== undefined) {
      const statement =
        order === "desc" ? statements.listRunEventsAfterDesc : statements.listRunEventsAfter;
      return statement
        .all(parsedRunId, RunEventSchema.shape.id.parse(opts.fromEventId), limit)
        .map((row) => parseRunEventRow(row));
    }

    const statement = order === "desc" ? statements.listRunEventsDesc : statements.listRunEvents;
    return statement.all(parsedRunId, limit).map((row) => parseRunEventRow(row));
  }

  function getRunsByRepo(repo: string): RunState[] {
    return getRuntime()
      .statements.getRunsByRepo.all(REPO_SCHEMA.parse(repo))
      .map((row) => hydrateRun(row));
  }

  function getRunById(runId: string): RunState | null {
    const row = getRuntime().statements.getRunById.get(RUN_ID_SCHEMA.parse(runId));
    return row == null ? null : hydrateRun(row);
  }

  function getRunStatus(runId: string): RunStatus | null {
    const row = getRuntime().statements.getRunStatus.get(RUN_ID_SCHEMA.parse(runId));
    return row == null ? null : RunStatusSchema.parse(row.status);
  }

  function setRunStatus(runId: string, status: RunStatus): void {
    getRuntime().statements.setRunStatus.run(
      RunStatusSchema.parse(status),
      RUN_ID_SCHEMA.parse(runId),
    );
  }

  function setRunStatusIfCurrent(
    runId: string,
    next: RunStatus,
    allowedCurrent: readonly RunStatus[],
  ): boolean {
    const parsedRunId = RUN_ID_SCHEMA.parse(runId);
    const parsedNext = RunStatusSchema.parse(next);
    const parsedAllowedCurrent = allowedCurrent.map((status) => RunStatusSchema.parse(status));
    if (parsedAllowedCurrent.length === 0) {
      return false;
    }

    getRuntime();
    const allowedPlaceholders = parsedAllowedCurrent.map((_, index) => `?${index + 3}`).join(", ");
    const result = db
      .query<unknown, [RunStatus, string, ...RunStatus[]]>(
        `UPDATE runs
         SET status = ?1
         WHERE run_id = ?2
           AND status IN (${allowedPlaceholders})`,
      )
      .run(parsedNext, parsedRunId, ...parsedAllowedCurrent);

    return readChanges(result) > 0;
  }

  function setRunPhase(runId: string, phase: RunPhase | null): void {
    getRuntime().statements.setRunPhase.run(
      phase === null ? null : RunPhaseSchema.parse(phase),
      RUN_ID_SCHEMA.parse(runId),
    );
  }

  function listRuns(opts: { status?: RunStatus; repo?: string; limit?: number }): RunSummary[] {
    const status = opts.status === undefined ? undefined : RunStatusSchema.parse(opts.status);
    const repo = opts.repo === undefined ? undefined : REPO_SCHEMA.parse(opts.repo);
    const limit = normalizeListRunsLimit(opts.limit);
    const { statements } = getRuntime();

    if (status !== undefined && repo !== undefined) {
      return statements.listRunsByStatusAndRepo
        .all(status, repo, limit)
        .map((row) => parseRunSummaryRow(row));
    }

    if (status !== undefined) {
      return statements.listRunsByStatus.all(status, limit).map((row) => parseRunSummaryRow(row));
    }

    if (repo !== undefined) {
      return statements.listRunsByRepo.all(repo, limit).map((row) => parseRunSummaryRow(row));
    }

    return statements.listRuns.all(limit).map((row) => parseRunSummaryRow(row));
  }

  function resyncOrphanedRuns(opts: { excludeRunIds?: readonly string[] } = {}): {
    aborted: number;
  } {
    const { statements } = getRuntime();
    const excludeRunIds = Array.from(
      new Set((opts.excludeRunIds ?? []).map((runId) => RUN_ID_SCHEMA.parse(runId))),
    );
    if (excludeRunIds.length > 0) {
      const excludePlaceholders = excludeRunIds.map((_, index) => `?${index + 1}`).join(", ");
      return {
        aborted: readChanges(
          db
            .query<unknown, string[]>(
              `UPDATE runs
               SET status = 'aborted'
               WHERE (status = 'running' OR status = 'queued')
                 AND run_id NOT IN (${excludePlaceholders})`,
            )
            .run(...excludeRunIds),
        ),
      };
    }

    return {
      aborted: readChanges(statements.resyncOrphanedRuns.run()),
    };
  }

  function insertSession(runId: string, session: SessionResult): void {
    const parsedRunId = RUN_ID_SCHEMA.parse(runId);
    const parsedSession = SessionResultSchema.parse(session);
    const { statements } = getRuntime();

    statements.insertSession.run(
      parsedSession.sessionId,
      parsedRunId,
      parsedSession.eventsProcessed,
      parsedSession.toolInvocations,
      parsedSession.toolErrors,
      parsedSession.durationMs,
      Number(parsedSession.aborted),
      Number(parsedSession.errored),
      Number(parsedSession.idleReached),
      Number(parsedSession.timedOut),
      parsedSession.lastEventId ?? null,
    );

    // Replace session_usage rows for this session with the latest aggregate.
    // For placeholders (no model, zero usage) this clears any stale rows.
    statements.deleteSessionUsageBySession.run(parsedSession.sessionId);

    if (parsedSession.model !== undefined && parsedSession.usage.modelRequestCount > 0) {
      const costUsd = calculateCostUsd(parsedSession.usage, parsedSession.model);
      statements.insertSessionUsage.run(
        parsedSession.sessionId,
        parsedSession.model,
        parsedSession.usage.inputTokens,
        parsedSession.usage.outputTokens,
        parsedSession.usage.cacheCreationInputTokens,
        parsedSession.usage.cacheReadInputTokens,
        parsedSession.usage.modelRequestCount,
        costUsd,
      );
    }
  }

  function insertSessionPlaceholder(runId: string, sessionId: string): void {
    insertSession(runId, {
      aborted: false,
      durationMs: 0,
      errored: false,
      eventsProcessed: 0,
      idleReached: false,
      lastEventId: undefined,
      model: undefined,
      sessionId,
      timedOut: false,
      toolErrors: 0,
      toolInvocations: 0,
      usage: emptySessionUsage(),
    });
  }

  function getSessionsByRun(runId: string): SessionResult[] {
    return getRuntime()
      .statements.getSessionsByRun.all(RUN_ID_SCHEMA.parse(runId))
      .map((row) => {
        // The `sessions` table does not carry model/usage; callers fetch usage
        // separately via `getSessionUsagesByRun` to keep this query simple and
        // avoid coupling per-model rows to the session row format.
        const parsedSession = SessionResultSchema.parse({
          aborted: Boolean(row.aborted),
          durationMs: row.durationMs,
          errored: Boolean(row.errored),
          eventsProcessed: row.eventsProcessed,
          idleReached: Boolean(row.idleReached),
          lastEventId: row.lastEventId ?? undefined,
          model: undefined,
          sessionId: row.sessionId,
          timedOut: Boolean(row.timedOut),
          toolErrors: row.toolErrors,
          toolInvocations: row.toolInvocations,
          usage: emptySessionUsage(),
        });

        return {
          aborted: parsedSession.aborted,
          durationMs: parsedSession.durationMs,
          errored: parsedSession.errored,
          eventsProcessed: parsedSession.eventsProcessed,
          idleReached: parsedSession.idleReached,
          lastEventId: parsedSession.lastEventId,
          model: parsedSession.model,
          sessionId: parsedSession.sessionId,
          timedOut: parsedSession.timedOut,
          toolErrors: parsedSession.toolErrors,
          toolInvocations: parsedSession.toolInvocations,
          usage: parsedSession.usage,
        };
      });
  }

  function parseSessionUsageDbRow(row: SessionUsageDbRow): SessionUsageRow {
    return SessionUsageRowSchema.parse({
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      cacheReadInputTokens: row.cacheReadInputTokens,
      costUsd: row.costUsd,
      inputTokens: row.inputTokens,
      model: row.model,
      modelRequestCount: row.modelRequestCount,
      outputTokens: row.outputTokens,
      sessionId: row.sessionId,
    });
  }

  function parseUsageAggregateDbRow(row: UsageAggregateDbRow | null | undefined): UsageAggregate {
    if (row == null) {
      return emptyUsageAggregate();
    }

    return UsageAggregateSchema.parse({
      cacheCreationInputTokens: row.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: row.cacheReadInputTokens ?? 0,
      costUsd: row.costUsd ?? 0,
      inputTokens: row.inputTokens ?? 0,
      modelRequestCount: row.modelRequestCount ?? 0,
      outputTokens: row.outputTokens ?? 0,
    });
  }

  function getSessionUsagesByRun(runId: string): SessionUsageRow[] {
    return getRuntime()
      .statements.getSessionUsagesByRun.all(RUN_ID_SCHEMA.parse(runId))
      .map((row) => parseSessionUsageDbRow(row));
  }

  function getSessionUsageBySession(sessionId: string): SessionUsageRow[] {
    return getRuntime()
      .statements.getSessionUsageBySession.all(sessionId)
      .map((row) => parseSessionUsageDbRow(row));
  }

  function getRunUsageAggregate(runId: string): UsageAggregate {
    const row = getRuntime().statements.aggregateUsageByRun.get(RUN_ID_SCHEMA.parse(runId));
    return parseUsageAggregateDbRow(row);
  }

  function getRepoUsageAggregate(repo: string): UsageAggregate {
    const row = getRuntime().statements.aggregateUsageByRepo.get(REPO_SCHEMA.parse(repo));
    return parseUsageAggregateDbRow(row);
  }

  function getGlobalUsageAggregate(): UsageAggregate {
    const row = getRuntime().statements.aggregateUsageGlobal.get();
    return parseUsageAggregateDbRow(row);
  }

  function listRepoUsageAggregates(): Map<string, UsageAggregate> {
    const result = new Map<string, UsageAggregate>();
    for (const row of getRuntime().statements.aggregateUsageByRepoAll.all()) {
      result.set(REPO_SCHEMA.parse(row.repo), parseUsageAggregateDbRow(row));
    }

    return result;
  }

  function listRunUsageAggregates(): Map<string, UsageAggregate> {
    const result = new Map<string, UsageAggregate>();
    for (const row of getRuntime().statements.aggregateUsageByAllRuns.all()) {
      result.set(RUN_ID_SCHEMA.parse(row.runId), parseUsageAggregateDbRow(row));
    }

    return result;
  }

  function insertSubIssue(
    runId: string,
    subIssue: { taskId: string; issueId: number; issueNumber: number },
  ): void {
    const parsedRunId = RUN_ID_SCHEMA.parse(runId);
    const parsedSubIssue = SubIssueSchema.parse(subIssue);

    getRuntime().statements.insertSubIssue.run(
      parsedRunId,
      parsedSubIssue.taskId,
      parsedSubIssue.issueId,
      parsedSubIssue.issueNumber,
    );
  }

  function getSubIssuesByRun(
    runId: string,
  ): Array<{ taskId: string; issueId: number; issueNumber: number }> {
    return getRuntime()
      .statements.getSubIssuesByRun.all(RUN_ID_SCHEMA.parse(runId))
      .map((row) => SubIssueSchema.parse(row));
  }

  function listRepositories(): Array<{ repo: string; runCount: number; lastRunAt: string | null }> {
    return getRuntime()
      .statements.listRepositories.all()
      .map((row) => ({
        lastRunAt: row.lastRunAt,
        repo: REPO_SCHEMA.parse(row.repo),
        runCount: row.runCount,
      }));
  }

  function getPrompt(key: PromptKey): {
    body: string;
    currentRevisionId: number;
    promptKey: PromptKey;
    updatedAt: string;
  } | null {
    const row = getRuntime().statements.getPromptByKey.get(PromptKeySchema.parse(key));
    return row == null ? null : parsePromptWithBody(row);
  }

  function getPromptRevisions(key: EditablePromptKey): PromptRevisionRow[] {
    return getRuntime()
      .statements.getPromptRevisionsByKey.all(EditablePromptKeySchema.parse(key))
      .map((row) => PromptRevisionRowSchema.parse(row));
  }

  function getPromptRevision(key: EditablePromptKey, revisionId: number): PromptRevisionRow | null {
    const input = RestoreInputSchema.parse({ promptKey: key, revisionId });
    const row = getRuntime().statements.getPromptRevisionByKeyAndId.get(
      input.promptKey,
      input.revisionId,
    );

    return row == null ? null : PromptRevisionRowSchema.parse(row);
  }

  function savePromptRevision(
    input: PromptSavePublicInput,
    opts: { allowDuplicateBody?: boolean } = {},
  ): PromptSaveResult {
    const normalizedBody = normalizePromptBody(input.body);
    const parsedBody = PromptSaveInputSchema.parse({ body: normalizedBody }).body;
    const parsedKey = EditablePromptKeySchema.parse(input.key);
    const parsedSource = PromptRevisionSourceSchema.parse(input.source);
    let result: PromptSaveResult | null = null;

    getRuntime().savePromptRevisionTransaction(
      {
        allowDuplicateBody: opts.allowDuplicateBody === true,
        body: parsedBody,
        bodySha256: hashPromptBody(parsedBody),
        key: parsedKey,
        now: new Date().toISOString(),
        source: parsedSource,
      },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Prompt revision save did not complete");
    }

    return result;
  }

  function restorePromptToRevision(
    key: EditablePromptKey,
    revisionId: number,
  ): PromptRestoreResult {
    const input = RestoreInputSchema.parse({ promptKey: key, revisionId });
    let result: PromptRestoreResult | null = null;

    getRuntime().restorePromptToRevisionTransaction(
      {
        key: input.promptKey,
        now: new Date().toISOString(),
        revisionId: input.revisionId,
      },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Prompt restore did not complete");
    }

    return result;
  }

  function seedPromptIfMissing(key: PromptKey, defaultBody: string): PromptSeedResult {
    const parsedKey = PromptKeySchema.parse(key);
    const parsedBody = PromptSaveInputSchema.parse({ body: defaultBody }).body;
    let result: PromptSeedResult | null = null;

    getRuntime().seedPromptIfMissingTransaction(
      {
        body: parsedBody,
        bodySha256: hashPromptBody(parsedBody),
        key: parsedKey,
        now: new Date().toISOString(),
        source: PromptRevisionSourceSchema.parse("seed"),
      },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Prompt seed did not complete");
    }

    return result;
  }

  // ---- Per-repository environment package overrides ----

  function getRepoEnvironment(repo: string): {
    currentRevisionId: number;
    definitionHash: string | null;
    environmentId: string | null;
    packages: RepoEnvironmentPackages;
    repo: string;
    updatedAt: string;
  } | null {
    const parsed = RepoEnvironmentIdentifierSchema.parse({ repo });
    const row = getRuntime().statements.getRepoEnvironmentByRepo.get(parsed.repo);
    return row == null ? null : parseRepoEnvironmentWithPackages(row);
  }

  function getRepoEnvironmentRevisions(repo: string): RepoEnvironmentRevisionRow[] {
    const parsed = RepoEnvironmentIdentifierSchema.parse({ repo });
    return getRuntime()
      .statements.getRepoEnvironmentRevisionsByRepo.all(parsed.repo)
      .map((row) => parseRepoEnvironmentRevisionJsonRow(row));
  }

  function getRepoEnvironmentRevision(
    repo: string,
    revisionId: number,
  ): RepoEnvironmentRevisionRow | null {
    const parsed = RepoEnvironmentRestoreInputSchema.parse({ repo, revisionId });
    const row = getRuntime().statements.getRepoEnvironmentRevisionByRepoAndId.get(
      parsed.repo,
      parsed.revisionId,
    );
    return row == null ? null : parseRepoEnvironmentRevisionJsonRow(row);
  }

  function saveRepoEnvironmentRevision(
    input: { packages: Partial<RepoEnvironmentPackages>; repo: string; source: "edit" | "restore" },
    opts: { allowDuplicatePackages?: boolean } = {},
  ): RepoEnvironmentSaveResult {
    const parsedRepo = RepoEnvironmentIdentifierSchema.parse({ repo: input.repo }).repo;
    const parsedPackages = RepoEnvironmentSaveInputSchema.parse({
      packages: input.packages,
    }).packages;
    const parsedSource = RepoEnvironmentRevisionSourceSchema.parse(input.source);
    const packagesJson = canonicalizePackages(parsedPackages);
    let result: RepoEnvironmentSaveResult | null = null;

    getRuntime().saveRepoEnvironmentRevisionTransaction(
      {
        allowDuplicatePackages: opts.allowDuplicatePackages === true,
        now: new Date().toISOString(),
        packagesJson,
        packagesSha256: hashPackagesJson(packagesJson),
        repo: parsedRepo,
        source: parsedSource,
      },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Repo environment revision save did not complete");
    }

    return result;
  }

  function restoreRepoEnvironmentToRevision(
    repo: string,
    revisionId: number,
  ): RepoEnvironmentRestoreResult {
    const input = RepoEnvironmentRestoreInputSchema.parse({ repo, revisionId });
    let result: RepoEnvironmentRestoreResult | null = null;

    getRuntime().restoreRepoEnvironmentToRevisionTransaction(
      {
        now: new Date().toISOString(),
        repo: input.repo,
        revisionId: input.revisionId,
      },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Repo environment restore did not complete");
    }

    return result;
  }

  function deleteRepoEnvironment(repo: string): { deleted: boolean } {
    const parsed = RepoEnvironmentIdentifierSchema.parse({ repo });
    let result: { deleted: boolean } | null = null;

    getRuntime().deleteRepoEnvironmentTransaction({ repo: parsed.repo }, (nextResult) => {
      result = nextResult;
    });

    if (result === null) {
      throw new Error("Repo environment delete did not complete");
    }

    return result;
  }

  function listRepoEnvironmentOverrides(opts: { repo?: string } = {}): Array<{
    currentRevisionId: number;
    definitionHash: string | null;
    environmentId: string | null;
    repo: string;
    revisionCount: number;
    updatedAt: string;
  }> {
    const { statements } = getRuntime();
    const rows =
      opts.repo === undefined
        ? statements.listRepoEnvironmentOverrides.all()
        : statements.listRepoEnvironmentOverridesByRepo.all(
            RepoEnvironmentIdentifierSchema.parse({ repo: opts.repo }).repo,
          );

    return rows.map((row) => ({
      currentRevisionId: RepoEnvironmentRowSchema.shape.currentRevisionId.parse(
        row.currentRevisionId,
      ),
      definitionHash: RepoEnvironmentRowSchema.shape.definitionHash.parse(row.definitionHash),
      environmentId: RepoEnvironmentRowSchema.shape.environmentId.parse(row.environmentId),
      repo: RepoSlugSchema.parse(row.repo),
      revisionCount: Number(row.revisionCount),
      updatedAt: RepoEnvironmentRowSchema.shape.updatedAt.parse(row.updatedAt),
    }));
  }

  function setRepoEnvironmentAnthropicState(
    repo: string,
    state: { definitionHash: string; environmentId: string },
  ): void {
    const parsedRepo = RepoEnvironmentIdentifierSchema.parse({ repo }).repo;
    const parsedEnvironmentId = RepoEnvironmentRowSchema.shape.environmentId.parse(
      state.environmentId,
    );
    const parsedDefinitionHash = RepoEnvironmentRowSchema.shape.definitionHash.parse(
      state.definitionHash,
    );

    if (parsedEnvironmentId === null || parsedDefinitionHash === null) {
      throw new Error("Repo environment Anthropic state must be non-null");
    }

    const changes = readChanges(
      getRuntime().statements.setRepoEnvironmentAnthropicState.run(
        parsedEnvironmentId,
        parsedDefinitionHash,
        new Date().toISOString(),
        parsedRepo,
      ),
    );

    if (changes === 0) {
      throw new Error(`Repo environment not found for ${parsedRepo}`);
    }
  }

  // ---- Per-repository prompt overrides ----

  function getRepoPrompt(
    repo: string,
    agent: RepoPromptAgent,
  ): {
    agent: RepoPromptAgent;
    body: string;
    currentRevisionId: number;
    repo: string;
    updatedAt: string;
  } | null {
    const parsedRepo = RepoSlugSchema.parse(repo);
    const parsedAgent = RepoPromptAgentSchema.parse(agent);
    const row = getRuntime().statements.getRepoPromptByKey.get(parsedRepo, parsedAgent);
    return row == null ? null : parseRepoPromptWithBody(row);
  }

  function getRepoPromptRevisions(repo: string, agent: RepoPromptAgent): RepoPromptRevisionRow[] {
    const parsedRepo = RepoSlugSchema.parse(repo);
    const parsedAgent = RepoPromptAgentSchema.parse(agent);
    return getRuntime()
      .statements.getRepoPromptRevisionsByKey.all(parsedRepo, parsedAgent)
      .map((row) => RepoPromptRevisionRowSchema.parse(row));
  }

  function getRepoPromptRevision(
    repo: string,
    agent: RepoPromptAgent,
    revisionId: number,
  ): RepoPromptRevisionRow | null {
    const parsed = RepoPromptRestoreInputSchema.parse({ agent, repo, revisionId });
    const row = getRuntime().statements.getRepoPromptRevisionByKeyAndId.get(
      parsed.repo,
      parsed.agent,
      parsed.revisionId,
    );
    return row == null ? null : RepoPromptRevisionRowSchema.parse(row);
  }

  function saveRepoPromptRevision(
    input: { agent: RepoPromptAgent; body: string; repo: string; source: "edit" | "restore" },
    opts: { allowDuplicateBody?: boolean } = {},
  ): RepoPromptSaveResult {
    const normalizedBody = normalizePromptBody(input.body);
    const parsedBody = RepoPromptSaveInputSchema.parse({ body: normalizedBody }).body;
    const parsedRepo = RepoSlugSchema.parse(input.repo);
    const parsedAgent = RepoPromptAgentSchema.parse(input.agent);
    const parsedSource = RepoPromptRevisionSourceSchema.parse(input.source);
    let result: RepoPromptSaveResult | null = null;

    getRuntime().saveRepoPromptRevisionTransaction(
      {
        agent: parsedAgent,
        allowDuplicateBody: opts.allowDuplicateBody === true,
        body: parsedBody,
        bodySha256: hashPromptBody(parsedBody),
        now: new Date().toISOString(),
        repo: parsedRepo,
        source: parsedSource,
      },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Repo prompt revision save did not complete");
    }

    return result;
  }

  function restoreRepoPromptToRevision(
    repo: string,
    agent: RepoPromptAgent,
    revisionId: number,
  ): RepoPromptRestoreResult {
    const input = RepoPromptRestoreInputSchema.parse({ agent, repo, revisionId });
    let result: RepoPromptRestoreResult | null = null;

    getRuntime().restoreRepoPromptToRevisionTransaction(
      {
        agent: input.agent,
        now: new Date().toISOString(),
        repo: input.repo,
        revisionId: input.revisionId,
      },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Repo prompt restore did not complete");
    }

    return result;
  }

  function deleteRepoPrompt(repo: string, agent: RepoPromptAgent): { deleted: boolean } {
    const parsed = RepoPromptIdentifierSchema.parse({ agent, repo });
    let result: { deleted: boolean } | null = null;

    getRuntime().deleteRepoPromptTransaction(
      { agent: parsed.agent, repo: parsed.repo },
      (nextResult) => {
        result = nextResult;
      },
    );

    if (result === null) {
      throw new Error("Repo prompt delete did not complete");
    }

    return result;
  }

  function listRepoPromptOverrides(opts: { repo?: string } = {}): Array<{
    agent: RepoPromptAgent;
    currentRevisionId: number;
    repo: string;
    revisionCount: number;
    updatedAt: string;
  }> {
    const { statements } = getRuntime();
    const rows =
      opts.repo === undefined
        ? statements.listRepoPromptOverrides.all()
        : statements.listRepoPromptOverridesByRepo.all(RepoSlugSchema.parse(opts.repo));

    return rows.map((row) => ({
      agent: RepoPromptAgentSchema.parse(row.agent),
      currentRevisionId: RepoPromptRowSchema.shape.currentRevisionId.parse(row.currentRevisionId),
      repo: RepoSlugSchema.parse(row.repo),
      revisionCount: Number(row.revisionCount),
      updatedAt: RepoPromptRowSchema.shape.updatedAt.parse(row.updatedAt),
    }));
  }

  function hasProcessedTriggerSource(dedupeKey: string): boolean {
    if (typeof dedupeKey !== "string" || dedupeKey.length === 0) {
      throw new Error("dedupeKey must be a non-empty string");
    }

    const row = getRuntime().statements.countGithubTriggerDedupe.get(dedupeKey);
    return Number(row?.count ?? 0) > 0;
  }

  function parsePolledRepositoryRow(row: PolledRepositoryRow): PolledRepository {
    const repo = REPO_SCHEMA.parse(row.repo);
    if (typeof row.addedAt !== "string" || row.addedAt.length === 0) {
      throw new Error(`polled_repositories.added_at malformed for ${repo}`);
    }
    if (typeof row.updatedAt !== "string" || row.updatedAt.length === 0) {
      throw new Error(`polled_repositories.updated_at malformed for ${repo}`);
    }

    return {
      addedAt: row.addedAt,
      enabled: Boolean(row.enabled),
      repo,
      updatedAt: row.updatedAt,
    };
  }

  function addPolledRepository(repo: string): { added: boolean } {
    const parsedRepo = REPO_SCHEMA.parse(repo);
    const { statements } = getRuntime();
    const existing = statements.getPolledRepository.get(parsedRepo);
    if (existing != null) {
      return { added: false };
    }

    const now = new Date().toISOString();
    statements.upsertPolledRepository.run(parsedRepo, 1, now, now);
    return { added: true };
  }

  function setPolledRepositoryEnabled(repo: string, enabled: boolean): { updated: boolean } {
    const parsedRepo = REPO_SCHEMA.parse(repo);
    const { statements } = getRuntime();
    const changes = readChanges(
      statements.setPolledRepositoryEnabled.run(
        enabled ? 1 : 0,
        new Date().toISOString(),
        parsedRepo,
      ),
    );

    return { updated: changes > 0 };
  }

  function removePolledRepository(repo: string): { removed: boolean } {
    const parsedRepo = REPO_SCHEMA.parse(repo);
    const changes = readChanges(getRuntime().statements.deletePolledRepository.run(parsedRepo));
    return { removed: changes > 0 };
  }

  function listPolledRepositories(opts: { enabledOnly?: boolean } = {}): PolledRepository[] {
    const { statements } = getRuntime();
    const rows =
      opts.enabledOnly === true
        ? statements.listEnabledPolledRepositories.all()
        : statements.listPolledRepositories.all();
    return rows.map((row) => parsePolledRepositoryRow(row));
  }

  function getPolledRepository(repo: string): PolledRepository | null {
    const parsedRepo = REPO_SCHEMA.parse(repo);
    const row = getRuntime().statements.getPolledRepository.get(parsedRepo);
    return row == null ? null : parsePolledRepositoryRow(row);
  }

  function markTriggerSourceProcessed(input: {
    dedupeKey: string;
    issueNumber: number;
    repo: string;
    runId: string | null;
    source: GithubTriggerSource;
    sourceId: string;
  }): void {
    if (typeof input.dedupeKey !== "string" || input.dedupeKey.length === 0) {
      throw new Error("dedupeKey must be a non-empty string");
    }

    if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
      throw new Error("issueNumber must be a positive integer");
    }

    if (typeof input.sourceId !== "string" || input.sourceId.length === 0) {
      throw new Error("sourceId must be a non-empty string");
    }

    const parsedRepo = REPO_SCHEMA.parse(input.repo);
    const parsedSource = parseGithubTriggerSource(input.source);

    getRuntime().statements.insertGithubTriggerDedupe.run(
      input.dedupeKey,
      parsedRepo,
      input.issueNumber,
      parsedSource,
      input.sourceId,
      input.runId,
      new Date().toISOString(),
    );
  }

  function parseMcpServerRow(row: McpServerDbRow): McpServer {
    const parsed = McpServerRowSchema.parse({
      id: row.id,
      name: row.name,
      url: row.url,
      tokenEnvName: row.tokenEnvName,
      permissionPolicy: row.permissionPolicy,
      enabled: Boolean(row.enabled),
      isBuiltin: Boolean(row.isBuiltin),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
    return parsed;
  }

  function parseRepoChatStateRow(row: RepoChatStateDbRow): RepoChatState {
    return RepoChatStateSchema.parse(row);
  }

  function parseRepoChatThreadRow(row: RepoChatThreadRow): RepoChatThreadRow {
    return RepoChatThreadRowSchema.parse(row);
  }

  function parseRepoChatMessageRow(row: RepoChatMessageRow): RepoChatMessageRow {
    return RepoChatMessageRowSchema.parse(row);
  }

  function listMcpServers(opts: { enabledOnly?: boolean } = {}): McpServer[] {
    const { statements } = getRuntime();
    const rows =
      opts.enabledOnly === true
        ? statements.listEnabledMcpServers.all()
        : statements.listMcpServers.all();
    return rows.map((row) => parseMcpServerRow(row));
  }

  function getMcpServerById(id: number): McpServer | null {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("mcp server id must be a positive integer");
    }

    const row = getRuntime().statements.getMcpServerById.get(id);
    return row == null ? null : parseMcpServerRow(row);
  }

  function getMcpServerByName(name: string): McpServer | null {
    const parsedName = McpServerNameSchema.parse(name);
    const row = getRuntime().statements.getMcpServerByName.get(parsedName);
    return row == null ? null : parseMcpServerRow(row);
  }

  function createMcpServer(input: unknown): McpServer {
    const parsed = McpServerCreateInputSchema.parse(input);
    const { statements } = getRuntime();

    const existing = statements.getMcpServerByName.get(parsed.name);
    if (existing != null) {
      throw new Error(`mcp server "${parsed.name}" already exists`);
    }

    const now = new Date().toISOString();
    const inserted = statements.insertMcpServer.get(
      parsed.name,
      parsed.url,
      parsed.tokenEnvName,
      parsed.permissionPolicy,
      parsed.enabled ? 1 : 0,
      0,
      now,
      now,
    );
    if (inserted == null || typeof inserted.id !== "number") {
      throw new Error("Failed to retrieve inserted mcp server id");
    }

    const created = statements.getMcpServerById.get(inserted.id);
    if (created == null) {
      throw new Error("Inserted mcp server could not be re-fetched");
    }
    return parseMcpServerRow(created);
  }

  /**
   * Update an MCP server row. For builtin rows (`is_builtin = 1`) the
   * `name` and `url` are immutable; passing them is silently ignored.
   * For non-builtin rows all fields are updatable.
   */
  function updateMcpServer(id: number, input: unknown): McpServer {
    const parsed = McpServerUpdateInputSchema.parse(input);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("mcp server id must be a positive integer");
    }

    const { statements } = getRuntime();
    const existing = statements.getMcpServerById.get(id);
    if (existing == null) {
      throw new Error(`mcp server #${id} not found`);
    }

    const now = new Date().toISOString();
    const name = parsed.name ?? existing.name;
    const tokenEnvName = parsed.tokenEnvName ?? existing.tokenEnvName;
    const permissionPolicy = (parsed.permissionPolicy ??
      existing.permissionPolicy) as McpPermissionPolicy;
    const enabled = parsed.enabled ?? Boolean(existing.enabled);

    if (existing.isBuiltin === 1) {
      if (!enabled) {
        throw new Error("builtin GitHub MCP server cannot be disabled");
      }

      statements.updateBuiltinMcpServer.run(
        tokenEnvName,
        permissionPolicy,
        enabled ? 1 : 0,
        now,
        id,
      );
    } else {
      const url = parsed.url ?? existing.url;
      if (name !== existing.name && statements.getMcpServerByName.get(name) != null) {
        throw new Error(`mcp server "${name}" already exists`);
      }

      statements.updateMcpServer.run(
        name,
        url,
        tokenEnvName,
        permissionPolicy,
        enabled ? 1 : 0,
        now,
        id,
      );
    }

    const updated = statements.getMcpServerById.get(id);
    if (updated == null) {
      throw new Error("Updated mcp server could not be re-fetched");
    }
    return parseMcpServerRow(updated);
  }

  function setMcpServerEnabled(id: number, enabled: boolean): { updated: boolean } {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("mcp server id must be a positive integer");
    }

    const { statements } = getRuntime();
    const existing = statements.getMcpServerById.get(id);
    if (existing == null) {
      return { updated: false };
    }

    if (existing.isBuiltin === 1 && !enabled) {
      throw new Error("builtin GitHub MCP server cannot be disabled");
    }

    const changes = readChanges(
      statements.setMcpServerEnabled.run(enabled ? 1 : 0, new Date().toISOString(), id),
    );
    return { updated: changes > 0 };
  }

  /**
   * Delete an MCP server. Builtin rows are protected: the underlying
   * DELETE is filtered by `is_builtin = 0` so a builtin delete is a no-op
   * at the SQL level. We surface that as `{ deleted: false }`.
   */
  function deleteMcpServer(id: number): { deleted: boolean } {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("mcp server id must be a positive integer");
    }

    const changes = readChanges(getRuntime().statements.deleteMcpServer.run(id));
    return { deleted: changes > 0 };
  }

  function getRepoChatState(): RepoChatState | null {
    const row = getRuntime().statements.getRepoChatState.get();
    return row == null ? null : parseRepoChatStateRow(row);
  }

  function setRepoChatAgentState(input: {
    agentDefinitionHash: string;
    agentId: string;
    agentVersion: number;
  }): void {
    const parsed = RepoChatStateSchema.pick({
      agentDefinitionHash: true,
      agentId: true,
      agentVersion: true,
    }).parse(input);

    if (
      parsed.agentDefinitionHash === null ||
      parsed.agentId === null ||
      parsed.agentVersion === null
    ) {
      throw new Error("repo chat agent state must be non-null");
    }

    getRuntime().statements.upsertRepoChatAgentState.run(
      parsed.agentId,
      parsed.agentVersion,
      parsed.agentDefinitionHash,
      new Date().toISOString(),
    );
  }

  function setRepoChatEnvironmentState(input: {
    environmentDefinitionHash: string;
    environmentId: string;
  }): void {
    const parsed = RepoChatStateSchema.pick({
      environmentDefinitionHash: true,
      environmentId: true,
    }).parse(input);

    if (parsed.environmentDefinitionHash === null || parsed.environmentId === null) {
      throw new Error("repo chat environment state must be non-null");
    }

    getRuntime().statements.upsertRepoChatEnvironmentState.run(
      parsed.environmentId,
      parsed.environmentDefinitionHash,
      new Date().toISOString(),
    );
  }

  function createRepoChatThread(input: {
    id: string;
    repo: string;
    title: string;
  }): RepoChatThreadRow {
    const now = new Date().toISOString();
    const parsed = RepoChatThreadRowSchema.parse({
      createdAt: now,
      id: input.id,
      repo: input.repo,
      title: input.title,
      updatedAt: now,
    });

    getRuntime().statements.insertRepoChatThread.run(
      parsed.id,
      parsed.repo,
      parsed.title,
      parsed.createdAt,
      parsed.updatedAt,
    );
    return parsed;
  }

  function getRepoChatThread(threadId: string): RepoChatThreadRow | null {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      throw new Error("repo chat thread id must be a non-empty string");
    }

    const row = getRuntime().statements.getRepoChatThreadById.get(threadId);
    return row == null ? null : parseRepoChatThreadRow(row);
  }

  function listRepoChatThreads(repo: string, opts: { limit?: number } = {}): RepoChatThreadRow[] {
    const parsedRepo = RepoSlugSchema.parse(repo);
    const limit = Math.max(1, Math.min(100, opts.limit ?? 20));
    return getRuntime()
      .statements.listRepoChatThreadsByRepo.all(parsedRepo, limit)
      .map((row) => parseRepoChatThreadRow(row));
  }

  function listRepoChatRepositories(): Array<{
    lastChatAt: string | null;
    repo: string;
    threadCount: number;
  }> {
    return getRuntime()
      .statements.listRepoChatRepositories.all()
      .map((row) => ({
        lastChatAt:
          row.lastChatAt === null
            ? null
            : RepoChatThreadRowSchema.shape.updatedAt.parse(row.lastChatAt),
        repo: RepoSlugSchema.parse(row.repo),
        threadCount: Number(row.threadCount),
      }));
  }

  function insertRepoChatMessage(input: {
    content: string;
    id: string;
    role: RepoChatMessageRole;
    sessionId?: string | null;
    threadId: string;
  }): RepoChatMessageRow {
    const now = new Date().toISOString();
    const parsed = RepoChatMessageRowSchema.parse({
      content: input.content,
      createdAt: now,
      id: input.id,
      role: input.role,
      sessionId: input.sessionId ?? null,
      threadId: input.threadId,
    });

    const { statements } = getRuntime();
    statements.insertRepoChatMessage.run(
      parsed.id,
      parsed.threadId,
      parsed.role,
      parsed.content,
      parsed.sessionId,
      parsed.createdAt,
    );
    statements.touchRepoChatThread.run(parsed.createdAt, parsed.threadId);
    return parsed;
  }

  function listRepoChatMessages(threadId: string): RepoChatMessageRow[] {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      throw new Error("repo chat thread id must be a non-empty string");
    }

    return getRuntime()
      .statements.listRepoChatMessagesByThread.all(threadId)
      .map((row) => parseRepoChatMessageRow(row));
  }

  function close(): void {
    db.close();
  }

  return {
    close,
    createRepoChatThread,
    createMcpServer,
    deleteMcpServer,
    deleteRepoEnvironment,
    deleteRepoPrompt,
    getGlobalUsageAggregate,
    getMcpServerById,
    getMcpServerByName,
    getPrompt,
    getPromptRevision,
    getPromptRevisions,
    getRepoEnvironment,
    getRepoEnvironmentRevision,
    getRepoEnvironmentRevisions,
    getRepoChatState,
    getRepoChatThread,
    getRepoPrompt,
    getRepoPromptRevision,
    getRepoPromptRevisions,
    getRepoUsageAggregate,
    getRunById,
    getRunStatus,
    getRunsByRepo,
    getRunUsageAggregate,
    getSessionsByRun,
    getSessionUsageBySession,
    getSessionUsagesByRun,
    addPolledRepository,
    getPolledRepository,
    getSubIssuesByRun,
    hasProcessedTriggerSource,
    initDb,
    insertRun,
    insertRunEvent,
    insertRepoChatMessage,
    insertSession,
    insertSessionPlaceholder,
    insertSubIssue,
    listMcpServers,
    listPolledRepositories,
    listRepoChatMessages,
    listRepoChatRepositories,
    listRepoChatThreads,
    listRepositories,
    markTriggerSourceProcessed,
    removePolledRepository,
    setMcpServerEnabled,
    setPolledRepositoryEnabled,
    listRepoEnvironmentOverrides,
    listRepoPromptOverrides,
    listRepoUsageAggregates,
    listRunEvents,
    listRuns,
    listRunUsageAggregates,
    resyncOrphanedRuns,
    restorePromptToRevision,
    restoreRepoEnvironmentToRevision,
    restoreRepoPromptToRevision,
    savePromptRevision,
    saveRepoEnvironmentRevision,
    saveRepoPromptRevision,
    seedPromptIfMissing,
    setRepoChatAgentState,
    setRepoChatEnvironmentState,
    setRepoEnvironmentAnthropicState,
    setRunPhase,
    setRunStatus,
    setRunStatusIfCurrent,
    updateMcpServer,
  };
}
