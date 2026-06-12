#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { Hono } from "hono";

import { PARENT_CUSTOM_TOOLS } from "@/parent-tools";
import { handleCreateSubIssue } from "@/features/decomposition/handler";
import { createApp } from "@/features/dashboard/server";
import { startDevTunnel } from "@/features/dev-tunnel";
import { handleCreateFinalPr } from "@/features/finalize-pr/handler";
import { createGithubTriggerPoller } from "@/features/github-trigger/poller";
import { parseGithubTriggerConfigFromEnv } from "@/features/github-trigger/schemas";
import { runPreflight } from "@/features/preflight/validate";
import { createRunApiRoutes } from "@/features/run-api/server";
import {
  runIssueOrchestration,
  type RunExecutionDeps,
  type RunExecutionResult as CoreRunExecutionResult,
} from "@/features/run-execution/handler";
import {
  createRunQueueModule,
  type RunExecutionInput as QueuedRunExecutionInput,
  type RunExecutionResult as QueuedRunExecutionResult,
} from "@/features/run-queue/handler";
import {
  createStaleRunReaper,
  parseStaleRunReaperConfigFromEnv,
} from "@/features/stale-run-reaper/reaper";
import { ensureEnvironment, ensureEnvironmentForRepo } from "@/shared/agents/environment";
import { buildParentPrompt } from "@/shared/agents/prompts/parent";
import {
  createDatabaseAgentRegistryStateStore,
  createRegistry,
} from "@/shared/agents/registry";
import { migrateLegacyAgentStateToDb } from "@/shared/agents/state-migration";
import { loadConfig } from "@/shared/config";
import {
  createGitHubAuthProvider,
  formatRepoContext,
  type GitHubAuthConfig,
  loadRepoContext,
  readIssue,
} from "@/shared/github";
import { createLogger } from "@/shared/logging";
import { createDbModule } from "@/shared/persistence/db";
import { loadAgentSystemPrompts } from "@/shared/prompts/loader";
import { seedDefaultPrompts } from "@/shared/prompts/seeder";
import { createRunEventsModule } from "@/shared/run-events";
import { runSession, type SessionClient } from "@/shared/session";
import { createCleanupRegistry } from "@/shared/signals";
import { acquireRunLock, readAgentState, releaseRunLock, writeRunState } from "@/shared/state";
import {
  ensureMcpCredentials,
  ensureVault,
  updateMcpCredentialToken,
} from "@/shared/vault";

type BunServer = {
  stop(force?: boolean): void;
};

type BunRuntime = {
  serve(options: {
    fetch: (request: Request) => Response | Promise<Response>;
    hostname: string;
    /**
     * Maximum amount of time a connection is allowed to be idle before the
     * server closes it (in seconds). `0` disables the timeout. Bun's default
     * of 10s breaks long-lived SSE streams that legitimately go silent while
     * waiting on Managed Agents thread activity.
     */
    idleTimeout?: number;
    port: number;
  }): BunServer;
};

type ServerEnv = {
  anthropicApiKey: string;
  configPath?: string;
  dbPath: string;
  githubAuth: GitHubAuthConfig;
  host: string;
  logFile?: string;
  logLevel?: string;
  port: number;
};

const DEFAULT_DB_PATH = ".github-issue-agent/dashboard.db";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

function requiredEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    process.stderr.write(`${name} is required\n`);
    process.exit(1);
  }

  return value;
}

function parsePort(rawPort: string | undefined): number {
  const port = Number.parseInt(rawPort ?? String(DEFAULT_PORT), 10);

  if (!Number.isInteger(port) || port <= 0) {
    process.stderr.write("PORT must be a positive integer\n");
    process.exit(1);
  }

  return port;
}

function optionalEnv(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function parsePositiveIntEnv(name: string, value: string | undefined): number | undefined {
  const rawValue = optionalEnv(value);
  if (rawValue === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    process.stderr.write(`${name} must be a positive integer\n`);
    process.exit(1);
  }

  return parsed;
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n");
}

function readGitHubPrivateKey(env: NodeJS.ProcessEnv): string | undefined {
  const inlineKey = optionalEnv(env.GITHUB_APP_PRIVATE_KEY);
  if (inlineKey !== undefined) {
    return normalizePrivateKey(inlineKey);
  }

  const privateKeyPath = optionalEnv(env.GITHUB_APP_PRIVATE_KEY_PATH);
  if (privateKeyPath === undefined) {
    return undefined;
  }

  return readFileSync(resolve(process.cwd(), privateKeyPath), "utf8");
}

function readGitHubAuthConfig(env: NodeJS.ProcessEnv): GitHubAuthConfig {
  const appId = parsePositiveIntEnv("GITHUB_APP_ID", env.GITHUB_APP_ID);
  const privateKey = readGitHubPrivateKey(env);
  const installationId = parsePositiveIntEnv(
    "GITHUB_APP_INSTALLATION_ID",
    env.GITHUB_APP_INSTALLATION_ID,
  );

  if (appId === undefined) {
    process.stderr.write("GITHUB_APP_ID is required for GitHub App authentication\n");
    process.exit(1);
  }
  if (privateKey === undefined || privateKey.trim().length === 0) {
    process.stderr.write(
      "GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH is required for GitHub App authentication\n",
    );
    process.exit(1);
  }

  return {
    appId,
    ...(installationId === undefined ? {} : { installationId }),
    mode: "app",
    privateKey,
  };
}

function readServerEnv(env: NodeJS.ProcessEnv): ServerEnv {
  return {
    anthropicApiKey: requiredEnv("ANTHROPIC_API_KEY", env.ANTHROPIC_API_KEY),
    configPath: optionalEnv(env.CONFIG_PATH),
    dbPath: optionalEnv(env.DB_PATH) ?? DEFAULT_DB_PATH,
    githubAuth: readGitHubAuthConfig(env),
    host: optionalEnv(env.HOST) ?? DEFAULT_HOST,
    logFile: optionalEnv(env.LOG_FILE),
    logLevel: optionalEnv(env.LOG_LEVEL),
    port: parsePort(env.PORT),
  };
}

function assertFinalRunStatus(result: CoreRunExecutionResult): QueuedRunExecutionResult {
  if (
    result.status === "aborted" ||
    result.status === "completed" ||
    result.status === "failed"
  ) {
    return result;
  }

  return {
    aborted: false,
    errored: {
      message: `run execution returned non-terminal status: ${result.status}`,
      type: "non_terminal_status",
    },
    runId: result.runId,
    status: "failed",
    timedOut: false,
  };
}

function getBunRuntime(): BunRuntime {
  const runtime = globalThis as typeof globalThis & { Bun?: BunRuntime };
  if (!runtime.Bun) {
    throw new Error("Bun runtime is required for the HTTP server entrypoint");
  }

  return runtime.Bun;
}

const serverEnv = readServerEnv(process.env);
const cfg = await loadConfig(serverEnv.configPath);
const logger = createLogger({ level: serverEnv.logLevel, logFile: serverEnv.logFile });
const githubAuth = createGitHubAuthProvider(serverEnv.githubAuth, { logger });
const cleanup = createCleanupRegistry({ logger });
let resolveShutdown: () => void = () => undefined;
const shutdownPromise = new Promise<void>((resolve) => {
  resolveShutdown = resolve;
});
cleanup.register(async () => {
  if (process.exitCode === 130 || process.exitCode === 143) {
    process.exitCode = 0;
  }
  resolveShutdown();
});
const db = createDbModule(serverEnv.dbPath, { logger });

db.initDb();
await migrateLegacyAgentStateToDb({ db, readAgentState });
cleanup.register(async () => {
  try {
    db.close();
  } catch (err) {
    logger.warn({ err }, "failed to close dashboard db");
  }
});

logger.debug(
  {
    childModel: cfg.models.child,
    configPath: serverEnv.configPath,
    maxSubIssues: cfg.maxSubIssues,
    parentModel: cfg.models.parent,
  },
  "loaded server config",
);

await seedDefaultPrompts({ db, logger });

const runEvents = createRunEventsModule({ db, logger });
cleanup.register(async () => {
  runEvents.close();
});

const Anthropic = (await import("@anthropic-ai/sdk")).default;
const anthropicClient = new Anthropic();
const agentRegistry = createRegistry({
  agentStateStore: createDatabaseAgentRegistryStateStore(db),
});

const executor = async (
  input: QueuedRunExecutionInput,
): Promise<QueuedRunExecutionResult> => {
  const { signal, ...rawInput } = input;
  const runDeps: RunExecutionDeps = {
    acquireRunLock,
    anthropicClient: anthropicClient as RunExecutionDeps["anthropicClient"],
    buildParentPrompt,
    db,
    ensureAgents: agentRegistry.ensureAgents,
    ensureEnvironment,
    ensureEnvironmentForRepo,
    ensureMcpCredentials,
    ensureVault,
    githubAuth,
    handleCreateFinalPr,
    handleCreateSubIssue,
    formatRepoContext,
    loadAgentPrompts: loadAgentSystemPrompts,
    loadConfig,
    loadRepoContext,
    logger,
    parentCustomTools: PARENT_CUSTOM_TOOLS,
    readIssue,
    releaseRunLock,
    runEvents,
    runPreflight,
    runSession,
    seedAgentPrompts: seedDefaultPrompts,
    signal,
    updateMcpCredentialToken,
    writeRunState,
  };
  const result = await runIssueOrchestration(
    { ...rawInput, configPath: rawInput.configPath ?? serverEnv.configPath },
    runDeps,
  );

  return assertFinalRunStatus(result);
};

const runQueue = createRunQueueModule({ db, executor, logger, runEvents });
cleanup.register(async () => {
  await runQueue.stop({ force: false });
});

const staleRunReaperConfig = parseStaleRunReaperConfigFromEnv(process.env);
const staleRunReaper = createStaleRunReaper({
  anthropicClient,
  cancelRun: async (runId) => {
    const wasActive = runQueue.getActiveRunId() === runId;
    const cancelled = await runQueue.cancel(runId);
    if (cancelled) {
      return "cancelled";
    }

    return wasActive ? "timed_out" : "not_active";
  },
  config: staleRunReaperConfig,
  db,
  logger,
  runEvents,
});
cleanup.register(async () => {
  await staleRunReaper.stop();
});

// Snapshot running rows with persisted Managed Agents sessions before queue
// orphan resync. These runs are excluded from queue aborts so the reaper can
// attempt remote stop/archive confirmation after the HTTP server is already live.
const startupCandidates = staleRunReaper.snapshotRunningCandidates();
runQueue.start({ resyncExcludeRunIds: startupCandidates.map((candidate) => candidate.runId) });

// The polled repositories list is now owned by the WebUI (`polled_repositories`
// table). The poller is always started; if the table is empty the cycle is a
// no-op until a repo is added through the dashboard.
const githubTriggerConfig = parseGithubTriggerConfigFromEnv(process.env);
const githubTriggerPoller = createGithubTriggerPoller({
  config: githubTriggerConfig,
  db,
  enqueue: (input) => runQueue.enqueue({ issue: input.issue, repo: input.repo }),
  logger,
  resolveClient: async ({ owner, repo }) => {
    const access = await githubAuth.resolveRepositoryAccess(owner, repo);
    return access.octokit;
  },
});
githubTriggerPoller.start();
cleanup.register(async () => {
  await githubTriggerPoller.stop();
});

// Optional local dev tunnel (ngrok + mcp-gateway + mcp-proxy).
// Enabled only when ENABLE_DEV_TUNNEL=true; production (Fly) leaves this
// disabled and relies on the Cloudflare Tunnel sidecar in scripts/start.sh.
// Failures are logged but do not abort the server: the user can still drive
// runs that do not need the tunnel-backed MCP servers.
const devTunnel = await startDevTunnel({ db, env: process.env, logger }).catch((err) => {
  logger.error({ err }, "failed to start dev tunnel; continuing without it");
  return undefined;
});
if (devTunnel) {
  cleanup.register(async () => {
    await devTunnel.stop();
  });
  logger.info({ publicUrl: devTunnel.publicUrl }, "dev tunnel ready");
}

const dashboardApp = createApp({
  anthropicClient: anthropicClient as unknown as SessionClient,
  config: cfg,
  db,
  githubAuth,
  githubTriggerConfig,
  logger,
  runEvents: runEvents as Parameters<typeof createApp>[0]["runEvents"],
  runQueue,
  staticAssetsDir: "./dist",
});
const app = new Hono();

app.route(
  "/",
  createRunApiRoutes({
    anthropicClient: anthropicClient as unknown as SessionClient,
    db,
    logger,
    runEvents,
    runQueue,
  }),
);
app.route("/", dashboardApp);

const server = getBunRuntime().serve({
  fetch: app.fetch,
  hostname: serverEnv.host,
  // SSE consumers (e.g. /api/runs/:id/events) hold a connection open for the
  // entire run lifetime. While the coordinator agent is awaiting a child
  // thread reply the stream legitimately stays silent for long stretches, so
  // the default 10s idle timeout would cut the socket. Disable it.
  idleTimeout: 0,
  port: serverEnv.port,
});
cleanup.register(async () => {
  server.stop(true);
});

process.stdout.write(`Listening on http://${serverEnv.host}:${serverEnv.port}\n`);

// Remote stale-session recovery can block on Managed Agents API calls; start it
// only after Bun.serve has bound the port so dashboard/API startup stays fast.
staleRunReaper.start({ startupCandidates });

await shutdownPromise;
