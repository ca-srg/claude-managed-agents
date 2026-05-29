import type { BetaManagedAgentsEventParams } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { Logger } from "pino";
import { v7 as uuidv7 } from "uuid";

import type { handleCreateSubIssue } from "@/features/decomposition/handler";
import type { handleCreateFinalPr } from "@/features/finalize-pr/handler";
import type { runPreflight } from "@/features/preflight/validate";
import type { ensureEnvironment, ensureEnvironmentForRepo } from "@/shared/agents/environment";
import type { ParentCustomTools } from "@/shared/agents/parent";
import type { buildChildPrompt } from "@/shared/agents/prompts/child";
import type { buildParentPrompt } from "@/shared/agents/prompts/parent";
import type { ensureAgents } from "@/shared/agents/registry";
import type { Config, loadConfig } from "@/shared/config";
import { BUILTIN_GITHUB_MCP_NAME, GITHUB_MCP_URL, LINEAR_MCP_URL } from "@/shared/constants";
import type { GitHubAuthProvider, GitHubRepositoryAccess, readIssue } from "@/shared/github";
import {
  formatRepoContext as defaultFormatRepoContext,
  loadRepoContext as defaultLoadRepoContext,
} from "@/shared/github";
import type { createDbModule, McpServer } from "@/shared/persistence/db";
import type { PromptKey } from "@/shared/prompts/seeder";
import type { createRunEventsModule } from "@/shared/run-events";
import {
  githubIssueOrigin,
  isEnabledLinearMcpServer,
  linearIssueOrigin,
  originBranchSegment,
  originDisplay,
  originShortDisplay,
  type RunOrigin,
} from "@/shared/run-origin";
import type { runSession, ThreadObserver } from "@/shared/session";
import type { acquireRunLock, readAgentState, releaseRunLock, writeRunState } from "@/shared/state";
import type { RunPhase, RunState, RunStatus } from "@/shared/types";
import type {
  EnsuredMcpCredential,
  ensureMcpCredentials,
  ensureVault,
  ResolvedMcpCredential,
  releaseVault,
  updateMcpCredentialToken,
} from "@/shared/vault";
import { createRunEventsBridge } from "./event-bridge";
import {
  type ParsedRunExecutionInput,
  type RunExecutionInput,
  RunExecutionInputSchema,
  type RunExecutionResult,
} from "./schemas";

export type { RunExecutionInput, RunExecutionResult } from "./schemas";

type SessionApiClient = {
  beta: {
    sessions: {
      create: (params: SessionCreateParams) => Promise<{
        id: string;
        resources?: Array<{ id: string; type: string }>;
      }>;
      delete: (sessionId: string) => Promise<unknown>;
      events: {
        send: (
          sessionId: string,
          params: { events: BetaManagedAgentsEventParams[] },
        ) => Promise<unknown>;
      };
      resources?: {
        update: (
          resourceId: string,
          params: { authorization_token: string; session_id: string },
        ) => Promise<unknown>;
      };
    };
  };
};

type AnthropicClientLike = Parameters<typeof ensureAgents>[0] &
  Parameters<typeof ensureEnvironment>[0] &
  Parameters<typeof ensureEnvironmentForRepo>[0] &
  Parameters<typeof ensureVault>[0] &
  Parameters<typeof ensureMcpCredentials>[0] &
  Parameters<typeof releaseVault>[0] &
  NonNullable<Parameters<typeof runPreflight>[0]["anthropicClient"]> &
  Parameters<typeof runSession>[0] &
  SessionApiClient;

type DashboardDbModule = ReturnType<typeof createDbModule>;
type RunEventsModule = Pick<ReturnType<typeof createRunEventsModule>, "emit">;

export type RunExecutionDb = Pick<
  DashboardDbModule,
  | "getPrompt"
  | "getRepoEnvironment"
  | "getRepoPrompt"
  | "insertRun"
  | "insertSession"
  | "insertSessionPlaceholder"
  | "listMcpServers"
  | "seedPromptIfMissing"
  | "setRepoEnvironmentAnthropicState"
  | "setRunPhase"
  | "setRunStatus"
>;

type CleanupHandler = () => Promise<void> | void;

export type RunExecutionCleanup = {
  register(fn: CleanupHandler): void;
  triggerAll(): Promise<void>;
};

export type RunExecutionObservers = {
  onLog?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
  onPhase?: (phase: RunPhase, details?: unknown) => void;
  onSession?: (event: { kind: string; payload?: unknown; sessionId: string }) => void;
  onSubIssue?: (event: { kind: "created" | "updated"; payload: unknown }) => void;
};

export type RunExecutionDeps = {
  acquireRunLock: typeof acquireRunLock;
  anthropicClient?: AnthropicClientLike;
  buildChildPrompt: typeof buildChildPrompt;
  buildParentPrompt: typeof buildParentPrompt;
  cleanup?: RunExecutionCleanup;
  db?: RunExecutionDb;
  ensureAgents: typeof ensureAgents;
  ensureEnvironment: typeof ensureEnvironment;
  ensureEnvironmentForRepo: typeof ensureEnvironmentForRepo;
  ensureMcpCredentials: typeof ensureMcpCredentials;
  ensureVault: typeof ensureVault;
  forceRecreate?: boolean;
  githubAuth: GitHubAuthProvider;
  handleCreateFinalPr: typeof handleCreateFinalPr;
  handleCreateSubIssue: typeof handleCreateSubIssue;
  formatRepoContext?: typeof defaultFormatRepoContext;
  loadAgentPrompts: (deps: {
    db: RunExecutionDb;
    logger: Logger;
  }) => Promise<{ child: string; parent: string }>;
  loadConfig: typeof loadConfig;
  loadRepoContext?: typeof defaultLoadRepoContext;
  logger: Logger;
  /**
   * Custom (non-MCP) tools attached to the parent agent. MCP toolsets are
   * derived from the `mcp_servers` table at run time and concatenated by
   * `buildParentDefinition`; do not include `mcp_toolset` entries here.
   */
  parentCustomTools: ParentCustomTools;
  readAgentState: typeof readAgentState;
  readIssue: typeof readIssue;
  releaseRunLock: typeof releaseRunLock;
  releaseVault: typeof releaseVault;
  runPreflight: typeof runPreflight;
  runEvents?: RunEventsModule;
  runSession: typeof runSession;
  seedAgentPrompts: (deps: {
    db: RunExecutionDb;
    logger: Logger;
  }) => Promise<{ seeded: PromptKey[] }>;
  signal?: AbortSignal;
  updateMcpCredentialToken?: typeof updateMcpCredentialToken;
  writeRunState: typeof writeRunState;
};

type RepoRef = {
  name: string;
  owner: string;
};

type ErrorResult = {
  message: string;
  type: string;
};

type SubIssueObserverPayload = {
  changeKind: "created" | "updated";
  issueId: number;
  issueNumber: number;
  repo: string;
  status: "pending";
  taskId: string;
  title?: string;
};

const RUNNING_SESSION_DELETE_MESSAGE = "Cannot delete session while it is running";
const SESSION_DELETE_RETRY_DELAYS_MS = [0, 1_000, 3_000] as const;

class RunExecutionFailure extends Error {
  readonly type: string;

  constructor(type: string, message: string) {
    super(message);
    this.name = "RunExecutionFailure";
    this.type = type;
  }
}

class RunExecutionAborted extends Error {
  constructor() {
    super("Run orchestration was aborted");
    this.name = "RunExecutionAborted";
  }
}

function createLocalCleanup(): RunExecutionCleanup {
  const cleanupHandlers: CleanupHandler[] = [];
  let triggerPromise: Promise<void> | undefined;

  return {
    register(fn) {
      cleanupHandlers.push(fn);
    },
    triggerAll() {
      triggerPromise ??= (async () => {
        const cleanupErrors: unknown[] = [];

        while (cleanupHandlers.length > 0) {
          const cleanupHandler = cleanupHandlers.pop();
          if (cleanupHandler) {
            try {
              await cleanupHandler();
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
        }

        if (cleanupErrors.length === 1) {
          throw cleanupErrors[0];
        }

        if (cleanupErrors.length > 1) {
          throw new AggregateError(cleanupErrors, "One or more cleanup handlers failed");
        }
      })();

      return triggerPromise;
    },
  };
}

function parseRepoRef(repo: string): RepoRef {
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    throw new RunExecutionFailure("invalid_input", "repo must match owner/name");
  }

  return { name, owner };
}

function repositoryAuthorizationForPreflight(access: GitHubRepositoryAccess) {
  return {
    authMode: access.authMode,
    installationId: access.installationId,
    permissions: access.permissions,
    repositorySelection: access.repositorySelection,
  };
}

async function resolveGitHubAccessFromDeps(
  deps: RunExecutionDeps,
  owner: string,
  repo: string,
): Promise<GitHubRepositoryAccess> {
  return deps.githubAuth.resolveRepositoryAccess(owner, repo);
}

function isBuiltinGitHubMcp(server: McpServer): boolean {
  return server.isBuiltin && server.name === BUILTIN_GITHUB_MCP_NAME;
}

function mcpServerNeedsTokenEnv(server: McpServer): boolean {
  return !isBuiltinGitHubMcp(server) && server.tokenEnvName.length > 0;
}

function findEnabledLinearMcpServer(servers: ReadonlyArray<McpServer>): McpServer | undefined {
  return servers.find(isEnabledLinearMcpServer);
}

function createLinearMcpTokenMissingFailure(server: Pick<McpServer, "name">): RunExecutionFailure {
  const message = [
    `Linear origin runs with a managed vault require MCP server "${server.name}"`,
    `(${LINEAR_MCP_URL}) to configure a token env var.`,
    "Set tokenEnvName to an environment variable containing a Linear bearer token,",
    "or pass vaultId/config.vaultId with a pre-provisioned Linear MCP credential.",
  ].join(" ");

  return new RunExecutionFailure("linear_mcp_token_missing", message);
}

function assertLinearMcpReadyForOrigin(
  servers: ReadonlyArray<McpServer>,
  options: { requireManagedVaultCredential: boolean },
): McpServer {
  const linearMcpServer = findEnabledLinearMcpServer(servers);
  if (!linearMcpServer) {
    throw new RunExecutionFailure(
      "linear_mcp_disabled",
      `Linear origin runs require an enabled MCP server at ${LINEAR_MCP_URL}.`,
    );
  }

  if (options.requireManagedVaultCredential && linearMcpServer.tokenEnvName.length === 0) {
    throw createLinearMcpTokenMissingFailure(linearMcpServer);
  }

  return linearMcpServer;
}

/**
 * Resolve the env-backed bearer token for each enabled MCP server when needed.
 *
 * Tokens are deliberately *not* persisted in the DB; only the env var name
 * is stored. We resolve at run-start time so deploys can rotate custom MCP
 * tokens without touching the dashboard. Configured vaults can
 * reuse pre-provisioned credentials by URL, so missing env vars are allowed
 * there until a new Vault credential actually needs to be created.
 */
function resolveMcpCredentials(
  servers: ReadonlyArray<McpServer>,
  options: {
    githubAccess: GitHubRepositoryAccess;
    requireLinearCredential: boolean;
    requireToken: boolean;
  },
): ResolvedMcpCredential[] {
  const resolved: ResolvedMcpCredential[] = [];
  for (const server of servers) {
    const shouldUseGitHubAppToken = isBuiltinGitHubMcp(server);
    if (!shouldUseGitHubAppToken && server.tokenEnvName.length === 0) {
      if (options.requireLinearCredential && isEnabledLinearMcpServer(server)) {
        if (options.requireToken) {
          throw createLinearMcpTokenMissingFailure(server);
        }

        resolved.push({
          mcpServerUrl: server.url,
          name: server.name,
        });
      }
      continue;
    }

    const token = shouldUseGitHubAppToken
      ? options.githubAccess.authorizationToken
      : process.env[server.tokenEnvName];
    if ((typeof token !== "string" || token.length === 0) && options.requireToken) {
      throw new RunExecutionFailure(
        "mcp_token_missing",
        `MCP server "${server.name}" requires environment variable ${server.tokenEnvName} to be set`,
      );
    }

    const credential: ResolvedMcpCredential = {
      name: server.name,
      mcpServerUrl: server.url,
    };
    if (typeof token === "string" && token.length > 0) {
      credential.token = token;
    }
    if (shouldUseGitHubAppToken) {
      credential.updateExisting = true;
    }
    resolved.push(credential);
  }
  return resolved;
}

function assertBuiltinGitHubMcpEnabled(servers: ReadonlyArray<McpServer>): void {
  const builtinGitHubMcp = servers.find(isBuiltinGitHubMcp);
  if (builtinGitHubMcp === undefined || builtinGitHubMcp.enabled) {
    return;
  }

  throw new RunExecutionFailure(
    "mcp_github_disabled",
    "Built-in GitHub MCP server must be enabled before agent registration",
  );
}

const GITHUB_APP_TOKEN_REFRESH_LEEWAY_MS = 10 * 60 * 1000;
const GITHUB_APP_TOKEN_REFRESH_RETRY_MS = 60 * 1000;

function findGitHubRepositoryResourceId(session: {
  resources?: Array<{ id: string; type: string }>;
}): string | undefined {
  return session.resources?.find((resource) => resource.type === "github_repository")?.id;
}

function refreshDelayMs(access: GitHubRepositoryAccess): number | undefined {
  if (!access.expiresAt) {
    return undefined;
  }

  return Math.max(
    GITHUB_APP_TOKEN_REFRESH_RETRY_MS,
    access.expiresAt.getTime() - Date.now() - GITHUB_APP_TOKEN_REFRESH_LEEWAY_MS,
  );
}

function registerGitHubAppTokenRefresh(options: {
  anthropicClient: AnthropicClientLike;
  cleanup: RunExecutionCleanup;
  credentialIds: () => string[];
  getAccess: () => GitHubRepositoryAccess;
  logger: Logger;
  onAccessRefreshed: (access: GitHubRepositoryAccess) => void;
  owner: string;
  repo: string;
  repoResourceId?: string;
  sessionId: string;
  updateMcpCredentialToken?: typeof updateMcpCredentialToken;
  vaultId: string;
  githubAuth?: GitHubAuthProvider;
}): void {
  if (!options.githubAuth?.refreshRepositoryAccess) {
    return;
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number | undefined) => {
    if (stopped || delayMs === undefined) {
      return;
    }

    timer = setTimeout(async () => {
      if (stopped) {
        return;
      }

      try {
        const refreshed = await options.githubAuth?.refreshRepositoryAccess?.(
          options.owner,
          options.repo,
        );
        if (!refreshed) {
          return;
        }

        options.onAccessRefreshed(refreshed);
        const updates: Promise<unknown>[] = [];
        if (options.repoResourceId && options.anthropicClient.beta.sessions.resources?.update) {
          updates.push(
            options.anthropicClient.beta.sessions.resources.update(options.repoResourceId, {
              authorization_token: refreshed.authorizationToken,
              session_id: options.sessionId,
            }),
          );
        }

        if (options.updateMcpCredentialToken) {
          for (const credentialId of options.credentialIds()) {
            updates.push(
              options.updateMcpCredentialToken(options.anthropicClient, {
                credentialId,
                token: refreshed.authorizationToken,
                vaultId: options.vaultId,
              }),
            );
          }
        }

        await Promise.all(updates);
        options.logger.info(
          {
            credentialCount: options.credentialIds().length,
            repo: `${options.owner}/${options.repo}`,
            sessionId: options.sessionId,
          },
          "Refreshed GitHub App installation token for running session",
        );
        schedule(refreshDelayMs(refreshed));
      } catch (error) {
        options.logger.warn(
          { err: error, repo: `${options.owner}/${options.repo}`, sessionId: options.sessionId },
          "Failed to refresh GitHub App installation token; will retry",
        );
        schedule(GITHUB_APP_TOKEN_REFRESH_RETRY_MS);
      }
    }, delayMs);
  };

  schedule(refreshDelayMs(options.getAccess()));
  options.cleanup.register(() => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function readRepoPromptBody(
  db: RunExecutionDb,
  repo: string,
  agent: "parent" | "child",
  logger: Logger,
): string | null {
  try {
    const row = db.getRepoPrompt(repo, agent);
    if (row && typeof row.body === "string" && row.body.trim().length > 0) {
      return row.body;
    }
  } catch (err) {
    logger.warn({ agent, err, repo }, "failed to load repo prompt; falling back to global only");
  }

  return null;
}

function resolveBaseBranch(
  configuredBaseBranch: string | undefined,
  defaultBranch: string,
): string {
  const trimmedConfiguredBaseBranch = configuredBaseBranch?.trim();
  return trimmedConfiguredBaseBranch ? trimmedConfiguredBaseBranch : defaultBranch;
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "task"
  );
}

function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function nestedErrorMessage(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const nestedError = error.error;
  if (!isRecord(nestedError)) {
    return undefined;
  }

  const nestedPayload = nestedError.error;
  if (!isRecord(nestedPayload)) {
    return undefined;
  }

  const message = nestedPayload.message;
  return typeof message === "string" ? message : undefined;
}

function isRunningSessionDeleteError(error: unknown): boolean {
  const status = isRecord(error) ? error.status : undefined;
  const message = `${errorMessageFromUnknown(error)} ${nestedErrorMessage(error) ?? ""}`;

  return status === 400 && message.includes(RUNNING_SESSION_DELETE_MESSAGE);
}

async function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteSessionForCleanup(
  anthropicClient: AnthropicClientLike,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  try {
    await anthropicClient.beta.sessions.delete(sessionId);
    return;
  } catch (error) {
    if (!isRunningSessionDeleteError(error)) {
      throw error;
    }
  }

  logger.warn({ sessionId }, "session still running during cleanup; interrupting before delete");
  await anthropicClient.beta.sessions.events.send(sessionId, {
    events: [{ type: "user.interrupt" }],
  });

  let lastDeleteError: unknown;
  for (const retryDelayMs of SESSION_DELETE_RETRY_DELAYS_MS) {
    await delay(retryDelayMs);

    try {
      await anthropicClient.beta.sessions.delete(sessionId);
      return;
    } catch (error) {
      if (!isRunningSessionDeleteError(error)) {
        throw error;
      }
      lastDeleteError = error;
    }
  }

  throw lastDeleteError ?? new Error(RUNNING_SESSION_DELETE_MESSAGE);
}

function categorizeError(error: unknown): ErrorResult {
  if (error instanceof RunExecutionFailure) {
    return { message: error.message, type: error.type };
  }

  if (error instanceof RunExecutionAborted) {
    return { message: error.message, type: "aborted" };
  }

  return {
    message: errorMessageFromUnknown(error),
    type: error instanceof Error && error.name !== "Error" ? error.name : "unexpected",
  };
}

function safeObserverCall(
  logger: Logger,
  action: () => void,
  details: Record<string, unknown>,
): void {
  try {
    action();
  } catch (error) {
    logger.warn({ err: error, ...details }, "run execution observer callback failed");
  }
}

function callComposedObserver<TArgs extends unknown[]>(
  first: ((...args: TArgs) => void) | undefined,
  second: ((...args: TArgs) => void) | undefined,
  ...args: TArgs
): void {
  let firstError: unknown;

  if (first) {
    try {
      first(...args);
    } catch (error) {
      firstError = error;
    }
  }

  if (second) {
    try {
      second(...args);
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError !== undefined) {
    throw firstError;
  }
}

function composeObservers(
  first: RunExecutionObservers,
  second: RunExecutionObservers,
): RunExecutionObservers {
  return {
    onLog: (level, msg, fields) => {
      callComposedObserver(first.onLog, second.onLog, level, msg, fields);
    },
    onPhase: (phase, details) => {
      callComposedObserver(first.onPhase, second.onPhase, phase, details);
    },
    onSession: (event) => {
      callComposedObserver(first.onSession, second.onSession, event);
    },
    onSubIssue: (event) => {
      callComposedObserver(first.onSubIssue, second.onSubIssue, event);
    },
  };
}

function notifyLog(
  logger: Logger,
  observers: RunExecutionObservers,
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
): void {
  switch (level) {
    case "info":
      if (fields) {
        logger.info(fields, msg);
      } else {
        logger.info(msg);
      }
      break;
    case "warn":
      if (fields) {
        logger.warn(fields, msg);
      } else {
        logger.warn(msg);
      }
      break;
    case "error":
      if (fields) {
        logger.error(fields, msg);
      } else {
        logger.error(msg);
      }
      break;
  }

  if (observers.onLog) {
    safeObserverCall(logger, () => observers.onLog?.(level, msg, fields), {
      observer: "onLog",
    });
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RunExecutionAborted();
  }
}

function buildDryRunDecompositionPlan(input: {
  branch: string;
  cfg: Config;
  issueBody: string;
  issueNumber: number | null;
  issueTitle: string;
  origin: RunOrigin;
  repo: string;
}): unknown {
  return {
    branch: input.branch,
    commitStyle: input.cfg.commitStyle,
    issue: {
      body: input.issueBody,
      number: input.issueNumber,
      title: input.issueTitle,
    },
    maxSubIssues: input.cfg.maxSubIssues,
    origin: input.origin,
    repo: input.repo,
  };
}

function runOriginFromExecutionInput(input: ParsedRunExecutionInput, repoSlug: string): RunOrigin {
  if (input.origin === "github_issue") {
    return githubIssueOrigin({ issueNumber: input.issue, repo: repoSlug });
  }

  return linearIssueOrigin({ identifier: input.linearIssue });
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function buildSubIssueObserverPayload(input: {
  args: unknown;
  changeKind: "created" | "updated";
  repo: string;
  result: { subIssueId: number; subIssueNumber: number };
  runState: RunState;
}): SubIssueObserverPayload {
  const subIssue = input.runState.subIssues.find(
    (item) =>
      item.issueId === input.result.subIssueId || item.issueNumber === input.result.subIssueNumber,
  );
  const title = stringProperty(input.args, "title");

  return {
    changeKind: input.changeKind,
    issueId: input.result.subIssueId,
    issueNumber: input.result.subIssueNumber,
    repo: input.repo,
    status: "pending",
    taskId: subIssue?.taskId ?? `issue-${input.result.subIssueNumber}`,
    ...(title === undefined ? {} : { title }),
  };
}

export async function runIssueOrchestration(
  rawInput: RunExecutionInput,
  deps: RunExecutionDeps,
  observers: RunExecutionObservers = {},
): Promise<RunExecutionResult> {
  const fallbackRunId =
    typeof rawInput.runId === "string" && rawInput.runId.trim().length > 0
      ? rawInput.runId
      : uuidv7();
  const sessionController = new AbortController();
  const cleanup = deps.cleanup ?? createLocalCleanup();
  const logger = deps.logger.child({ runId: fallbackRunId });
  const bridgeObservers = deps.runEvents
    ? createRunEventsBridge({ logger, runEvents: deps.runEvents, runId: fallbackRunId })
    : undefined;
  const activeObservers = bridgeObservers
    ? composeObservers(observers, bridgeObservers)
    : observers;

  let currentPhase: RunPhase | undefined;
  let currentStatus: RunStatus = "running";
  let runState: RunState | undefined;
  let cleanupStarted = false;
  let externalAbortListener: (() => void) | undefined;

  const safeSetRunStatus = (status: RunStatus): void => {
    currentStatus = status;
    if (!deps.db) {
      return;
    }

    try {
      deps.db.setRunStatus(fallbackRunId, status);
    } catch (error) {
      logger.warn({ err: error, runId: fallbackRunId, status }, "failed to set run status");
    }
  };

  const safeSetRunPhase = (phase: RunPhase | null): void => {
    if (phase !== null) {
      currentPhase = phase;
    }

    if (!deps.db) {
      return;
    }

    try {
      deps.db.setRunPhase(fallbackRunId, phase);
    } catch (error) {
      logger.warn({ err: error, phase, runId: fallbackRunId }, "failed to set run phase");
    }
  };

  const notifyPhase = (phase: RunPhase, details?: unknown): void => {
    safeSetRunPhase(phase);
    if (activeObservers.onPhase) {
      safeObserverCall(logger, () => activeObservers.onPhase?.(phase, details), {
        observer: "onPhase",
        phase,
      });
    }
  };

  const syncRunToDb = async (): Promise<void> => {
    if (!deps.db || !runState) {
      return;
    }

    try {
      deps.db.insertRun(runState);
      deps.db.setRunStatus(fallbackRunId, currentStatus);
      if (currentPhase) {
        deps.db.setRunPhase(fallbackRunId, currentPhase);
      }
    } catch (error) {
      logger.warn({ err: error, runId: fallbackRunId }, "failed to sync run state to SQLite");
    }
  };

  const writeAndSyncRunState = async (): Promise<void> => {
    if (!runState) {
      return;
    }

    await deps.writeRunState(fallbackRunId, runState);
    await syncRunToDb();
  };

  const notifySession = (event: { kind: string; payload?: unknown; sessionId: string }): void => {
    if (activeObservers.onSession) {
      safeObserverCall(logger, () => activeObservers.onSession?.(event), {
        observer: "onSession",
        sessionId: event.sessionId,
      });
    }
  };

  const notifySubIssue = (event: { kind: "created" | "updated"; payload: unknown }): void => {
    if (activeObservers.onSubIssue) {
      safeObserverCall(logger, () => activeObservers.onSubIssue?.(event), {
        observer: "onSubIssue",
      });
    }
  };

  const triggerCleanup = async (): Promise<void> => {
    if (cleanupStarted) {
      return;
    }

    cleanupStarted = true;
    notifyPhase("cleanup");
    try {
      await cleanup.triggerAll();
    } catch (error) {
      logger.error({ err: error, runId: fallbackRunId }, "cleanup failed");
    }
  };

  if (deps.signal) {
    externalAbortListener = () => {
      sessionController.abort();
    };

    if (deps.signal.aborted) {
      sessionController.abort();
    } else {
      deps.signal.addEventListener("abort", externalAbortListener, { once: true });
    }
  }

  try {
    const input = RunExecutionInputSchema.parse({ ...rawInput, runId: fallbackRunId });
    const cfg = await deps.loadConfig(input.configPath);
    const configuredVaultIdCandidate = input.vaultId ?? cfg.vaultId;
    const configuredVaultId =
      typeof configuredVaultIdCandidate === "string" && configuredVaultIdCandidate.length > 0
        ? configuredVaultIdCandidate
        : undefined;
    const { name: repoName, owner } = parseRepoRef(input.repo);
    const repoSlug = `${owner}/${repoName}`;
    let origin = runOriginFromExecutionInput(input, repoSlug);
    let githubAccess = await resolveGitHubAccessFromDeps(deps, owner, repoName);
    let octokit = githubAccess.octokit;

    if (input.dryRun) {
      notifyPhase("preflight", { dryRun: true });
      try {
        await deps.runPreflight({
          githubAuth: repositoryAuthorizationForPreflight(githubAccess),
          ...(input.origin === "github_issue" ? { issueN: input.issue } : {}),
          octokit,
          owner,
          repo: repoName,
          skipAnthropicCheck: true,
        });
      } catch (error) {
        notifyLog(
          logger,
          activeObservers,
          "warn",
          "preflight validation failed in dry-run mode; continuing with offline plan input",
          { err: error },
        );
      }

      throwIfAborted(sessionController.signal);

      let issueTitle = originDisplay(origin);
      let issueBody = "";
      if (input.origin === "github_issue") {
        try {
          const result = await deps.readIssue(octokit, owner, repoName, input.issue);
          issueTitle = result.issue.title;
          issueBody = result.issue.body ?? "";
        } catch (error) {
          notifyLog(
            logger,
            activeObservers,
            "warn",
            "failed to read GitHub issue in dry-run mode; using synthetic issue data",
            { err: error },
          );
        }
      }

      notifyPhase("decomposition", { dryRun: true });
      const decompositionPlan = buildDryRunDecompositionPlan({
        branch: `agent/${originBranchSegment(origin)}/${slug(issueTitle)}`,
        cfg,
        issueBody,
        issueNumber: origin.type === "github_issue" ? origin.issueNumber : null,
        issueTitle,
        origin,
        repo: `${owner}/${repoName}`,
      });

      safeSetRunStatus("completed");
      return {
        aborted: false,
        decompositionPlan,
        runId: fallbackRunId,
        status: "completed",
        timedOut: false,
      };
    }

    if (!deps.db) {
      throw new RunExecutionFailure(
        "db_missing",
        "dashboard db module is required outside dry-run mode",
      );
    }
    const db = deps.db;

    const anthropicClient = deps.anthropicClient;
    if (!anthropicClient) {
      throw new RunExecutionFailure(
        "anthropic_client_missing",
        "Anthropic client is required outside dry-run mode",
      );
    }

    notifyPhase("preflight");
    let preflight: Awaited<ReturnType<typeof runPreflight>>;
    try {
      preflight = await deps.runPreflight({
        anthropicClient,
        githubAuth: repositoryAuthorizationForPreflight(githubAccess),
        ...(input.origin === "github_issue" ? { issueN: input.issue } : {}),
        octokit,
        owner,
        repo: repoName,
      });
    } catch (error) {
      throw new RunExecutionFailure("preflight_failed", errorMessageFromUnknown(error));
    }
    const allMcpServers = db.listMcpServers();
    assertBuiltinGitHubMcpEnabled(allMcpServers);
    if (origin.type === "linear_issue") {
      assertLinearMcpReadyForOrigin(allMcpServers, {
        requireManagedVaultCredential: configuredVaultId === undefined,
      });
    }
    const earlyMcpServers = allMcpServers.filter((server) => server.enabled);
    if (configuredVaultId === undefined) {
      // Managed vaults have no pre-provisioned credentials to reuse. Enabled
      // MCP servers with a token env configured need a local token before we
      // create credentials; blank token env means unauthenticated/public MCP
      // except for Linear-origin runs, which are checked above.
      const missingMcpEnv = earlyMcpServers
        .filter((server) => {
          if (!mcpServerNeedsTokenEnv(server)) {
            return false;
          }
          const token = process.env[server.tokenEnvName];
          return typeof token !== "string" || token.length === 0;
        })
        .map((server) => `${server.name} (${server.tokenEnvName})`);
      if (missingMcpEnv.length > 0) {
        throw new RunExecutionFailure(
          "mcp_env_missing",
          `MCP server token env vars not set: ${missingMcpEnv.join(", ")}`,
        );
      }
    }
    const baseBranch = resolveBaseBranch(cfg.pr.base, preflight.github.defaultBranch);
    throwIfAborted(sessionController.signal);

    notifyPhase("environment");
    const cachedAgentState = await deps.readAgentState();
    const repoEnvRow = db.getRepoEnvironment(repoSlug);
    let environmentId: string;

    if (repoEnvRow) {
      const ensureRepoOutcome = await deps.ensureEnvironmentForRepo(anthropicClient, {
        cached: {
          definitionHash: repoEnvRow.definitionHash,
          environmentId: repoEnvRow.environmentId,
        },
        packages: repoEnvRow.packages,
        repo: repoSlug,
      });
      if (ensureRepoOutcome.created || ensureRepoOutcome.updated) {
        db.setRepoEnvironmentAnthropicState(repoSlug, {
          definitionHash: ensureRepoOutcome.hash,
          environmentId: ensureRepoOutcome.environmentId,
        });
      }
      environmentId = ensureRepoOutcome.environmentId;
    } else {
      const ensureOutcome = await deps.ensureEnvironment(anthropicClient, cachedAgentState);
      environmentId = ensureOutcome.environmentId;
    }
    await deps.seedAgentPrompts({ db, logger });
    const prompts = await deps.loadAgentPrompts({ db, logger });
    // MCP servers are managed in the WebUI (`/mcp-servers`). We re-load the
    // enabled rows here in case the operator toggled rows between preflight
    // and now; configured token-env presence is already validated above.
    const latestMcpServers = db.listMcpServers();
    assertBuiltinGitHubMcpEnabled(latestMcpServers);
    if (origin.type === "linear_issue") {
      assertLinearMcpReadyForOrigin(latestMcpServers, {
        requireManagedVaultCredential: configuredVaultId === undefined,
      });
    }
    const mcpServers = latestMcpServers.filter((server) => server.enabled);
    const agents = await deps.ensureAgents(anthropicClient, {
      cfg,
      childPrompt: prompts.child,
      environmentId,
      forceRecreate: deps.forceRecreate,
      mcpServers,
      parentCustomTools: deps.parentCustomTools,
      parentPrompt: prompts.parent,
    });
    throwIfAborted(sessionController.signal);

    notifyPhase("lock");
    await deps.acquireRunLock();
    cleanup.register(async () => {
      await deps.releaseRunLock();
    });
    throwIfAborted(sessionController.signal);

    notifyPhase("vault");
    let managedVault = false;
    let vaultId: string | undefined;
    const ensuredCredentials: Array<{ credentialId: string; managed: boolean }> = [];
    const githubMcpCredentialIds = new Set<string>();
    const ensuredCredentialIds = new Set<string>();
    const recordEnsuredCredential = (credential: EnsuredMcpCredential) => {
      if (ensuredCredentialIds.has(credential.credentialId)) {
        return;
      }

      ensuredCredentialIds.add(credential.credentialId);
      ensuredCredentials.push({
        credentialId: credential.credentialId,
        managed: credential.managedByUs,
      });
      if (credential.mcpServerUrl === GITHUB_MCP_URL) {
        githubMcpCredentialIds.add(credential.credentialId);
      }
    };

    const vault = await deps.ensureVault(anthropicClient, {
      configVaultId: configuredVaultId,
    });
    vaultId = vault.vaultId;
    managedVault = vault.managedByUs;
    cleanup.register(async () => {
      if (!vaultId) {
        return;
      }

      await deps.releaseVault(anthropicClient, {
        credentials: ensuredCredentials,
        managedVault,
        vaultId,
      });
    });

    // Resolve env-backed bearer tokens for enabled MCP servers when needed,
    // then ensure one Vault credential per `mcp_server_url`. Configured vaults
    // may already contain matching credentials, so token env vars are optional
    // until a missing credential needs to be created.
    const resolvedMcpCredentials = resolveMcpCredentials(mcpServers, {
      githubAccess,
      requireLinearCredential: origin.type === "linear_issue",
      requireToken: managedVault,
    });
    const ensured = await deps.ensureMcpCredentials(anthropicClient, {
      onCredentialEnsured: recordEnsuredCredential,
      servers: resolvedMcpCredentials,
      vaultId: vault.vaultId,
    });
    for (const credential of ensured) {
      recordEnsuredCredential(credential);
    }
    throwIfAborted(sessionController.signal);

    let parentIssueId: number | undefined;
    let subIssues: Awaited<ReturnType<typeof readIssue>>["subIssues"] = [];
    let branchTitle = originShortDisplay(origin);

    if (input.origin === "github_issue") {
      const issueRead = await deps.readIssue(octokit, owner, repoName, input.issue);
      parentIssueId = issueRead.issue.id;
      subIssues = issueRead.subIssues;
      branchTitle = issueRead.issue.title;
      origin = githubIssueOrigin({
        issueNumber: issueRead.issue.number,
        repo: repoSlug,
        title: issueRead.issue.title,
      });
    }

    const branch = `agent/${originBranchSegment(origin)}/${slug(branchTitle)}`;
    let repoContext: string | null = null;
    try {
      const loadRepoContext = deps.loadRepoContext ?? defaultLoadRepoContext;
      const formatRepoContext = deps.formatRepoContext ?? defaultFormatRepoContext;
      const loadedRepoContext = await loadRepoContext(octokit, owner, repoName, baseBranch, logger);
      repoContext = formatRepoContext(loadedRepoContext, baseBranch);
    } catch (error) {
      logger.warn(
        { baseBranch, err: error, repo: repoSlug },
        "failed to load repository context; continuing without repository context",
      );
    }
    throwIfAborted(sessionController.signal);

    runState = {
      branch,
      issueNumber: origin.type === "github_issue" ? origin.issueNumber : null,
      origin,
      repo: `${owner}/${repoName}`,
      runId: fallbackRunId,
      sessionIds: [],
      startedAt: new Date().toISOString(),
      subIssues: [],
      vaultId: vault.vaultId,
    };

    safeSetRunStatus("running");
    await writeAndSyncRunState();

    notifyPhase("session_start");
    const parentSession = await anthropicClient.beta.sessions.create({
      agent: agents.parentAgentId,
      environment_id: environmentId,
      resources: [
        {
          authorization_token: githubAccess.authorizationToken,
          checkout: { name: branch, type: "branch" },
          mount_path: `/workspace/${repoName}`,
          type: "github_repository",
          url: `https://github.com/${owner}/${repoName}`,
        },
      ],
      vault_ids: [vault.vaultId],
    });
    notifySession({ kind: "created", payload: { role: "parent" }, sessionId: parentSession.id });
    runState.sessionIds = [...runState.sessionIds, parentSession.id];
    await writeAndSyncRunState();
    try {
      db.insertSessionPlaceholder(fallbackRunId, parentSession.id);
    } catch (error) {
      logger.warn(
        { err: error, runId: fallbackRunId, sessionId: parentSession.id },
        "failed to record parent session placeholder",
      );
    }
    cleanup.register(async () => {
      await deleteSessionForCleanup(anthropicClient, parentSession.id, logger);
    });
    registerGitHubAppTokenRefresh({
      anthropicClient,
      cleanup,
      credentialIds: () => [...githubMcpCredentialIds],
      getAccess: () => githubAccess,
      githubAuth: deps.githubAuth,
      logger,
      onAccessRefreshed: (access) => {
        githubAccess = access;
        octokit = access.octokit;
      },
      owner,
      repo: repoName,
      repoResourceId: findGitHubRepositoryResourceId(parentSession),
      sessionId: parentSession.id,
      updateMcpCredentialToken: deps.updateMcpCredentialToken,
      vaultId: vault.vaultId,
    });

    const repoParentPromptBody = readRepoPromptBody(db, repoSlug, "parent", logger);

    const parentPromptText = deps.buildParentPrompt({
      baseBranch,
      branch,
      commitStyle: cfg.commitStyle,
      git: cfg.git,
      maxSubIssues: cfg.maxSubIssues,
      origin,
      parentIssueNumber: origin.type === "github_issue" ? origin.issueNumber : undefined,
      repoContext,
      repoName,
      repoOwner: owner,
      repoPrompt: repoParentPromptBody,
    });

    await anthropicClient.beta.sessions.events.send(parentSession.id, {
      events: [
        {
          content: [{ text: parentPromptText, type: "text" }],
          type: "user.message",
        },
      ],
    });
    notifySession({ kind: "prompt_sent", sessionId: parentSession.id });
    throwIfAborted(sessionController.signal);

    const handlers = {
      create_final_pr: async (args: unknown) => {
        notifyPhase("finalize_pr");
        const finalPrOutcome = await deps.handleCreateFinalPr(
          {
            baseBranch,
            cfg,
            octokit,
            origin,
            owner,
            parentIssueNumber: origin.type === "github_issue" ? origin.issueNumber : undefined,
            repo: repoName,
            runState: runState as RunState,
          },
          args,
        );

        if (finalPrOutcome.success) {
          runState = { ...(runState as RunState), prUrl: finalPrOutcome.prUrl };
          await writeAndSyncRunState();
        }

        return finalPrOutcome;
      },
      create_sub_issue: async (args: unknown) => {
        notifyPhase("decomposition");
        if (origin.type !== "github_issue" || parentIssueId === undefined) {
          return {
            error: {
              message: "create_sub_issue is only supported for GitHub issue origins",
              type: "unsupported_origin",
            },
            reused: false,
            subIssueId: 0,
            subIssueNumber: 0,
            success: false,
          };
        }

        const previousSubIssues = (runState as RunState).subIssues;
        const createSubIssueResult = await deps.handleCreateSubIssue(
          {
            cfg,
            existingSubIssues: subIssues,
            octokit,
            owner,
            parentIssueId,
            parentIssueNumber: origin.issueNumber,
            repo: repoName,
            runState: runState as RunState,
            writeRunState: deps.writeRunState,
          },
          args,
        );

        if ((runState as RunState).subIssues !== previousSubIssues) {
          await syncRunToDb();
        }

        if (createSubIssueResult.success) {
          const changeKind = createSubIssueResult.reused ? "updated" : "created";
          notifySubIssue({
            kind: changeKind,
            payload: buildSubIssueObserverPayload({
              args,
              changeKind,
              repo: `${owner}/${repoName}`,
              result: createSubIssueResult,
              runState: runState as RunState,
            }),
          });
        }

        return createSubIssueResult;
      },
    };

    // Surface coordinator/sub-agent thread lifecycle events through the same
    // run event stream so the dashboard can render multi-agent activity. The
    // observer is invoked synchronously from runSession's event loop; we keep
    // the work cheap (no DB I/O on the hot path beyond placeholder rows).
    const threadObserver: ThreadObserver = {
      onThreadCreated(event) {
        notifyPhase("child_execution", { agentName: event.agentName });
        notifySession({
          kind: "thread_created",
          payload: {
            agentName: event.agentName,
            role: "child",
            sessionThreadId: event.sessionThreadId,
          },
          sessionId: parentSession.id,
        });
      },
      onThreadStatus(event) {
        notifySession({
          kind: `thread_status_${event.status}`,
          payload: {
            agentName: event.agentName,
            sessionThreadId: event.sessionThreadId,
            status: event.status,
          },
          sessionId: parentSession.id,
        });
      },
      onThreadMessage(event) {
        notifySession({
          kind: event.direction === "sent" ? "thread_message_sent" : "thread_message_received",
          payload: {
            direction: event.direction,
            from: event.from ?? null,
            preview: event.preview ?? null,
            sessionThreadId: event.sessionThreadId,
            to: event.to ?? null,
          },
          sessionId: parentSession.id,
        });
      },
    };

    const sessionResult = await deps.runSession(anthropicClient, {
      handlers,
      logger,
      model: cfg.models.parent,
      sessionId: parentSession.id,
      signal: sessionController.signal,
      threadObserver,
      timeouts: {
        maxWallClockMs: cfg.maxRunMinutes * 60 * 1000,
      },
    });
    notifySession({ kind: "completed", payload: sessionResult, sessionId: parentSession.id });

    try {
      db.insertSession(fallbackRunId, sessionResult);
    } catch (error) {
      logger.warn({ err: error, runId: fallbackRunId }, "failed to sync session result to SQLite");
    }

    if (sessionController.signal.aborted || sessionResult.aborted) {
      notifyPhase("aborted");
      safeSetRunStatus("aborted");
      await triggerCleanup();
      return {
        aborted: true,
        runId: fallbackRunId,
        status: "aborted",
        timedOut: sessionResult.timedOut,
      };
    }

    if (sessionResult.errored) {
      throw new RunExecutionFailure("session_error", "Session stream failed before completion");
    }

    if (sessionResult.timedOut) {
      throw new RunExecutionFailure("timeout", "Session timed out before completion");
    }

    if (!runState.prUrl) {
      throw new RunExecutionFailure(
        "final_pr_missing",
        "Final PR URL was not recorded in run state",
      );
    }

    safeSetRunStatus("completed");
    await triggerCleanup();
    return {
      aborted: false,
      prUrl: runState.prUrl,
      runId: fallbackRunId,
      status: "completed",
      timedOut: false,
    };
  } catch (error) {
    const wasAborted = error instanceof RunExecutionAborted || sessionController.signal.aborted;
    const errored = categorizeError(error);
    const status: RunStatus = wasAborted ? "aborted" : "failed";

    if (wasAborted) {
      notifyPhase("aborted");
    }

    safeSetRunStatus(status);
    notifyLog(logger, activeObservers, "error", "run orchestration failed", {
      err: error,
      type: errored.type,
    });
    await triggerCleanup();

    return {
      aborted: wasAborted,
      errored,
      runId: fallbackRunId,
      status,
      timedOut: errored.type === "timeout",
    };
  } finally {
    if (deps.signal && externalAbortListener) {
      deps.signal.removeEventListener("abort", externalAbortListener);
    }
  }
}
