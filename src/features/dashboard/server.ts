/** @jsxImportSource hono/jsx */
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { type Context, Hono } from "hono";
import type { FC } from "hono/jsx";
import { jsx, jsxs } from "hono/jsx/jsx-runtime";
import type { Logger } from "pino";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { Layout } from "@/features/dashboard/components/layout";
import {
  DEFAULT_LOCALE,
  isLocale,
  localeCookie,
  localeFromAcceptLanguageHeader,
  localeFromCookieHeader,
  sanitizeLocaleRedirectPath,
  t,
  withDashboardI18n,
} from "@/features/dashboard/i18n";
import { createLiveTailStream } from "@/features/dashboard/live-tail";
import {
  McpServerDetailPage,
  type McpServerDetailPageProps,
} from "@/features/dashboard/pages/mcp-server-detail";
import {
  type McpServerEntry,
  McpServersPage,
  type McpServersPageProps,
} from "@/features/dashboard/pages/mcp-servers";
import {
  PromptDetailPage,
  type PromptRevisionView,
} from "@/features/dashboard/pages/prompt-detail";
import {
  type PromptListEntry,
  PromptsListPage,
  type RepoPromptOverrideEntry,
} from "@/features/dashboard/pages/prompts-list";
import {
  type RepoChatContextSummary,
  type RepoChatMessageView,
  RepoChatPage,
  type RepoChatThreadView,
} from "@/features/dashboard/pages/repo-chat";
import {
  RepoDetailPage,
  type RepoEnvironmentSummary,
  type RepoPromptSlot,
  type RepoTriggerSummary,
} from "@/features/dashboard/pages/repo-detail";
import {
  RepoEnvironmentDetailPage,
  type RepoEnvironmentDetailPageProps,
} from "@/features/dashboard/pages/repo-environment-detail";
import {
  RepoPromptDetailPage,
  type RepoPromptDetailPageProps,
} from "@/features/dashboard/pages/repo-prompt-detail";
import { RepositoriesPage, type Repository } from "@/features/dashboard/pages/repositories";
import { RunDetailPage, type RunDetailPageProps } from "@/features/dashboard/pages/run-detail";
import { RunLivePage, type RunLivePageProps } from "@/features/dashboard/pages/run-live";
import { RunNewPage } from "@/features/dashboard/pages/run-new";
import { RunsPage, type RunSummary as RunsPageRunSummary } from "@/features/dashboard/pages/runs";
import { failureFromRunEvents, type RunFailure } from "@/features/dashboard/run-failure";
import {
  type GithubTriggerConfig,
  GithubTriggerConfigSchema,
  RepoSlugSchema as TriggerRepoSlugSchema,
} from "@/features/github-trigger/schemas";
import {
  type RepositoryChatAnthropicClient,
  type RepositoryChatContextFlags,
  type RepositoryChatDeps,
  RepositoryChatSessionError,
  runRepositoryChatTurn,
} from "@/features/repo-chat/handler";
import { RunStartInputSchema } from "@/features/run-api/schemas";
import {
  ensureEnvironment as defaultEnsureEnvironment,
  ensureEnvironmentForRepo as defaultEnsureEnvironmentForRepo,
} from "@/shared/agents/environment";
import { type Config, ConfigSchema } from "@/shared/config";
import type { GitHubAuthProvider } from "@/shared/github";
import { createLogger } from "@/shared/logging";
import {
  type EditablePromptKey,
  EditablePromptKeySchema,
  emptyUsageAggregate,
  McpServerCreateInputSchema,
  McpServerUpdateInputSchema,
  type PromptKey,
  PromptKeySchema,
  type PromptRevisionRow,
  PromptSaveInputSchema,
  type RepoEnvironmentPackages,
  RepoEnvironmentSaveInputSchema,
  type RepoPromptAgent,
  RepoPromptAgentSchema,
  RepoPromptSaveInputSchema,
  RepoSlugSchema,
  type UsageAggregate,
} from "@/shared/persistence/schemas";
import { getDefaultPrompt } from "@/shared/prompts/defaults";
import { fallbackRunOrigin, hasEnabledLinearMcpServer, originDisplay } from "@/shared/run-origin";
import { runSession as defaultRunSession, type SessionClient } from "@/shared/session";
import type { RunStatus } from "@/shared/types";
import {
  ensureMcpCredentials as defaultEnsureMcpCredentials,
  ensureVault as defaultEnsureVault,
} from "@/shared/vault";

type DbModule = ReturnType<typeof import("@/shared/persistence/db").createDbModule>;
type McpServerRecord = NonNullable<ReturnType<DbModule["getMcpServerById"]>>;
type McpServerUpdateInput = z.infer<typeof McpServerUpdateInputSchema>;
type DeferredModuleReference<TPath extends string, TFactory extends string> = {
  readonly modulePath?: TPath;
  readonly factoryName?: TFactory;
};
type RunQueueModule = Pick<
  ReturnType<typeof import("@/features/run-queue/handler").createRunQueueModule>,
  "enqueue"
>;
type RunEventsModule = DeferredModuleReference<
  "@/features/run-events/handler",
  "createRunEventsModule"
>;
type RunExecutionModule = DeferredModuleReference<
  "@/features/run-execution/handler",
  "createRunExecutionModule"
>;

const PROMPT_KEYS: PromptKey[] = [
  "parent.system",
  "child.system",
  "parent.runtime",
  "child.runtime",
];
const REPO_PROMPT_AGENTS: RepoPromptAgent[] = ["parent", "child"];
const McpServerIdSchema = z.coerce.number().int().positive();
const RestoreRevisionIdSchema = z.coerce.number().int().positive();

type NoChangeNotice = { kind: "no_change" | "already_current" };

function emptyRepoEnvironmentPackages(): RepoEnvironmentPackages {
  return {
    apt: [],
    cargo: [],
    gem: [],
    go: [],
    npm: [],
    pip: [],
  };
}

function parsePackageSpecLines(value: string): string[] {
  return value
    .replace(/\r\n/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function formStringValue(form: Record<string, unknown>, field: string): string | null {
  const value = form[field];
  if (value === undefined) {
    return "";
  }

  return typeof value === "string" ? value : null;
}

function parseRepoEnvironmentPackagesForm(
  form: Record<string, unknown>,
): RepoEnvironmentPackages | null {
  const apt = formStringValue(form, "apt");
  const cargo = formStringValue(form, "cargo");
  const gem = formStringValue(form, "gem");
  const go = formStringValue(form, "go");
  const npm = formStringValue(form, "npm");
  const pip = formStringValue(form, "pip");

  if (
    apt === null ||
    cargo === null ||
    gem === null ||
    go === null ||
    npm === null ||
    pip === null
  ) {
    return null;
  }

  return {
    apt: parsePackageSpecLines(apt),
    cargo: parsePackageSpecLines(cargo),
    gem: parsePackageSpecLines(gem),
    go: parsePackageSpecLines(go),
    npm: parsePackageSpecLines(npm),
    pip: parsePackageSpecLines(pip),
  };
}

function totalPackageCount(p: RepoEnvironmentPackages): number {
  return p.apt.length + p.cargo.length + p.gem.length + p.go.length + p.npm.length + p.pip.length;
}

function perManagerCount(p: RepoEnvironmentPackages): {
  apt: number;
  cargo: number;
  gem: number;
  go: number;
  npm: number;
  pip: number;
} {
  return {
    apt: p.apt.length,
    cargo: p.cargo.length,
    gem: p.gem.length,
    go: p.go.length,
    npm: p.npm.length,
    pip: p.pip.length,
  };
}

function repoSlugFromParams(owner: string, name: string): string | null {
  const parsed = RepoSlugSchema.safeParse(`${owner}/${name}`);
  return parsed.success ? parsed.data : null;
}

function repoPromptAgentLabel(agent: RepoPromptAgent): string {
  return agent === "parent" ? "parent" : "child";
}

type PromptWithBody = {
  body: string;
  currentRevisionId: number;
  promptKey: PromptKey;
  updatedAt: string;
};

export type CreateAppOptions = {
  db: DbModule;
  anthropicClient?: SessionClient;
  config?: Config;
  /**
   * Cross-repo tunables surfaced in the WebUI for the GitHub Issue auto-trigger
   * feature (the bot mention prefix and the trigger label name). When omitted,
   * the schema defaults are used so the dashboard is renderable without env
   * configuration.
   */
  githubTriggerConfig?: GithubTriggerConfig;
  githubAuth?: GitHubAuthProvider;
  logger?: Logger;
  repoChat?: Partial<
    Pick<
      RepositoryChatDeps,
      | "anthropicClient"
      | "ensureEnvironment"
      | "ensureEnvironmentForRepo"
      | "ensureMcpCredentials"
      | "ensureVault"
      | "runSession"
      | "timeoutMs"
    >
  >;
  runEvents?: RunEventsModule;
  runExecution?: RunExecutionModule;
  runQueue?: RunQueueModule;
  staticAssetsDir?: string;
};

const ASSETS_ROUTE_PREFIX = "/assets/";
const RUN_LIST_LIMIT = 10_000;
const RUN_FAILURE_EVENT_TAIL_LIMIT = 50;
const REPO_CHAT_THREAD_LIST_LIMIT = 20;
const DEFAULT_CONFIG = ConfigSchema.parse({});

function renderDocument(jsx: unknown): string {
  return `<!doctype html>${String(jsx)}`;
}

type HtmlStatus = 200 | 400 | 404 | 503;

function requestPathWithSearch(c: Context): string {
  const url = new URL(c.req.url);
  return `${url.pathname}${url.search}`;
}

// Resolution order: explicit user choice (cookie) wins, otherwise honor the
// browser's Accept-Language preference, otherwise fall back to DEFAULT_LOCALE.
function requestLocale(c: Context) {
  return (
    localeFromCookieHeader(c.req.header("Cookie")) ??
    localeFromAcceptLanguageHeader(c.req.header("Accept-Language")) ??
    DEFAULT_LOCALE
  );
}

function htmlPage(
  c: Context,
  jsxFactory: () => unknown,
  status?: HtmlStatus,
): Response | Promise<Response> {
  const html = withDashboardI18n(
    { currentPath: requestPathWithSearch(c), locale: requestLocale(c) },
    () => renderDocument(jsxFactory()),
  );

  return status === undefined ? c.html(html) : c.html(html, status);
}

function runSummary(
  db: DbModule,
  runId: string,
): ReturnType<DbModule["listRuns"]>[number] | undefined {
  return db.listRuns({ limit: RUN_LIST_LIMIT }).find((run) => run.runId === runId);
}

function runStatus(db: DbModule, runId: string): RunStatus | undefined {
  return runSummary(db, runId)?.status;
}

function runsPageSummary(
  db: DbModule,
  run: ReturnType<DbModule["listRuns"]>[number],
  usageByRunId: Map<string, UsageAggregate>,
): RunsPageRunSummary {
  const runState = db.getRunById(run.runId);
  const failure = failureForStatus(db, run.runId, run.status);

  return {
    ...run,
    // Per-task child results were tracked by the legacy `spawn_child_task`
    // custom tool. With the official multi-agent coordinator topology that
    // table is gone; failure context now lives in run events / thread events.
    failedChildResultCount: 0,
    failure,
    subIssueCount: runState?.subIssues.length ?? 0,
    usage: usageByRunId.get(run.runId) ?? emptyUsageAggregate(),
  };
}

function failureForStatus(
  db: DbModule,
  runId: string,
  status: RunStatus | undefined,
): RunFailure | undefined {
  if (status !== "failed" && status !== "aborted") {
    return undefined;
  }

  const events = db
    .listRunEvents({ limit: RUN_FAILURE_EVENT_TAIL_LIMIT, order: "desc", runId })
    .reverse();
  return failureFromRunEvents(events);
}

function repositoriesResponse(
  c: Context,
  db: DbModule,
  triggerCfg: GithubTriggerConfig,
): Response | Promise<Response> {
  const globalUsage = db.getGlobalUsageAggregate();
  const repoUsageByRepo = db.listRepoUsageAggregates();
  const polledByRepo = new Map(db.listPolledRepositories().map((row) => [row.repo, row]));
  const runSummariesByRepo = new Map(
    db.listRepositories().map((summary) => [summary.repo, summary]),
  );

  const repositories: Repository[] = db
    .listRegisteredRepositories()
    .map((registered) => {
      const summary = runSummariesByRepo.get(registered.repo) ?? {
        lastRunAt: null,
        repo: registered.repo,
        runCount: 0,
      };
      const polled = polledByRepo.get(registered.repo);
      return {
        ...summary,
        enabled: registered.enabled,
        polledTrigger: {
          configured: polled !== undefined,
          enabled: polled?.enabled ?? false,
        },
        usage: repoUsageByRepo.get(registered.repo) ?? emptyUsageAggregate(),
      };
    })
    .sort((a, b) => {
      // Repos with run history first (most recent first), polled-only repos last
      // (alphabetical) so newcomers are visible but don't outrank active work.
      if (a.lastRunAt !== null && b.lastRunAt !== null) {
        return a.lastRunAt < b.lastRunAt ? 1 : a.lastRunAt > b.lastRunAt ? -1 : 0;
      }
      if (a.lastRunAt !== null) return -1;
      if (b.lastRunAt !== null) return 1;
      return a.repo.localeCompare(b.repo);
    });

  return htmlPage(c, () =>
    RepositoriesPage({
      globalUsage,
      repositories,
      triggerBotMention: triggerCfg.botMention,
      triggerLabel: triggerCfg.triggerLabel,
    }),
  );
}

function mcpServerNeedsTokenEnv(server: { isBuiltin: boolean; tokenEnvName: string }): boolean {
  return !server.isBuiltin && server.tokenEnvName.length > 0;
}

function mcpServerEnvPresent(server: { isBuiltin: boolean; tokenEnvName: string }): boolean {
  if (!mcpServerNeedsTokenEnv(server)) {
    return true;
  }

  return (
    typeof process.env[server.tokenEnvName] === "string" &&
    (process.env[server.tokenEnvName]?.length ?? 0) > 0
  );
}

function toMcpServerEntry(server: McpServerRecord): McpServerEntry {
  return {
    createdAt: server.createdAt,
    enabled: server.enabled,
    envPresent: mcpServerEnvPresent(server),
    id: server.id,
    isBuiltin: server.isBuiltin,
    name: server.name,
    permissionPolicy: server.permissionPolicy,
    tokenEnvName: server.tokenEnvName,
    updatedAt: server.updatedAt,
    url: server.url,
  };
}

function listMcpServerEntries(db: DbModule): McpServerEntry[] {
  return db.listMcpServers().map(toMcpServerEntry);
}

function linearMcpEnabled(db: DbModule): boolean {
  return hasEnabledLinearMcpServer(db.listMcpServers());
}

function enabledRegisteredRepositorySlugs(db: DbModule): string[] {
  return db.listRegisteredRepositories({ enabledOnly: true }).map((repository) => repository.repo);
}

function getMcpServersNotice(notice: string | undefined): McpServersPageProps["notice"] {
  switch (notice) {
    case "added":
    case "duplicate":
    case "disabled":
    case "enabled":
    case "invalid":
    case "removed":
      return { kind: notice };
    default:
      return undefined;
  }
}

function getMcpServerDetailNotice(notice: string | undefined): McpServerDetailPageProps["notice"] {
  switch (notice) {
    case "invalid":
    case "no_change":
    case "updated":
      return { kind: notice };
    default:
      return undefined;
  }
}

function mcpServersResponse(c: Context, db: DbModule): Response | Promise<Response> {
  return htmlPage(c, () =>
    McpServersPage({
      notice: getMcpServersNotice(c.req.query("notice")),
      servers: listMcpServerEntries(db),
    }),
  );
}

function repoChatDepsFromOptions(opts: CreateAppOptions): RepositoryChatDeps | null {
  const anthropicClient =
    opts.repoChat?.anthropicClient ??
    (opts.anthropicClient as unknown as RepositoryChatAnthropicClient | undefined);
  if (anthropicClient === undefined || opts.githubAuth === undefined) {
    return null;
  }

  return {
    anthropicClient,
    config: opts.config ?? DEFAULT_CONFIG,
    db: opts.db,
    ensureEnvironment: opts.repoChat?.ensureEnvironment ?? defaultEnsureEnvironment,
    ensureEnvironmentForRepo:
      opts.repoChat?.ensureEnvironmentForRepo ?? defaultEnsureEnvironmentForRepo,
    ensureMcpCredentials: opts.repoChat?.ensureMcpCredentials ?? defaultEnsureMcpCredentials,
    ensureVault: opts.repoChat?.ensureVault ?? defaultEnsureVault,
    githubAuth: opts.githubAuth,
    logger: opts.logger ?? createLogger({ level: "silent" }),
    runSession: opts.repoChat?.runSession ?? defaultRunSession,
    ...(typeof opts.repoChat?.timeoutMs === "number" ? { timeoutMs: opts.repoChat.timeoutMs } : {}),
  };
}

function toRepoChatContextSummary(
  db: DbModule,
  repo: string,
  triggerCfg: GithubTriggerConfig,
  recentRuns: RunsPageRunSummary[],
  chatAvailable: boolean,
): RepoChatContextSummary {
  const envRow = db.getRepoEnvironment(repo);
  const polledRepo = db.getPolledRepository(repo);
  const mcpServers = listMcpServerEntries(db);

  return {
    chatAvailable,
    environment: {
      configured: envRow !== null,
      environmentId: envRow?.environmentId ?? null,
      packageCount: envRow === null ? 0 : totalPackageCount(envRow.packages),
    },
    mcp: {
      enabledCount: mcpServers.filter((server) => server.enabled).length,
      missingEnvCount: mcpServers.filter(
        (server) => server.enabled && mcpServerNeedsTokenEnv(server) && !server.envPresent,
      ).length,
      servers: mcpServers.map((server) => ({
        enabled: server.enabled,
        envPresent: server.envPresent,
        isBuiltin: server.isBuiltin,
        name: server.name,
        permissionPolicy: server.permissionPolicy,
        tokenEnvName: server.tokenEnvName,
      })),
      totalCount: mcpServers.length,
    },
    prompts: REPO_PROMPT_AGENTS.map((agent) => ({
      agent,
      configured: db.getRepoPrompt(repo, agent) !== null,
    })),
    recentRuns: recentRuns.slice(0, 5),
    trigger: {
      botMention: triggerCfg.botMention,
      configured: polledRepo !== null,
      enabled: polledRepo?.enabled ?? false,
      triggerLabel: triggerCfg.triggerLabel,
    },
  };
}

function formatRepoChatContextForPrompt(
  repo: string,
  context: RepoChatContextSummary,
  flags: RepositoryChatContextFlags,
): string {
  const sections: string[] = [`Repository: ${repo}`];

  if (flags.includeSettings) {
    const prompts = context.prompts
      .map((slot) => `${slot.agent}=${slot.configured ? "configured" : "not configured"}`)
      .join(", ");
    sections.push(
      [
        "Repository settings:",
        `- Prompt overrides: ${prompts}`,
        `- Environment packages: ${context.environment.configured ? `${context.environment.packageCount} packages` : "base environment only"}`,
        `- Anthropic environment id: ${context.environment.environmentId ?? "not synced"}`,
        `- Auto-trigger: ${context.trigger.configured ? (context.trigger.enabled ? "active" : "paused") : "not configured"}`,
        `- Trigger comment: @${context.trigger.botMention} run`,
        `- Trigger label: ${context.trigger.triggerLabel}`,
      ].join("\n"),
    );
  }

  if (flags.includeMcp) {
    sections.push(
      [
        "MCP availability:",
        `- Enabled servers: ${context.mcp.enabledCount}/${context.mcp.totalCount}`,
        `- Enabled servers with missing env: ${context.mcp.missingEnvCount}`,
        ...context.mcp.servers.map((server) => {
          const envStatus =
            server.isBuiltin || server.tokenEnvName.length === 0
              ? "not required"
              : `${server.tokenEnvName}=${server.envPresent ? "present" : "missing"}`;
          return `- ${server.name}: ${server.enabled ? "enabled" : "disabled"}, env ${envStatus}, policy=${server.permissionPolicy}${server.isBuiltin ? ", builtin" : ""}`;
        }),
      ].join("\n"),
    );
  }

  if (flags.includeRecentRuns) {
    sections.push(
      [
        "Recent runs:",
        context.recentRuns.length === 0
          ? "- No runs recorded for this repository."
          : context.recentRuns
              .map((run) => {
                const origin = fallbackRunOrigin(run);
                return `- ${run.runId}: status=${run.status}, origin=${origin ? originDisplay(origin) : "n/a"}, branch=${run.branch ?? "n/a"}, pr=${run.prUrl ?? "n/a"}`;
              })
              .join("\n"),
      ].join("\n"),
    );
  }

  if (flags.includeRepository) {
    const repoName = repo.split("/")[1] ?? repo;
    sections.push(
      [
        "Repository contents:",
        `- A short-lived Managed Agents session mounts this repository at /workspace/${repoName}.`,
        "- The chat system prompt requires read-only inspection only.",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

function toRepoChatMessageView(
  row: ReturnType<DbModule["listRepoChatMessages"]>[number],
): RepoChatMessageView {
  return {
    content: row.content,
    createdAt: row.createdAt,
    id: row.id,
    role: row.role,
    sessionId: row.sessionId,
  };
}

function toRepoChatThreadView(
  row: ReturnType<DbModule["listRepoChatThreads"]>[number],
): RepoChatThreadView {
  return {
    id: row.id,
    title: row.title,
    updatedAt: row.updatedAt,
  };
}

function repoChatThreadTitle(message: string): string {
  const firstLine = message.trim().split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.length === 0) {
    return "Repository chat";
  }

  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function parseRepoChatContextFlags(
  form: Record<string, unknown>,
): RepositoryChatContextFlags | null {
  const includeSettings = checkboxFormValue(form, "includeSettings");
  const includeMcp = checkboxFormValue(form, "includeMcp");
  const includeRepository = checkboxFormValue(form, "includeRepository");
  const includeRecentRuns = checkboxFormValue(form, "includeRecentRuns");

  if (
    includeSettings === null ||
    includeMcp === null ||
    includeRepository === null ||
    includeRecentRuns === null
  ) {
    return null;
  }

  return { includeMcp, includeRecentRuns, includeRepository, includeSettings };
}

function repoChatUnavailableMessage(): string {
  return "Managed Agents chat is unavailable: anthropicClient and GitHub authentication must be configured for the dashboard.";
}

function repoChatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Managed Agents chat failed";
}

function repoChatErrorSessionId(error: unknown): string | undefined {
  return error instanceof RepositoryChatSessionError ? error.sessionId : undefined;
}

function repoChatResponse(
  c: Context,
  opts: CreateAppOptions,
  repo: string,
): Response | Promise<Response> {
  const { db } = opts;
  const usageByRunId = db.listRunUsageAggregates();
  const recentRuns = db
    .listRuns({ limit: RUN_LIST_LIMIT, repo })
    .map((run) => runsPageSummary(db, run, usageByRunId));
  const threads = db.listRepoChatThreads(repo, { limit: REPO_CHAT_THREAD_LIST_LIMIT });
  const requestedThreadId = c.req.query("thread")?.trim();
  const newThreadRequested = c.req.query("new") === "1";
  const activeThread = newThreadRequested
    ? null
    : requestedThreadId
      ? db.getRepoChatThread(requestedThreadId)
      : (threads[0] ?? null);

  if (requestedThreadId && activeThread === null) {
    return htmlPage(
      c,
      () => NotFoundPage({ message: `chat thread "${requestedThreadId}" not found` }),
      404,
    );
  }

  if (activeThread !== null && activeThread.repo !== repo) {
    return htmlPage(
      c,
      () => NotFoundPage({ message: `chat thread "${activeThread.id}" not found` }),
      404,
    );
  }

  const messages =
    activeThread === null
      ? []
      : db.listRepoChatMessages(activeThread.id).map(toRepoChatMessageView);

  return htmlPage(c, () =>
    RepoChatPage({
      activeThreadId: activeThread?.id ?? null,
      context: toRepoChatContextSummary(
        db,
        repo,
        opts.githubTriggerConfig ?? GithubTriggerConfigSchema.parse({}),
        recentRuns,
        repoChatDepsFromOptions(opts) !== null,
      ),
      errorNotice: c.req.query("error"),
      messages,
      repo,
      threads: threads.map(toRepoChatThreadView),
    }),
  );
}

function parseMcpServerId(rawId: string): number | null {
  const parsed = McpServerIdSchema.safeParse(rawId);
  return parsed.success ? parsed.data : null;
}

function trimFormStringValue(form: Record<string, unknown>, field: string): string | null {
  const value = formStringValue(form, field);
  return value === null ? null : value.trim();
}

function checkboxFormValue(form: Record<string, unknown>, field: string): boolean | null {
  const value = form[field];
  if (value === undefined) {
    return false;
  }

  if (typeof value !== "string") {
    return null;
  }

  if (value === "on" || value === "true" || value === "1") {
    return true;
  }

  if (value === "off" || value === "false" || value === "0") {
    return false;
  }

  return null;
}

function parseMcpServerCreateForm(form: Record<string, unknown>): {
  enabled: boolean;
  name: string;
  permissionPolicy: string;
  tokenEnvName: string;
  url: string;
} | null {
  const enabled = checkboxFormValue(form, "enabled");
  const name = trimFormStringValue(form, "name");
  const permissionPolicy = trimFormStringValue(form, "permissionPolicy");
  const tokenEnvName = trimFormStringValue(form, "tokenEnvName");
  const url = trimFormStringValue(form, "url");

  if (
    enabled === null ||
    name === null ||
    permissionPolicy === null ||
    tokenEnvName === null ||
    url === null
  ) {
    return null;
  }

  return { enabled, name, permissionPolicy, tokenEnvName: tokenEnvName ?? "", url };
}

function parseMcpServerUpdateForm(
  form: Record<string, unknown>,
  server: McpServerRecord,
): unknown | null {
  const enabled = checkboxFormValue(form, "enabled");
  const name = trimFormStringValue(form, "name");
  const permissionPolicy = trimFormStringValue(form, "permissionPolicy");
  const tokenEnvName = trimFormStringValue(form, "tokenEnvName");
  const url = trimFormStringValue(form, "url");

  if (
    enabled === null ||
    name === null ||
    permissionPolicy === null ||
    tokenEnvName === null ||
    url === null
  ) {
    return null;
  }

  if (server.isBuiltin) {
    return { enabled, permissionPolicy, tokenEnvName: tokenEnvName ?? "" };
  }

  return { enabled, name, permissionPolicy, tokenEnvName: tokenEnvName ?? "", url };
}

function unsupportedMcpPermissionPolicyMessage(
  permissionPolicy: string | undefined,
): string | null {
  if (permissionPolicy !== "always_ask") {
    return null;
  }

  return 'MCP permission policy "always_ask" is not supported until tool confirmations are implemented';
}

function isDuplicateMcpServerNameError(message: string): boolean {
  return /^mcp server ".+" already exists$/.test(message);
}

function runStartValidationMessage(field: string): string {
  switch (field) {
    case "configPath":
      return "Config path must not be empty.";
    case "dryRun":
      return "Dry run must be true or false.";
    case "issue":
      return "Issue number must be a positive integer.";
    case "linearIssue":
      return "Linear issue must not be empty.";
    case "origin":
      return "Run origin must be GitHub Issue or Linear.";
    case "repo":
      return "Repository must match owner/repository.";
    case "vaultId":
      return "Vault ID must not be empty.";
    default:
      return "Invalid run form submission.";
  }
}

function mcpServerHasNoChange(server: McpServerRecord, input: McpServerUpdateInput): boolean {
  const desiredName = server.isBuiltin ? server.name : (input.name ?? server.name);
  const desiredUrl = server.isBuiltin ? server.url : (input.url ?? server.url);

  return (
    desiredName === server.name &&
    desiredUrl === server.url &&
    (input.tokenEnvName ?? server.tokenEnvName) === server.tokenEnvName &&
    (input.permissionPolicy ?? server.permissionPolicy) === server.permissionPolicy &&
    (input.enabled ?? server.enabled) === server.enabled
  );
}

function contentTypeForAsset(filePath: string): string | undefined {
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }

  return undefined;
}

function getAssetPath(requestPath: string): string | null {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  if (!decodedPath.startsWith(ASSETS_ROUTE_PREFIX)) {
    return null;
  }

  const assetPath = decodedPath.slice(ASSETS_ROUTE_PREFIX.length);
  if (assetPath.length === 0 || assetPath.startsWith("/")) {
    return null;
  }

  if (assetPath.split("/").some((segment) => segment === "..")) {
    return null;
  }

  return assetPath;
}

function createStaticAssetHandler(staticAssetsDir: string) {
  const root = resolve(staticAssetsDir);

  return async (c: Context) => {
    const assetPath = getAssetPath(c.req.path);
    if (assetPath === null) {
      return c.notFound();
    }

    const filePath = resolve(root, assetPath);
    const relativePath = relative(root, filePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return c.notFound();
    }

    const fileBody = await readFile(filePath).catch(() => null);
    if (fileBody === null) {
      return c.notFound();
    }

    const contentType = contentTypeForAsset(filePath);
    if (contentType !== undefined) {
      c.header("Content-Type", contentType);
    }

    return c.body(fileBody);
  };
}

function isEditablePromptKey(key: PromptKey): key is EditablePromptKey {
  return EditablePromptKeySchema.safeParse(key).success;
}

function defaultPromptWithBody(key: PromptKey): PromptWithBody {
  return {
    body: getDefaultPrompt(key),
    currentRevisionId: 0,
    promptKey: key,
    updatedAt: new Date().toISOString(),
  };
}

function getPromptWithFallback(db: DbModule, key: PromptKey): PromptWithBody {
  // Runtime templates are rendered from code on each deploy; rows seeded into
  // the DB by older versions go stale and must not shadow the current source.
  if (!isEditablePromptKey(key)) {
    return defaultPromptWithBody(key);
  }

  return db.getPrompt(key) ?? defaultPromptWithBody(key);
}

function getPromptRevisionCount(db: DbModule, key: PromptKey): number {
  if (isEditablePromptKey(key)) {
    return db.getPromptRevisions(key).length;
  }

  // Runtime templates live in code and have no DB-backed revisions.
  return 0;
}

function toPromptRevisionView(revision: PromptRevisionRow): PromptRevisionView {
  return {
    body: revision.body,
    createdAt: revision.createdAt,
    id: revision.id,
    source: revision.source,
  };
}

function getNoChangeNotice(
  noChange: string | undefined,
  alreadyCurrent: string | undefined,
): NoChangeNotice | undefined {
  if (noChange === "1") {
    return { kind: "no_change" };
  }

  if (alreadyCurrent === "1") {
    return { kind: "already_current" };
  }

  return undefined;
}

type DashboardMessageParams = Record<string, boolean | number | string | null | undefined>;

const NotFoundPage: FC<{ message: string; params?: DashboardMessageParams }> = ({
  message,
  params,
}) =>
  Layout({
    children: jsxs("div", {
      class: "empty-state",
      style: "padding-top: var(--space-12);",
      children: [
        jsx("div", { class: "empty-state-icon", children: "404" }),
        jsx("div", { class: "empty-state-title", children: t("Not Found") }),
        jsx("div", { class: "empty-state-hint", children: t(message, params) }),
        jsx("p", {
          style: "margin-top: var(--space-4);",
          children: jsx("a", {
            href: "/",
            children: t("← back to repositories"),
          }),
        }),
      ],
    }),
    title: t("Not Found"),
  });

const BadRequestPage: FC<{ message: string; params?: DashboardMessageParams }> = ({
  message,
  params,
}) =>
  Layout({
    children: jsxs("div", {
      class: "empty-state",
      style: "padding-top: var(--space-12);",
      children: [
        jsx("div", { class: "empty-state-icon", children: "400" }),
        jsx("div", { class: "empty-state-title", children: t("Bad Request") }),
        jsx("div", { class: "empty-state-hint", children: t(message, params) }),
        jsx("p", {
          style: "margin-top: var(--space-4);",
          children: jsx("a", {
            href: "/prompts",
            children: t("← back to prompts"),
          }),
        }),
      ],
    }),
    title: t("Bad Request"),
  });

export function dashboardWebRoutes(opts: CreateAppOptions): Hono {
  const { anthropicClient, db, logger } = opts;
  // Resolve once so handlers and rendering share identical bot-mention/label
  // strings without re-parsing on every request.
  const triggerCfg: GithubTriggerConfig =
    opts.githubTriggerConfig ?? GithubTriggerConfigSchema.parse({});
  const app = new Hono();

  app.get("/locale/:locale", (c) => {
    const locale = c.req.param("locale");
    if (!isLocale(locale)) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: 'unsupported locale "{locale}"', params: { locale } }),
        400,
      );
    }

    c.header("Set-Cookie", localeCookie(locale));
    return c.redirect(sanitizeLocaleRedirectPath(c.req.query("next")), 302);
  });

  app.get("/", (c) => {
    return repositoriesResponse(c, db, triggerCfg);
  });

  app.get("/repositories", (c) => {
    return repositoriesResponse(c, db, triggerCfg);
  });

  app.get("/mcp-servers", (c) => {
    c.header("Cache-Control", "no-store");
    return mcpServersResponse(c, db);
  });

  app.post("/mcp-servers", async (c) => {
    c.header("Cache-Control", "no-store");
    const form = await c.req.parseBody();
    const rawInput = parseMcpServerCreateForm(form as Record<string, unknown>);
    if (rawInput === null) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: "mcp server fields must be strings" }),
        400,
      );
    }

    const parsedInput = McpServerCreateInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: "Invalid MCP server form submission." }),
        400,
      );
    }

    const unsupportedPolicyMessage = unsupportedMcpPermissionPolicyMessage(
      parsedInput.data.permissionPolicy,
    );
    if (unsupportedPolicyMessage !== null) {
      return htmlPage(c, () => BadRequestPage({ message: unsupportedPolicyMessage }), 400);
    }

    if (db.getMcpServerByName(parsedInput.data.name) !== null) {
      return c.redirect("/mcp-servers?notice=duplicate", 302);
    }

    try {
      db.createMcpServer(parsedInput.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid mcp server";
      logger?.warn({ err, name: parsedInput.data.name }, "rejected mcp server create request");
      if (message.includes("already exists")) {
        return c.redirect("/mcp-servers?notice=duplicate", 302);
      }

      return htmlPage(c, () => BadRequestPage({ message: "invalid mcp server" }), 400);
    }

    return c.redirect("/mcp-servers?notice=added", 302);
  });

  app.get("/mcp-servers/:id", (c) => {
    c.header("Cache-Control", "no-store");
    const id = parseMcpServerId(c.req.param("id"));
    if (id === null) {
      return htmlPage(c, () => BadRequestPage({ message: "valid mcp server id required" }), 400);
    }

    const server = db.getMcpServerById(id);
    if (server === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: "mcp server #{id} not found", params: { id } }),
        404,
      );
    }

    return htmlPage(c, () =>
      McpServerDetailPage({
        notice: getMcpServerDetailNotice(c.req.query("notice")),
        server: toMcpServerEntry(server),
      }),
    );
  });

  app.post("/mcp-servers/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = parseMcpServerId(c.req.param("id"));
    if (id === null) {
      return htmlPage(c, () => BadRequestPage({ message: "valid mcp server id required" }), 400);
    }

    const server = db.getMcpServerById(id);
    if (server === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: "mcp server #{id} not found", params: { id } }),
        404,
      );
    }

    const form = await c.req.parseBody();
    const rawInput = parseMcpServerUpdateForm(form as Record<string, unknown>, server);
    if (rawInput === null) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: "mcp server fields must be strings" }),
        400,
      );
    }

    const parsedInput = McpServerUpdateInputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: "Invalid MCP server form submission." }),
        400,
      );
    }

    const unsupportedPolicyMessage = unsupportedMcpPermissionPolicyMessage(
      parsedInput.data.permissionPolicy,
    );
    if (unsupportedPolicyMessage !== null) {
      return htmlPage(c, () => BadRequestPage({ message: unsupportedPolicyMessage }), 400);
    }

    if (server.isBuiltin && parsedInput.data.enabled === false) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: "builtin GitHub MCP server cannot be disabled" }),
        400,
      );
    }

    if (mcpServerHasNoChange(server, parsedInput.data)) {
      return c.redirect(`/mcp-servers/${id}?notice=no_change`, 302);
    }

    try {
      db.updateMcpServer(id, parsedInput.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid mcp server";
      logger?.warn({ err, id }, "rejected mcp server update request");
      if (isDuplicateMcpServerNameError(message)) {
        return htmlPage(
          c,
          () => BadRequestPage({ message: "A MCP server with that name already exists." }),
          400,
        );
      }

      return htmlPage(c, () => BadRequestPage({ message: message || "invalid mcp server" }), 400);
    }

    return c.redirect(`/mcp-servers/${id}?notice=updated`, 302);
  });

  app.post("/mcp-servers/:id/delete", (c) => {
    c.header("Cache-Control", "no-store");
    const id = parseMcpServerId(c.req.param("id"));
    if (id === null) {
      return htmlPage(c, () => BadRequestPage({ message: "valid mcp server id required" }), 400);
    }

    const server = db.getMcpServerById(id);
    if (server === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: "mcp server #{id} not found", params: { id } }),
        404,
      );
    }

    const result = db.deleteMcpServer(id);
    if (!result.deleted) {
      const message = server.isBuiltin
        ? "builtin MCP server cannot be deleted"
        : `mcp server #${id} not found`;
      return htmlPage(
        c,
        () =>
          BadRequestPage(
            server.isBuiltin
              ? { message }
              : { message: "mcp server #{id} not found", params: { id } },
          ),
        400,
      );
    }

    return c.redirect("/mcp-servers?notice=removed", 302);
  });

  app.post("/mcp-servers/:id/enable", (c) => {
    c.header("Cache-Control", "no-store");
    const id = parseMcpServerId(c.req.param("id"));
    if (id === null) {
      return htmlPage(c, () => BadRequestPage({ message: "valid mcp server id required" }), 400);
    }

    if (db.getMcpServerById(id) === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: "mcp server #{id} not found", params: { id } }),
        404,
      );
    }

    const result = db.setMcpServerEnabled(id, true);
    if (!result.updated) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: "mcp server #{id} not found", params: { id } }),
        404,
      );
    }

    return c.redirect("/mcp-servers?notice=enabled", 302);
  });

  app.post("/mcp-servers/:id/disable", (c) => {
    c.header("Cache-Control", "no-store");
    const id = parseMcpServerId(c.req.param("id"));
    if (id === null) {
      return htmlPage(c, () => BadRequestPage({ message: "valid mcp server id required" }), 400);
    }

    const server = db.getMcpServerById(id);
    if (server === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: "mcp server #{id} not found", params: { id } }),
        404,
      );
    }

    if (server.isBuiltin) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: "builtin GitHub MCP server cannot be disabled" }),
        400,
      );
    }

    const result = db.setMcpServerEnabled(id, false);
    if (!result.updated) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: "mcp server #{id} not found", params: { id } }),
        404,
      );
    }

    return c.redirect("/mcp-servers?notice=disabled", 302);
  });

  app.get("/runs", (c) => {
    const usageByRunId = db.listRunUsageAggregates();
    const runs = db
      .listRuns({ limit: RUN_LIST_LIMIT })
      .map((run) => runsPageSummary(db, run, usageByRunId));
    return htmlPage(c, () => RunsPage({ runs }));
  });

  app.get("/repos/:owner/:name", (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    const repoUsage = db.getRepoUsageAggregate(repo);
    const usageByRunId = db.listRunUsageAggregates();
    const enrichedRuns = db
      .listRuns({ limit: RUN_LIST_LIMIT, repo })
      .map((run) => runsPageSummary(db, run, usageByRunId));

    const slots: RepoPromptSlot[] = REPO_PROMPT_AGENTS.map((agent) => {
      const row = db.getRepoPrompt(repo, agent);
      return {
        agent,
        configured: row !== null,
        currentRevisionId: row?.currentRevisionId ?? null,
        revisionCount: row !== null ? db.getRepoPromptRevisions(repo, agent).length : 0,
        updatedAt: row?.updatedAt ?? null,
      };
    });
    const envRow = db.getRepoEnvironment(repo);
    const envRevisionCount = envRow !== null ? db.getRepoEnvironmentRevisions(repo).length : 0;
    const repoEnvironmentSummary: RepoEnvironmentSummary = {
      configured: envRow !== null,
      environmentId: envRow?.environmentId ?? null,
      packageCount: envRow !== null ? totalPackageCount(envRow.packages) : 0,
      perManagerCount: envRow !== null ? perManagerCount(envRow.packages) : null,
      revisionCount: envRevisionCount,
      updatedAt: envRow?.updatedAt ?? null,
    };

    const polledRepo = db.getPolledRepository(repo);
    const repoTriggerSummary: RepoTriggerSummary = {
      addedAt: polledRepo?.addedAt ?? null,
      botMention: triggerCfg.botMention,
      configured: polledRepo !== null,
      enabled: polledRepo?.enabled ?? false,
      triggerLabel: triggerCfg.triggerLabel,
      updatedAt: polledRepo?.updatedAt ?? null,
    };

    return htmlPage(c, () =>
      RepoDetailPage({
        repo,
        repoEnvironmentSummary,
        repoPromptSlots: slots,
        repoTriggerSummary,
        repoUsage,
        runs: enrichedRuns,
      }),
    );
  });

  app.get("/repos/:owner/:name/chat", (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    return repoChatResponse(c, { ...opts, githubTriggerConfig: triggerCfg }, repo);
  });

  app.post("/repos/:owner/:name/chat", async (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    const form = (await c.req.parseBody()) as Record<string, unknown>;
    const message = typeof form.message === "string" ? form.message.trim() : "";
    if (message.length === 0 || message.length > 4000) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: "chat message must be 1-4000 characters" }),
        400,
      );
    }

    const flags = parseRepoChatContextFlags(form);
    if (flags === null) {
      return htmlPage(c, () => BadRequestPage({ message: "invalid chat context flags" }), 400);
    }

    const rawThreadId = typeof form.threadId === "string" ? form.threadId.trim() : "";
    const existingThread = rawThreadId.length > 0 ? db.getRepoChatThread(rawThreadId) : null;
    if (rawThreadId.length > 0 && existingThread === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `chat thread "${rawThreadId}" not found` }),
        404,
      );
    }

    if (existingThread !== null && existingThread.repo !== repo) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `chat thread "${rawThreadId}" not found` }),
        404,
      );
    }

    const thread =
      existingThread ??
      db.createRepoChatThread({
        id: uuidv7(),
        repo,
        title: repoChatThreadTitle(message),
      });
    db.insertRepoChatMessage({
      content: message,
      id: uuidv7(),
      role: "user",
      threadId: thread.id,
    });

    const chatDeps = repoChatDepsFromOptions(opts);
    if (chatDeps === null) {
      db.insertRepoChatMessage({
        content: repoChatUnavailableMessage(),
        id: uuidv7(),
        role: "assistant",
        threadId: thread.id,
      });
      return c.redirect(
        `/repos/${owner}/${name}/chat?thread=${encodeURIComponent(thread.id)}`,
        302,
      );
    }

    const usageByRunId = db.listRunUsageAggregates();
    const recentRuns = db
      .listRuns({ limit: RUN_LIST_LIMIT, repo })
      .map((run) => runsPageSummary(db, run, usageByRunId));
    const context = toRepoChatContextSummary(db, repo, triggerCfg, recentRuns, true);
    const history = db.listRepoChatMessages(thread.id);

    try {
      const result = await runRepositoryChatTurn(
        {
          context: flags,
          dashboardContext: formatRepoChatContextForPrompt(repo, context, flags),
          history,
          message,
          repo,
          repoName: name,
          repoOwner: owner,
        },
        chatDeps,
      );
      db.insertRepoChatMessage({
        content: result.content,
        id: uuidv7(),
        role: "assistant",
        sessionId: result.sessionId,
        threadId: thread.id,
      });
    } catch (error) {
      const errorMessage = repoChatErrorMessage(error);
      logger?.warn({ err: error, repo, threadId: thread.id }, "repository chat turn failed");
      db.insertRepoChatMessage({
        content: errorMessage,
        id: uuidv7(),
        role: "assistant",
        sessionId: repoChatErrorSessionId(error),
        threadId: thread.id,
      });
      return c.redirect(
        `/repos/${owner}/${name}/chat?thread=${encodeURIComponent(thread.id)}&error=${encodeURIComponent(errorMessage)}`,
        302,
      );
    }

    return c.redirect(`/repos/${owner}/${name}/chat?thread=${encodeURIComponent(thread.id)}`, 302);
  });

  // --- GitHub Issue auto-trigger management ---
  // The set of polled repositories is owned by the WebUI, so adds/toggles/
  // removes go through these routes. The poller picks up changes on its
  // next cycle by re-querying `polled_repositories`.

  app.post("/repositories", async (c) => {
    c.header("Cache-Control", "no-store");
    const form = await c.req.parseBody();
    const rawRepo = typeof form.repo === "string" ? form.repo.trim() : "";
    const parsedRepo = RepoSlugSchema.safeParse(rawRepo);
    if (!parsedRepo.success) {
      return htmlPage(
        c,
        () =>
          BadRequestPage({ message: `invalid repo slug "${rawRepo}" — must look like owner/name` }),
        400,
      );
    }

    try {
      db.addRegisteredRepository(parsedRepo.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid repo slug";
      logger?.warn({ err, repo: parsedRepo.data }, "rejected repository registration request");
      return htmlPage(c, () => BadRequestPage({ message }), 400);
    }

    return c.redirect("/repositories", 302);
  });

  app.post("/polled-repos", async (c) => {
    c.header("Cache-Control", "no-store");
    const form = await c.req.parseBody();
    const rawRepo = typeof form.repo === "string" ? form.repo.trim() : "";

    // Use the trigger feature's own slug schema here so the parser stays
    // consistent with what the poller will treat as a valid input. The DB
    // layer applies a stricter check that rejects edge cases (length, leading/
    // trailing punctuation), which we surface back to the user as a 400.
    const triggerParsed = TriggerRepoSlugSchema.safeParse(rawRepo);
    if (!triggerParsed.success) {
      return htmlPage(
        c,
        () =>
          BadRequestPage({
            message: `invalid repo slug "${rawRepo}" — must look like owner/name`,
          }),
        400,
      );
    }

    let result: { added: boolean };
    try {
      result = db.addPolledRepository(triggerParsed.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid repo slug";
      logger?.warn({ err, repo: triggerParsed.data }, "rejected polled repo add request");
      return htmlPage(c, () => BadRequestPage({ message }), 400);
    }

    const [owner, name] = triggerParsed.data.split("/");
    const status = result.added ? "added" : "exists";
    return c.redirect(`/repos/${owner}/${name}?trigger=${status}`, 302);
  });

  app.post("/repos/:owner/:name/trigger/enable", (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    const existing = db.getPolledRepository(repo);
    if (existing === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${repo}" is not in the polled list` }),
        404,
      );
    }

    db.setPolledRepositoryEnabled(repo, true);
    return c.redirect(`/repos/${owner}/${name}?trigger=enabled`, 302);
  });

  app.post("/repos/:owner/:name/trigger/disable", (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    const existing = db.getPolledRepository(repo);
    if (existing === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${repo}" is not in the polled list` }),
        404,
      );
    }

    db.setPolledRepositoryEnabled(repo, false);
    return c.redirect(`/repos/${owner}/${name}?trigger=disabled`, 302);
  });

  app.post("/repos/:owner/:name/trigger/remove", (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    db.removePolledRepository(repo);
    return c.redirect(`/repos/${owner}/${name}?trigger=removed`, 302);
  });

  app.get("/repos/:owner/:name/prompts/:agent", (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    const parsedAgent = RepoPromptAgentSchema.safeParse(c.req.param("agent"));
    if (!parsedAgent.success) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: "agent must be 'parent' or 'child'" }),
        400,
      );
    }

    const agent = parsedAgent.data;
    const promptRow = db.getRepoPrompt(repo, agent);
    const globalKey: RepoPromptDetailPageProps["globalPromptKey"] = `${agent}.system`;
    const globalPrompt = getPromptWithFallback(db, globalKey);
    const revisions = promptRow !== null ? db.getRepoPromptRevisions(repo, agent) : [];
    const prevRevisionRow = revisions[1];
    const props: RepoPromptDetailPageProps = {
      agent,
      agentLabel: repoPromptAgentLabel(agent),
      body: promptRow?.body ?? "",
      configured: promptRow !== null,
      currentRevisionId: promptRow?.currentRevisionId ?? null,
      globalPromptBody: globalPrompt.body,
      globalPromptKey: globalKey,
      noChangeNotice: getNoChangeNotice(c.req.query("no_change"), c.req.query("already_current")),
      prevRevision:
        prevRevisionRow === undefined
          ? undefined
          : {
              body: prevRevisionRow.body,
              createdAt: prevRevisionRow.createdAt,
              id: prevRevisionRow.id,
              source: prevRevisionRow.source,
            },
      removedNotice: c.req.query("removed") === "1",
      repo,
      revisions: revisions.map((rev) => ({
        body: rev.body,
        createdAt: rev.createdAt,
        id: rev.id,
        source: rev.source,
      })),
    };
    return htmlPage(c, () => RepoPromptDetailPage(props));
  });

  app.post("/repos/:owner/:name/prompts/:agent", async (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    const parsedAgent = RepoPromptAgentSchema.safeParse(c.req.param("agent"));
    if (!parsedAgent.success) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: "agent must be 'parent' or 'child'" }),
        400,
      );
    }

    const form = await c.req.parseBody();
    const rawBody = form.body;
    if (typeof rawBody !== "string") {
      return htmlPage(c, () => BadRequestPage({ message: "prompt body is required" }), 400);
    }

    const normalizedBody = rawBody.replace(/\r\n/g, "\n");
    const parsedInput = RepoPromptSaveInputSchema.safeParse({ body: normalizedBody });
    if (!parsedInput.success || normalizedBody.trim().length < 10) {
      return htmlPage(c, () => BadRequestPage({ message: "invalid prompt body" }), 400);
    }

    const result = db.saveRepoPromptRevision({
      agent: parsedAgent.data,
      body: normalizedBody,
      repo,
      source: "edit",
    });
    const base = `/repos/${owner}/${name}/prompts/${parsedAgent.data}`;
    return c.redirect(result.isNoChange ? `${base}?no_change=1` : base, 302);
  });

  app.post("/repos/:owner/:name/prompts/:agent/restore", async (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    const parsedAgent = RepoPromptAgentSchema.safeParse(c.req.param("agent"));
    if (!parsedAgent.success) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: "agent must be 'parent' or 'child'" }),
        400,
      );
    }

    const form = await c.req.parseBody();
    const parsedRevisionId = RestoreRevisionIdSchema.safeParse(form.revision_id);
    if (!parsedRevisionId.success) {
      return htmlPage(c, () => BadRequestPage({ message: "valid revision_id is required" }), 400);
    }

    const revision = db.getRepoPromptRevision(repo, parsedAgent.data, parsedRevisionId.data);
    if (revision === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `revision ${parsedRevisionId.data} not found` }),
        404,
      );
    }

    const result = db.restoreRepoPromptToRevision(repo, parsedAgent.data, parsedRevisionId.data);
    const base = `/repos/${owner}/${name}/prompts/${parsedAgent.data}`;
    return c.redirect(result.alreadyCurrent ? `${base}?already_current=1` : base, 302);
  });

  app.post("/repos/:owner/:name/prompts/:agent/delete", async (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    const parsedAgent = RepoPromptAgentSchema.safeParse(c.req.param("agent"));
    if (!parsedAgent.success) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: "agent must be 'parent' or 'child'" }),
        400,
      );
    }

    db.deleteRepoPrompt(repo, parsedAgent.data);
    return c.redirect(`/repos/${owner}/${name}/prompts/${parsedAgent.data}?removed=1`, 302);
  });

  app.get("/repos/:owner/:name/environment", (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    const environmentRow = db.getRepoEnvironment(repo);
    const revisions = environmentRow !== null ? db.getRepoEnvironmentRevisions(repo) : [];
    const props: RepoEnvironmentDetailPageProps = {
      configured: environmentRow !== null,
      currentRevisionId: environmentRow?.currentRevisionId ?? null,
      definitionHash: environmentRow?.definitionHash ?? null,
      environmentId: environmentRow?.environmentId ?? null,
      noChangeNotice: getNoChangeNotice(c.req.query("no_change"), c.req.query("already_current")),
      packages: environmentRow?.packages ?? emptyRepoEnvironmentPackages(),
      removedNotice: c.req.query("removed") === "1",
      repo,
      revisions: revisions.map((revision) => ({
        createdAt: revision.createdAt,
        id: revision.id,
        packages: revision.packages,
        source: revision.source,
      })),
    };

    return htmlPage(c, () => RepoEnvironmentDetailPage(props));
  });

  app.post("/repos/:owner/:name/environment", async (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    const form = await c.req.parseBody();
    const packages = parseRepoEnvironmentPackagesForm(form as Record<string, unknown>);
    if (packages === null) {
      return htmlPage(
        c,
        () => BadRequestPage({ message: "environment package fields must be strings" }),
        400,
      );
    }

    const parsedInput = RepoEnvironmentSaveInputSchema.safeParse({ packages });
    if (!parsedInput.success) {
      return htmlPage(c, () => BadRequestPage({ message: parsedInput.error.message }), 400);
    }

    const result = db.saveRepoEnvironmentRevision({
      packages: parsedInput.data.packages,
      repo,
      source: "edit",
    });
    const base = `/repos/${owner}/${name}/environment`;
    return c.redirect(result.isNoChange ? `${base}?no_change=1` : base, 302);
  });

  app.post("/repos/:owner/:name/environment/restore", async (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    const form = await c.req.parseBody();
    const parsedRevisionId = RestoreRevisionIdSchema.safeParse(form.revision_id);
    if (!parsedRevisionId.success) {
      return htmlPage(c, () => BadRequestPage({ message: "valid revision_id is required" }), 400);
    }

    const revision = db.getRepoEnvironmentRevision(repo, parsedRevisionId.data);
    if (revision === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `revision ${parsedRevisionId.data} not found` }),
        404,
      );
    }

    const result = db.restoreRepoEnvironmentToRevision(repo, parsedRevisionId.data);
    const base = `/repos/${owner}/${name}/environment`;
    return c.redirect(result.alreadyCurrent ? `${base}?already_current=1` : base, 302);
  });

  app.post("/repos/:owner/:name/environment/delete", (c) => {
    c.header("Cache-Control", "no-store");
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }

    db.deleteRepoEnvironment(repo);
    return c.redirect(`/repos/${owner}/${name}/environment?removed=1`, 302);
  });

  app.get("/repos/:owner/:name/runs", (c) => {
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    const repo = repoSlugFromParams(owner, name);
    if (repo === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `repository "${owner}/${name}" not found` }),
        404,
      );
    }
    const usageByRunId = db.listRunUsageAggregates();
    const enrichedRuns = db
      .listRuns({ limit: RUN_LIST_LIMIT, repo })
      .map((run) => runsPageSummary(db, run, usageByRunId));
    return htmlPage(c, () => RunsPage({ repo, runs: enrichedRuns }));
  });

  app.get("/prompts", (c) => {
    c.header("Cache-Control", "no-store");

    const prompts = PROMPT_KEYS.map((key): PromptListEntry => {
      const prompt = getPromptWithFallback(db, key);
      return {
        editable: isEditablePromptKey(key),
        promptKey: key,
        revisionCount: getPromptRevisionCount(db, key),
        updatedAt: prompt.currentRevisionId > 0 ? prompt.updatedAt : null,
      };
    });
    const repoOverrides: RepoPromptOverrideEntry[] = db.listRepoPromptOverrides().map((row) => ({
      agent: row.agent,
      repo: row.repo,
      revisionCount: row.revisionCount,
      updatedAt: row.updatedAt,
    }));
    return htmlPage(c, () => PromptsListPage({ prompts, repoOverrides }));
  });

  app.get("/prompts/:key", (c) => {
    c.header("Cache-Control", "no-store");

    const parsedKey = PromptKeySchema.safeParse(c.req.param("key"));
    if (!parsedKey.success) {
      return c.notFound();
    }

    const promptKey = parsedKey.data;
    const prompt = getPromptWithFallback(db, promptKey);
    const editable = isEditablePromptKey(promptKey);
    const revisionRows = editable ? db.getPromptRevisions(promptKey) : [];
    const prevRevisionRow = revisionRows[1];

    return htmlPage(c, () =>
      PromptDetailPage({
        body: prompt.body,
        currentRevisionId: prompt.currentRevisionId,
        editable,
        noChangeNotice: getNoChangeNotice(c.req.query("no_change"), c.req.query("already_current")),
        prevRevision:
          prevRevisionRow === undefined ? undefined : toPromptRevisionView(prevRevisionRow),
        promptKey,
        revisions: revisionRows.map(toPromptRevisionView),
      }),
    );
  });

  app.post("/prompts/:key", async (c) => {
    c.header("Cache-Control", "no-store");

    const parsedKey = EditablePromptKeySchema.safeParse(c.req.param("key"));
    if (!parsedKey.success) {
      return htmlPage(c, () => BadRequestPage({ message: "editable prompt key required" }), 400);
    }

    const form = await c.req.parseBody();
    const rawBody = form.body;
    if (typeof rawBody !== "string") {
      return htmlPage(c, () => BadRequestPage({ message: "prompt body is required" }), 400);
    }

    const normalizedBody = rawBody.replace(/\r\n/g, "\n");
    const parsedInput = PromptSaveInputSchema.safeParse({ body: normalizedBody });
    if (!parsedInput.success || normalizedBody.trim().length < 10) {
      return htmlPage(c, () => BadRequestPage({ message: "invalid prompt body" }), 400);
    }

    const result = db.savePromptRevision({
      body: normalizedBody,
      key: parsedKey.data,
      source: "edit",
    });
    const redirectUrl = result.isNoChange
      ? `/prompts/${parsedKey.data}?no_change=1`
      : `/prompts/${parsedKey.data}`;
    return c.redirect(redirectUrl, 302);
  });

  app.post("/prompts/:key/restore", async (c) => {
    c.header("Cache-Control", "no-store");

    const parsedKey = EditablePromptKeySchema.safeParse(c.req.param("key"));
    if (!parsedKey.success) {
      return htmlPage(c, () => BadRequestPage({ message: "editable prompt key required" }), 400);
    }

    const form = await c.req.parseBody();
    const parsedRevisionId = RestoreRevisionIdSchema.safeParse(form.revision_id);
    if (!parsedRevisionId.success) {
      return htmlPage(c, () => BadRequestPage({ message: "valid revision_id is required" }), 400);
    }

    const revision = db.getPromptRevision(parsedKey.data, parsedRevisionId.data);
    if (revision === null) {
      return htmlPage(
        c,
        () => NotFoundPage({ message: `revision ${parsedRevisionId.data} not found` }),
        404,
      );
    }

    const result = db.restorePromptToRevision(parsedKey.data, parsedRevisionId.data);
    const redirectUrl = result.alreadyCurrent
      ? `/prompts/${parsedKey.data}?already_current=1`
      : `/prompts/${parsedKey.data}`;
    return c.redirect(redirectUrl, 302);
  });

  app.get("/favicon.ico", (c) => c.body(null, 204));

  app.get("/runs/new", (c) => {
    const enabledRepositories = enabledRegisteredRepositorySlugs(db);
    return htmlPage(c, () =>
      RunNewPage({
        enabledRepositories,
        linearMcpEnabled: linearMcpEnabled(db),
        registeredRepositoryCount: enabledRepositories.length,
      }),
    );
  });

  app.post("/runs/new", async (c) => {
    if (!opts.runQueue) {
      const enabledRepositories = enabledRegisteredRepositorySlugs(db);
      return htmlPage(
        c,
        () =>
          RunNewPage({
            enabledRepositories,
            errors: { _form: "runQueue is not configured for this dashboard" },
            linearMcpEnabled: linearMcpEnabled(db),
            registeredRepositoryCount: enabledRepositories.length,
          }),
        503,
      );
    }

    const form = await c.req.parseBody();
    const linearEnabled = linearMcpEnabled(db);
    const origin = linearEnabled ? String(form.origin ?? "github_issue") : "github_issue";
    const issue = String(form.issue ?? "").trim();
    const linearIssue = String(form.linearIssue ?? "").trim();
    const repo = String(form.repo ?? "").trim();
    const dryRun = form.dryRun === "on";
    const vaultId = form.vaultId ? String(form.vaultId) : undefined;
    const configPath = form.configPath ? String(form.configPath) : undefined;
    const enabledRepositories = enabledRegisteredRepositorySlugs(db);

    const parsed = RunStartInputSchema.safeParse({
      ...(origin === "github_issue" ? { issue } : {}),
      ...(origin === "linear_issue" ? { linearIssue, repo } : {}),
      origin,
      dryRun,
      vaultId,
      configPath,
    });

    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const err of parsed.error.errors) {
        if (err.path[0]) {
          errors[err.path[0].toString()] = runStartValidationMessage(err.path[0].toString());
        }
      }
      return htmlPage(
        c,
        () =>
          RunNewPage({
            enabledRepositories,
            values: {
              issue: form.issue as string,
              linearIssue: form.linearIssue as string,
              origin: origin === "linear_issue" ? "linear_issue" : "github_issue",
              repo: form.repo as string,
              dryRun,
              vaultId: form.vaultId as string,
              configPath: form.configPath as string,
            },
            errors,
            linearMcpEnabled: linearEnabled,
            registeredRepositoryCount: enabledRepositories.length,
          }),
        400,
      );
    }

    let runId: string;
    try {
      ({ runId } = opts.runQueue.enqueue(parsed.data));
    } catch (error) {
      return htmlPage(
        c,
        () =>
          RunNewPage({
            enabledRepositories,
            values: {
              issue: form.issue as string,
              linearIssue: form.linearIssue as string,
              origin: origin === "linear_issue" ? "linear_issue" : "github_issue",
              repo: form.repo as string,
              dryRun,
              vaultId: form.vaultId as string,
              configPath: form.configPath as string,
            },
            errors: { _form: error instanceof Error ? error.message : String(error) },
            linearMcpEnabled: linearEnabled,
            registeredRepositoryCount: enabledRepositories.length,
          }),
        400,
      );
    }
    return c.redirect(`/runs/${runId}/live`, 303);
  });

  app.get("/runs/:runId", (c) => {
    const runId = c.req.param("runId");
    const run = db.getRunById(runId);

    if (!run) {
      return htmlPage(c, () => NotFoundPage({ message: `run "${runId}" not found` }), 404);
    }

    const status = runStatus(db, runId);
    if (status === undefined) {
      return htmlPage(c, () => NotFoundPage({ message: `run "${runId}" not found` }), 404);
    }

    const props: RunDetailPageProps = {
      consoleWorkspace: (opts.config ?? DEFAULT_CONFIG).consoleWorkspace,
      failure: failureForStatus(db, runId, status),
      liveTailEnabled: anthropicClient !== undefined,
      run,
      sessionUsages: db.getSessionUsagesByRun(runId),
      sessions: db.getSessionsByRun(runId),
      status,
      usageAggregate: db.getRunUsageAggregate(runId),
    };

    return htmlPage(c, () => RunDetailPage(props));
  });

  app.get("/runs/:runId/live", (c) => {
    const runId = c.req.param("runId");
    const run = db.getRunById(runId);

    if (!run) {
      return htmlPage(c, () => NotFoundPage({ message: `run "${runId}" not found` }), 404);
    }

    const status = runStatus(db, runId);
    if (status === undefined) {
      return htmlPage(c, () => NotFoundPage({ message: `run "${runId}" not found` }), 404);
    }

    const props: RunLivePageProps = {
      run,
      sessions: db.getSessionsByRun(runId),
      status,
    };

    return htmlPage(c, () => RunLivePage(props));
  });

  app.post("/runs/:runId/stop", (c) => {
    const runId = c.req.param("runId");
    return c.redirect(`/api/runs/${runId}/stop`, 307);
  });

  app.get("/runs/:runId/sessions/:sessionId/events/stream", (c) => {
    const runId = c.req.param("runId");
    const sessionId = c.req.param("sessionId");
    const run = db.getRunById(runId);

    if (!run) {
      return c.json({ error: `run "${runId}" not found` }, 404);
    }

    if (!run.sessionIds.includes(sessionId)) {
      return c.json({ error: `session "${sessionId}" is not part of run "${runId}"` }, 404);
    }

    if (!anthropicClient) {
      return c.json(
        {
          error:
            "live tail unavailable: Anthropic client not configured (set ANTHROPIC_API_KEY before running serve)",
        },
        503,
      );
    }

    const stream = createLiveTailStream({
      client: anthropicClient,
      logger,
      sessionId,
      signal: c.req.raw.signal,
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  });

  return app;
}

export function createApp(opts: CreateAppOptions): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.get("Cache-Control")) {
      c.header("Cache-Control", "no-store");
    }
  });

  if (opts.staticAssetsDir !== undefined) {
    app.get("/assets/*", createStaticAssetHandler(opts.staticAssetsDir));
  }

  app.route("/", dashboardWebRoutes(opts));

  app.notFound((c) => {
    return htmlPage(c, () => NotFoundPage({ message: `page "${c.req.path}" not found` }), 404);
  });

  return app;
}
