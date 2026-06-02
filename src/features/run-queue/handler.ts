import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { createDbModule } from "@/shared/persistence/db";
import type { createRunEventsModule } from "@/shared/run-events";
import { githubIssueOrigin, linearIssueOrigin, originBranchSegment } from "@/shared/run-origin";
import type { RunState, RunStatus } from "@/shared/types";
import { type ParsedRunStartInput, type RunStartInput, RunStartInputSchema } from "./schemas";

type DbModule = Pick<
  ReturnType<typeof createDbModule>,
  "insertRun" | "listRegisteredRepositories" | "listRuns" | "resyncOrphanedRuns" | "setRunStatus"
>;

type RunEventsModule = Pick<ReturnType<typeof createRunEventsModule>, "emit">;

type FinalRunStatus = Extract<RunStatus, "aborted" | "completed" | "failed">;

type QueuePhase = "aborted" | "completed" | "failed" | "queued" | "running";

type QueuedJob = {
  controller: AbortController;
  input: ResolvedRunStartInput;
  runId: string;
};

type RunningJob = {
  controller: AbortController;
  done: Promise<void>;
  runId: string;
};

type BunUuidApi = {
  randomUUIDv7?: () => string;
};

export type RunExecutionInput = RunStartInput & {
  runId: string;
  signal: AbortSignal;
};

type ResolvedRunStartInput = ParsedRunStartInput & {
  repo: string;
  repositories: string[];
};

export type RunExecutionResult = {
  aborted: boolean;
  decompositionPlan?: unknown;
  errored?: unknown;
  error?: unknown;
  prUrl?: string;
  runId: string;
  status: FinalRunStatus;
  timedOut: boolean;
};

type RunCompletePayload = Omit<RunExecutionResult, "runId">;

export type RunQueueModuleDeps = {
  db: DbModule;
  executor: (input: RunExecutionInput) => Promise<RunExecutionResult>;
  logger?: Logger;
  runEvents: RunEventsModule;
};

export type StopOptions = {
  force?: boolean;
};

export type StartOptions = {
  resyncExcludeRunIds?: readonly string[];
};

const DEFAULT_CANCEL_TIMEOUT_MS = 5_000;
const STATUS_LOOKUP_LIMIT = 10_000;

function createQueuedRunState(runId: string, input: ResolvedRunStartInput): RunState {
  const origin =
    input.origin === "github_issue"
      ? githubIssueOrigin({ issueNumber: input.issue, repo: input.repo })
      : linearIssueOrigin({ identifier: input.linearIssue });

  return {
    branch: `queued/${originBranchSegment(origin)}`,
    issueNumber: origin.type === "github_issue" ? origin.issueNumber : null,
    origin,
    repo: input.repo,
    repositories: input.repositories.map((repo) => ({
      branch: `queued/${originBranchSegment(origin)}`,
      repo,
      role: repo === input.repo ? "primary" : "target",
    })),
    runId,
    sessionIds: [],
    startedAt: new Date().toISOString(),
    subIssues: [],
    vaultId: input.vaultId,
  };
}

function resolveRunStartRepositories(
  input: ParsedRunStartInput,
  registeredRepositories: Array<{ enabled: boolean; repo: string }>,
): ResolvedRunStartInput {
  const enabledRepos = registeredRepositories
    .filter((repository) => repository.enabled)
    .map((repository) => repository.repo);
  const hasExplicitRepositories = input.repositories !== undefined;
  const explicitRepos = input.repositories ?? [];
  const targetRepos = hasExplicitRepositories
    ? explicitRepos
    : input.repo === undefined
      ? enabledRepos
      : [input.repo];
  if (targetRepos.length === 0 && input.repo === undefined) {
    throw new Error("At least one enabled repository must be registered before starting a run");
  }

  const registeredEnabled = new Set(enabledRepos);
  for (const repo of targetRepos) {
    if (!registeredEnabled.has(repo)) {
      throw new Error(`Repository ${repo} is not registered and enabled`);
    }
  }

  let primaryRepo = input.repo;
  if (input.origin === "linear_issue" && primaryRepo === undefined) {
    throw new Error("Linear issue runs require an explicit primary repository");
  }
  if (input.origin === "github_issue" && primaryRepo === undefined) {
    if (targetRepos.length !== 1) {
      throw new Error(
        "GitHub issue number is ambiguous with multiple registered repositories; pass an issue URL",
      );
    }
    const onlyRepo = targetRepos[0];
    if (onlyRepo === undefined) {
      throw new Error("At least one enabled repository must be registered before starting a run");
    }
    primaryRepo = onlyRepo;
  }

  if (primaryRepo === undefined) {
    const firstRepo = targetRepos[0];
    if (firstRepo === undefined) {
      throw new Error("At least one enabled repository must be registered before starting a run");
    }
    primaryRepo = firstRepo;
  }

  if (!registeredEnabled.has(primaryRepo)) {
    throw new Error(`Primary repository ${primaryRepo} is not registered and enabled`);
  }

  const repositories = Array.from(new Set([primaryRepo, ...targetRepos]));
  return { ...input, repo: primaryRepo, repositories };
}

function createRunId(): string {
  const maybeBun = globalThis as typeof globalThis & { Bun?: BunUuidApi };
  return maybeBun.Bun?.randomUUIDv7?.() ?? randomUUID();
}

function errorPayload(error: unknown): { message: string } {
  if (error instanceof Error) {
    return { message: error.message };
  }

  return { message: String(error) };
}

function executionErrorPayload(result: RunExecutionResult): unknown {
  const executionError = result.errored ?? result.error;
  if (executionError !== undefined) {
    return executionError;
  }

  return { message: "executor returned failed status" };
}

function completionPayload(result: RunExecutionResult, status: FinalRunStatus): RunCompletePayload {
  return {
    aborted: status === "aborted" ? true : result.aborted,
    decompositionPlan: result.decompositionPlan,
    errored: result.errored,
    error: result.error,
    prUrl: result.prUrl,
    status,
    timedOut: result.timedOut,
  };
}

function failedCatchCompletionPayload(error: unknown): RunCompletePayload {
  const payload = errorPayload(error);

  return {
    aborted: false,
    errored: payload,
    status: "failed",
    timedOut: false,
  };
}

function abortedCompletionPayload(): RunCompletePayload {
  return {
    aborted: true,
    status: "aborted",
    timedOut: false,
  };
}

function waitForCompletion(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      finish(false);
    }, timeoutMs);

    function finish(completed: boolean): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      resolve(completed);
    }

    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

export function createRunQueueModule(deps: RunQueueModuleDeps) {
  const queue: QueuedJob[] = [];
  let busy = false;
  let currentJob: RunningJob | undefined;
  let orphanResyncCompleted = false;
  let started = false;
  let stopping = false;
  let workerPromise: Promise<void> | undefined;

  function emitPhase(runId: string, phase: QueuePhase): void {
    deps.runEvents.emit(runId, { kind: "phase", payload: { phase } });
  }

  function emitComplete(runId: string, payload: RunCompletePayload): void {
    deps.runEvents.emit(runId, { kind: "complete", payload });
  }

  function setFinalStatus(runId: string, payload: RunCompletePayload): void {
    deps.db.setRunStatus(runId, payload.status);
    emitPhase(runId, payload.status);
    emitComplete(runId, payload);
  }

  async function executeJob(job: QueuedJob): Promise<void> {
    deps.db.setRunStatus(job.runId, "running");
    emitPhase(job.runId, "running");

    let completePayload: RunCompletePayload;

    try {
      const result = await deps.executor({
        ...job.input,
        runId: job.runId,
        signal: job.controller.signal,
      });

      if (result.runId !== job.runId) {
        deps.logger?.warn(
          { actualRunId: result.runId, expectedRunId: job.runId },
          "run executor returned a mismatched run id",
        );
      }

      const finalStatus =
        job.controller.signal.aborted || result.aborted ? "aborted" : result.status;
      if (finalStatus === "failed") {
        deps.runEvents.emit(job.runId, { kind: "error", payload: executionErrorPayload(result) });
      }
      completePayload = completionPayload(result, finalStatus);
    } catch (error) {
      if (job.controller.signal.aborted) {
        completePayload = abortedCompletionPayload();
      } else {
        deps.runEvents.emit(job.runId, { kind: "error", payload: errorPayload(error) });
        completePayload = failedCatchCompletionPayload(error);
      }
    }

    setFinalStatus(job.runId, completePayload);
  }

  async function processJob(job: QueuedJob): Promise<void> {
    const done = executeJob(job);
    currentJob = {
      controller: job.controller,
      done,
      runId: job.runId,
    };

    try {
      await done;
    } finally {
      if (currentJob?.runId === job.runId) {
        currentJob = undefined;
      }
    }
  }

  async function drain(): Promise<void> {
    if (busy) {
      return;
    }

    busy = true;
    try {
      while (started && !stopping) {
        const job = queue.shift();
        if (job === undefined) {
          return;
        }

        await processJob(job);
      }
    } finally {
      busy = false;
    }
  }

  function scheduleWorker(): void {
    if (!started || stopping || busy) {
      return;
    }

    const promise = drain();
    workerPromise = promise;
    void promise
      .catch((error) => {
        deps.logger?.error({ err: error }, "run queue worker failed");
      })
      .finally(() => {
        if (workerPromise === promise) {
          workerPromise = undefined;
        }
      });
  }

  function enqueue(input: RunStartInput): { position: number; runId: string } {
    const parsedInput = RunStartInputSchema.parse(input);
    const resolvedInput = resolveRunStartRepositories(
      parsedInput,
      deps.db.listRegisteredRepositories({ enabledOnly: true }),
    );
    const runId = createRunId();
    const controller = new AbortController();

    deps.db.insertRun(createQueuedRunState(runId, resolvedInput));
    deps.db.setRunStatus(runId, "queued");
    emitPhase(runId, "queued");

    queue.push({ controller, input: resolvedInput, runId });
    const position = queue.length;
    scheduleWorker();

    return { position, runId };
  }

  function getStatus(runId: string): RunStatus | null {
    const run = deps.db
      .listRuns({ limit: STATUS_LOOKUP_LIMIT })
      .find((summary) => summary.runId === runId);
    return run?.status ?? null;
  }

  function getActiveRunId(): string | null {
    return currentJob?.runId ?? null;
  }

  async function cancel(runId: string): Promise<boolean> {
    const queueIndex = queue.findIndex((job) => job.runId === runId);
    if (queueIndex >= 0) {
      const job = queue.splice(queueIndex, 1)[0];
      job?.controller.abort();
      setFinalStatus(runId, abortedCompletionPayload());
      return true;
    }

    if (currentJob?.runId !== runId) {
      return false;
    }

    currentJob.controller.abort();
    const completed = await waitForCompletion(currentJob.done, DEFAULT_CANCEL_TIMEOUT_MS);
    if (completed) {
      deps.db.setRunStatus(runId, "aborted");
    }

    return completed;
  }

  function start(opts: StartOptions = {}): void {
    if (started) {
      return;
    }

    if (!orphanResyncCompleted) {
      deps.db.resyncOrphanedRuns({ excludeRunIds: opts.resyncExcludeRunIds ?? [] });
      // Callers may enqueue before first start; those in-memory jobs are not orphans.
      for (const job of queue) {
        deps.db.setRunStatus(job.runId, "queued");
      }
      orphanResyncCompleted = true;
    }

    started = true;
    stopping = false;
    scheduleWorker();
  }

  async function stop(opts: StopOptions = {}): Promise<void> {
    stopping = true;
    const running = currentJob;

    if (running !== undefined) {
      if (opts.force === true) {
        running.controller.abort();
        await waitForCompletion(running.done, DEFAULT_CANCEL_TIMEOUT_MS);
      } else {
        await running.done;
      }
    }

    if (opts.force !== true && workerPromise !== undefined) {
      await workerPromise;
    }

    started = false;
    stopping = false;
  }

  return {
    cancel,
    enqueue,
    getActiveRunId,
    getStatus,
    start,
    stop,
  };
}
