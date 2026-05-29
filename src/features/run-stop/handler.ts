import process from "node:process";
import type { Logger } from "pino";
import type { StopByIssueRepoInput, StopOutcome } from "@/features/run-stop/schemas";
import type { RunState } from "@/shared/types";

export type DbReader = {
  getRunById(runId: string): RunState | null;
  getRunsByRepo(repo: string): RunState[];
};

export type ProcessControl = {
  isAlive(pid: number): boolean;
  sendTerm(pid: number): void;
};

export type Clock = {
  now(): number;
  wait(ms: number): Promise<void>;
};

export type SessionStatus = "rescheduling" | "running" | "idle" | "terminated";

const LIVE_SESSION_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "running",
  "idle",
  "rescheduling",
]);

export type StopSessionClient = {
  beta: {
    sessions: {
      retrieve(sessionId: string): Promise<{ status: SessionStatus | null | undefined }>;
      archive(sessionId: string): Promise<unknown>;
    };
  };
};

export type StopRunLogger = Pick<Logger, "info" | "warn" | "debug">;

export type StopRunDeps = {
  db: DbReader;
  processControl?: ProcessControl;
  clock?: Clock;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  sessionClient?: StopSessionClient;
  logger?: StopRunLogger;
};

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_MAX_WAIT_MS = 10_000;

function errorCode(err: unknown): string | undefined {
  if (err instanceof Error && "code" in err) {
    const code = (err as NodeJS.ErrnoException).code;
    return typeof code === "string" ? code : undefined;
  }

  return undefined;
}

export const defaultProcessControl: ProcessControl = {
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = errorCode(err);
      if (code === "ESRCH") {
        return false;
      }

      if (code === "EPERM") {
        return true;
      }

      throw err;
    }
  },
  sendTerm(pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      if (errorCode(err) === "ESRCH") {
        return;
      }

      throw err;
    }
  },
};

export const defaultClock: Clock = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function isHttpNotFoundError(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }

  const status = (err as { status?: unknown }).status;
  if (typeof status === "number" && status === 404) {
    return true;
  }

  const name = (err as { name?: unknown }).name;
  if (typeof name === "string" && name === "NotFoundError") {
    return true;
  }

  return false;
}

async function fetchLiveSessions(
  sessionIds: readonly string[],
  client: StopSessionClient,
  logger: StopRunLogger | undefined,
): Promise<string[]> {
  const live: string[] = [];

  for (const sessionId of sessionIds) {
    try {
      const result = await client.beta.sessions.retrieve(sessionId);
      const status = result.status;
      if (status !== null && status !== undefined && LIVE_SESSION_STATUSES.has(status)) {
        live.push(sessionId);
      } else {
        logger?.debug({ sessionId, status }, "anthropic session is not live; skipping archive");
      }
    } catch (err) {
      if (isHttpNotFoundError(err)) {
        logger?.debug(
          { sessionId },
          "anthropic session not found during retrieve; treating as terminated",
        );
        continue;
      }

      logger?.warn(
        { err, sessionId },
        "failed to retrieve anthropic session; treating as live and attempting archive",
      );
      live.push(sessionId);
    }
  }

  return live;
}

async function archiveSessions(
  sessionIds: readonly string[],
  client: StopSessionClient,
  logger: StopRunLogger | undefined,
): Promise<void> {
  for (const sessionId of sessionIds) {
    try {
      await client.beta.sessions.archive(sessionId);
      logger?.info({ sessionId }, "archived anthropic session");
    } catch (err) {
      if (isHttpNotFoundError(err)) {
        logger?.debug({ sessionId }, "anthropic session not found during archive; skipping");
        continue;
      }

      logger?.warn({ err, sessionId }, "failed to archive anthropic session");
    }
  }
}

export function findRunByIssueRepo(input: StopByIssueRepoInput, db: DbReader): RunState | null {
  const repoString = `${input.repo.owner}/${input.repo.name}`;
  const runs = db.getRunsByRepo(repoString);
  const matchingRuns = runs.filter((run) => run.issueNumber === input.issueNumber);

  if (matchingRuns.length === 0) {
    return null;
  }

  return [...matchingRuns].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}

export async function stopRun(runId: string, deps: StopRunDeps): Promise<StopOutcome> {
  const processControl = deps.processControl ?? defaultProcessControl;
  const clock = deps.clock ?? defaultClock;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const logger = deps.logger;

  const run = deps.db.getRunById(runId);
  if (run === null) {
    return { reason: "not_found", status: "not_stopped" };
  }

  const pidAlive = run.pid !== undefined && processControl.isAlive(run.pid);
  const liveSessionIds: string[] = deps.sessionClient
    ? await fetchLiveSessions(run.sessionIds, deps.sessionClient, logger)
    : [];

  if (!pidAlive && liveSessionIds.length === 0) {
    if (run.prUrl !== undefined) {
      return { reason: "already_completed", runId, status: "not_stopped" };
    }

    if (run.pid === undefined) {
      return { reason: "pid_missing", runId, status: "not_stopped" };
    }

    return { reason: "process_not_running", runId, status: "not_stopped" };
  }

  let pidStillAlive = pidAlive;
  if (pidAlive && run.pid !== undefined) {
    processControl.sendTerm(run.pid);

    const deadline = clock.now() + maxWaitMs;
    while (clock.now() < deadline) {
      if (!processControl.isAlive(run.pid)) {
        pidStillAlive = false;
        break;
      }
      await clock.wait(pollIntervalMs);
    }

    if (pidStillAlive) {
      pidStillAlive = processControl.isAlive(run.pid);
    }
  }

  if (deps.sessionClient && liveSessionIds.length > 0) {
    await archiveSessions(liveSessionIds, deps.sessionClient, logger);
  }

  if (pidStillAlive) {
    return { reason: "still_running_after_signal", runId, status: "not_stopped" };
  }

  return { runId, status: "stopped" };
}

export async function stopRunByIssueRepo(
  input: StopByIssueRepoInput,
  deps: StopRunDeps,
): Promise<StopOutcome> {
  const run = findRunByIssueRepo(input, deps.db);
  if (run === null) {
    return { reason: "not_found", status: "not_stopped" };
  }

  return stopRun(run.runId, deps);
}
