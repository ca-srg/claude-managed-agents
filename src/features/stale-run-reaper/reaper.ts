import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsSessionEvent,
  EventListParams,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { Logger } from "pino";
import { z } from "zod";

import type { createDbModule } from "@/shared/persistence/db";
import type { createRunEventsModule } from "@/shared/run-events";

type StaleRunReaperDb = Pick<
  ReturnType<typeof createDbModule>,
  "getRunById" | "getRunStatus" | "listRuns" | "setRunStatusIfCurrent"
>;
type StaleRunReaperRunEvents = Pick<ReturnType<typeof createRunEventsModule>, "emit">;

export type StaleRunReaperSessionClient = {
  beta: {
    sessions: {
      delete(sessionId: string): PromiseLike<unknown>;
      events: {
        list(
          sessionId: string,
          params?: EventListParams,
        ): AsyncIterable<BetaManagedAgentsSessionEvent>;
        send(sessionId: string, params: EventSendParams): PromiseLike<unknown>;
      };
    };
  };
};

export const DEFAULT_STALE_RUN_REAPER_INTERVAL_MS = 60_000;
export const DEFAULT_REQUIRES_ACTION_STALE_MS = 15 * 60_000;
export const DEFAULT_STALE_RUN_REAPER_SCAN_LIMIT = 10_000;
export const DEFAULT_STALE_RUN_REAPER_SESSION_EVENT_LIMIT = 500;

export const StaleRunReaperConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    intervalMs: z.number().int().positive().default(DEFAULT_STALE_RUN_REAPER_INTERVAL_MS),
    requiresActionStaleMs: z.number().int().positive().default(DEFAULT_REQUIRES_ACTION_STALE_MS),
    scanLimit: z.number().int().positive().default(DEFAULT_STALE_RUN_REAPER_SCAN_LIMIT),
    sessionEventLimit: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_STALE_RUN_REAPER_SESSION_EVENT_LIMIT),
  })
  .strict();

export type StaleRunReaperConfig = z.infer<typeof StaleRunReaperConfigSchema>;

export type StaleRunReaperEnv = {
  STALE_RUN_REAPER_ENABLED?: string | undefined;
  STALE_RUN_REAPER_INTERVAL_SECONDS?: string | undefined;
  STALE_RUN_REAPER_REQUIRES_ACTION_STALE_SECONDS?: string | undefined;
};

export type StaleRunReaperSummary = {
  cancelled: number;
  errors: number;
  recovered: number;
  scanned: number;
  skipped: number;
  staleRequiresAction: number;
};

export type StaleRunReaperMode = "live" | "startup";

export type StaleRunReaperCandidate = {
  runId: string;
  sessionIds: readonly string[];
};

export type StaleRunReaper = {
  reapOnce(opts?: {
    candidates?: readonly StaleRunReaperCandidate[];
    mode?: StaleRunReaperMode;
  }): Promise<StaleRunReaperSummary>;
  snapshotRunningCandidates(): StaleRunReaperCandidate[];
  start(opts?: { startupCandidates?: readonly StaleRunReaperCandidate[] }): void;
  stop(): Promise<void>;
};

export type StaleRunReaperCancelResult = "cancelled" | "not_active" | "timed_out";

export type StaleRunReaperDeps = {
  anthropicClient: StaleRunReaperSessionClient;
  cancelRun?: (runId: string) => Promise<StaleRunReaperCancelResult>;
  config?: Partial<StaleRunReaperConfig>;
  db: StaleRunReaperDb;
  logger?: Logger;
  now?: () => Date;
  runEvents: StaleRunReaperRunEvents;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

type SessionStatusEvent = Extract<
  BetaManagedAgentsSessionEvent,
  {
    type:
      | "session.status_idle"
      | "session.status_rescheduled"
      | "session.status_running"
      | "session.status_terminated";
  }
>;

type StaleRequiresActionSession = {
  eventIds: string[];
  idleEventId: string;
  pendingToolUses: BetaManagedAgentsAgentCustomToolUseEvent[];
  processedAt: string;
  sessionId: string;
  staleForMs: number;
  unresolvedEventIds: string[];
};

const STALE_REQUIRES_ACTION_ERROR_TYPE = "stale_requires_action";
const REAPER_COMPONENT = "stale-run-reaper";
const REAPER_REMOTE_CALL_TIMEOUT_MS = 30_000;
const DELETE_SESSION_MAX_ATTEMPTS = 3;
const DELETE_SESSION_RETRY_DELAY_MS = 250;

type RemoteCallResult<T> =
  | { ok: true; value: T }
  | { error: unknown; ok: false; reason: "aborted" | "error" | "timeout" };

type InterruptAndDeleteSessionResult =
  | { ok: true }
  | { error: unknown; ok: false; stage: "delete" | "interrupt" };

function parseBooleanEnv(name: string, value: string | undefined): boolean | undefined {
  const rawValue = value?.trim().toLowerCase();
  if (rawValue === undefined || rawValue.length === 0) {
    return undefined;
  }

  if (rawValue === "true" || rawValue === "1" || rawValue === "yes") {
    return true;
  }

  if (rawValue === "false" || rawValue === "0" || rawValue === "no") {
    return false;
  }

  throw new Error(`${name} must be a boolean (got ${value})`);
}

function parsePositiveIntEnv(name: string, value: string | undefined): number | undefined {
  const rawValue = value?.trim();
  if (rawValue === undefined || rawValue.length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got ${value})`);
  }

  return parsed;
}

export function parseStaleRunReaperConfigFromEnv(env: StaleRunReaperEnv): StaleRunReaperConfig {
  const intervalSeconds = parsePositiveIntEnv(
    "STALE_RUN_REAPER_INTERVAL_SECONDS",
    env.STALE_RUN_REAPER_INTERVAL_SECONDS,
  );
  const staleSeconds = parsePositiveIntEnv(
    "STALE_RUN_REAPER_REQUIRES_ACTION_STALE_SECONDS",
    env.STALE_RUN_REAPER_REQUIRES_ACTION_STALE_SECONDS,
  );

  return StaleRunReaperConfigSchema.parse({
    enabled: parseBooleanEnv("STALE_RUN_REAPER_ENABLED", env.STALE_RUN_REAPER_ENABLED),
    intervalMs: intervalSeconds === undefined ? undefined : intervalSeconds * 1_000,
    requiresActionStaleMs: staleSeconds === undefined ? undefined : staleSeconds * 1_000,
  });
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) {
        return;
      }

      resolved = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function processedAtMillis(event: BetaManagedAgentsSessionEvent): number | null {
  const processedAt = (event as { processed_at?: unknown }).processed_at;
  if (typeof processedAt !== "string" || processedAt.length === 0) {
    return null;
  }

  const millis = new Date(processedAt).getTime();
  return Number.isNaN(millis) ? null : millis;
}

function processedAtString(event: BetaManagedAgentsSessionEvent): string | null {
  const processedAt = (event as { processed_at?: unknown }).processed_at;
  return typeof processedAt === "string" && processedAt.length > 0 ? processedAt : null;
}

function isSessionStatusEvent(event: BetaManagedAgentsSessionEvent): event is SessionStatusEvent {
  return (
    event.type === "session.status_idle" ||
    event.type === "session.status_rescheduled" ||
    event.type === "session.status_running" ||
    event.type === "session.status_terminated"
  );
}

function isAgentCustomToolUseEvent(
  event: BetaManagedAgentsSessionEvent,
): event is BetaManagedAgentsAgentCustomToolUseEvent {
  return event.type === "agent.custom_tool_use";
}

function isUserCustomToolResultEvent(
  event: BetaManagedAgentsSessionEvent,
): event is Extract<BetaManagedAgentsSessionEvent, { type: "user.custom_tool_result" }> {
  return event.type === "user.custom_tool_result";
}

function remoteCallError(message: string): Error {
  return new Error(message);
}

function isAnthropicNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }

  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && status === 404) {
    return true;
  }

  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && name === "NotFoundError") {
    return true;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && (code === "not_found" || code === "not_found_error");
}

async function runRemoteCall<T>(input: {
  context?: Record<string, unknown>;
  logger: Logger | undefined;
  operation: string;
  promise: PromiseLike<T>;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<RemoteCallResult<T>> {
  if (input.signal.aborted) {
    return {
      error: remoteCallError(`${input.operation} aborted`),
      ok: false,
      reason: "aborted",
    };
  }

  const timeoutMs = input.timeoutMs ?? REAPER_REMOTE_CALL_TIMEOUT_MS;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  try {
    const outcome = await Promise.race([
      Promise.resolve(input.promise).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ error, ok: false as const, reason: "error" as const }),
      ),
      new Promise<RemoteCallResult<T>>((resolve) => {
        timeoutHandle = setTimeout(() => {
          resolve({
            error: remoteCallError(`${input.operation} timed out after ${timeoutMs}ms`),
            ok: false,
            reason: "timeout",
          });
        }, timeoutMs);
      }),
      new Promise<RemoteCallResult<T>>((resolve) => {
        abortListener = () => {
          resolve({
            error: remoteCallError(`${input.operation} aborted`),
            ok: false,
            reason: "aborted",
          });
        };
        input.signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);

    if (!outcome.ok && outcome.reason === "timeout") {
      input.logger?.warn(
        { ...(input.context ?? {}), operation: input.operation, timeoutMs },
        "stale run reaper remote call timed out",
      );
    }

    return outcome;
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    if (abortListener !== undefined) {
      input.signal.removeEventListener("abort", abortListener);
    }
  }
}

async function readSessionEventsTail(
  client: StaleRunReaperSessionClient,
  sessionId: string,
  limit: number,
  logger: Logger | undefined,
  signal: AbortSignal,
): Promise<BetaManagedAgentsSessionEvent[]> {
  const events: BetaManagedAgentsSessionEvent[] = [];
  const iterator = client.beta.sessions.events
    .list(sessionId, { limit, order: "desc" })
    [Symbol.asyncIterator]();

  try {
    while (true) {
      const nextResult = await runRemoteCall({
        context: { sessionId },
        logger,
        operation: "sessions.events.list",
        promise: iterator.next(),
        signal,
      });

      if (!nextResult.ok) {
        throw nextResult.error;
      }

      if (nextResult.value.done) {
        break;
      }

      events.push(nextResult.value.value);
    }
  } finally {
    if (iterator.return !== undefined) {
      await iterator.return();
    }
  }

  return events;
}

function analyzeRequiresActionStaleness(input: {
  events: BetaManagedAgentsSessionEvent[];
  nowMs: number;
  requiresActionStaleMs: number;
  sessionId: string;
}): StaleRequiresActionSession | null {
  const latestStatus = input.events.find((event) => isSessionStatusEvent(event));
  if (latestStatus?.type !== "session.status_idle") {
    return null;
  }

  if (latestStatus.stop_reason.type !== "requires_action") {
    return null;
  }

  const processedAtMs = processedAtMillis(latestStatus);
  const processedAt = processedAtString(latestStatus);
  if (processedAtMs === null || processedAt === null) {
    return null;
  }

  const staleForMs = input.nowMs - processedAtMs;
  if (staleForMs < input.requiresActionStaleMs) {
    return null;
  }

  const eventIds = latestStatus.stop_reason.event_ids.filter((eventId) => eventId.length > 0);
  const wantedEventIds = new Set(eventIds);
  const customToolUses = new Map<string, BetaManagedAgentsAgentCustomToolUseEvent>();
  const resolvedToolUseIds = new Set<string>();

  for (const event of input.events) {
    if (isAgentCustomToolUseEvent(event) && wantedEventIds.has(event.id)) {
      customToolUses.set(event.id, event);
    }
    if (isUserCustomToolResultEvent(event)) {
      resolvedToolUseIds.add(event.custom_tool_use_id);
    }
  }

  const pendingToolUses: BetaManagedAgentsAgentCustomToolUseEvent[] = [];
  const unresolvedEventIds: string[] = [];
  for (const eventId of eventIds) {
    if (resolvedToolUseIds.has(eventId)) {
      continue;
    }

    unresolvedEventIds.push(eventId);
    const toolUse = customToolUses.get(eventId);
    if (toolUse !== undefined) {
      pendingToolUses.push(toolUse);
    }
  }

  if (unresolvedEventIds.length === 0) {
    return null;
  }

  return {
    eventIds,
    idleEventId: latestStatus.id,
    pendingToolUses,
    processedAt,
    sessionId: input.sessionId,
    staleForMs,
    unresolvedEventIds,
  };
}

function staleRequiresActionErrorPayload(input: {
  runId: string;
  staleSession: StaleRequiresActionSession;
  staleThresholdMs: number;
}): Record<string, unknown> {
  return {
    eventIds: input.staleSession.eventIds,
    idleEventId: input.staleSession.idleEventId,
    message:
      "Run was left running while the Managed Agents session was stale in requires_action; reaper marked it failed.",
    pendingCustomToolUseIds: input.staleSession.pendingToolUses.map((toolUse) => toolUse.id),
    processedAt: input.staleSession.processedAt,
    runId: input.runId,
    sessionId: input.staleSession.sessionId,
    staleForMs: input.staleSession.staleForMs,
    staleThresholdMs: input.staleThresholdMs,
    type: STALE_REQUIRES_ACTION_ERROR_TYPE,
    unresolvedEventIds: input.staleSession.unresolvedEventIds,
  };
}

export async function interruptAndDeleteSession(input: {
  client: StaleRunReaperSessionClient;
  logger: Logger | undefined;
  runId: string;
  sessionId: string;
  signal: AbortSignal;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<InterruptAndDeleteSessionResult> {
  const interruptResult = await runRemoteCall({
    context: { runId: input.runId, sessionId: input.sessionId },
    logger: input.logger,
    operation: "sessions.events.send:user.interrupt",
    promise: input.client.beta.sessions.events.send(input.sessionId, {
      events: [{ type: "user.interrupt" }],
    }),
    signal: input.signal,
  });

  if (!interruptResult.ok) {
    if (isAnthropicNotFoundError(interruptResult.error)) {
      input.logger?.debug(
        { runId: input.runId, sessionId: input.sessionId },
        "stale session not found during interrupt; continuing to delete",
      );
    } else {
      if (interruptResult.reason === "aborted") {
        return { error: interruptResult.error, ok: false, stage: "interrupt" };
      }
      input.logger?.warn(
        {
          err: interruptResult.error,
          reason: interruptResult.reason,
          runId: input.runId,
          sessionId: input.sessionId,
        },
        "failed to interrupt stale session before delete; continuing to delete",
      );
    }
  }

  let lastDeleteError: unknown = remoteCallError("stale session delete did not run");
  for (let attempt = 1; attempt <= DELETE_SESSION_MAX_ATTEMPTS; attempt += 1) {
    const deleteResult = await runRemoteCall({
      context: { attempt, runId: input.runId, sessionId: input.sessionId },
      logger: input.logger,
      operation: "sessions.delete",
      promise: input.client.beta.sessions.delete(input.sessionId),
      signal: input.signal,
    });

    if (deleteResult.ok) {
      return { ok: true };
    }

    if (isAnthropicNotFoundError(deleteResult.error)) {
      input.logger?.debug(
        { attempt, runId: input.runId, sessionId: input.sessionId },
        "stale session already deleted",
      );
      return { ok: true };
    }

    lastDeleteError = deleteResult.error;
    input.logger?.warn(
      {
        attempt,
        err: deleteResult.error,
        maxAttempts: DELETE_SESSION_MAX_ATTEMPTS,
        reason: deleteResult.reason,
        runId: input.runId,
        sessionId: input.sessionId,
      },
      "failed to delete stale session",
    );

    if (deleteResult.reason === "aborted") {
      return { error: deleteResult.error, ok: false, stage: "delete" };
    }

    if (attempt < DELETE_SESSION_MAX_ATTEMPTS) {
      await input.sleep(DELETE_SESSION_RETRY_DELAY_MS, input.signal);
      if (input.signal.aborted) {
        return {
          error: remoteCallError("sessions.delete retry aborted"),
          ok: false,
          stage: "delete",
        };
      }
    }
  }

  return { error: lastDeleteError, ok: false, stage: "delete" };
}

function safeEmit(
  deps: Pick<StaleRunReaperDeps, "logger" | "runEvents">,
  runId: string,
  event: Parameters<StaleRunReaperRunEvents["emit"]>[1],
): void {
  try {
    deps.runEvents.emit(runId, event);
  } catch (err) {
    deps.logger?.warn({ err, kind: event.kind, runId }, "failed to emit stale run reaper event");
  }
}

function emitStaleRunDetected(
  deps: Pick<StaleRunReaperDeps, "logger" | "runEvents">,
  runId: string,
  staleSession: StaleRequiresActionSession,
): void {
  safeEmit(deps, runId, {
    kind: "log",
    payload: {
      fields: {
        component: REAPER_COMPONENT,
        idleEventId: staleSession.idleEventId,
        sessionId: staleSession.sessionId,
        staleForMs: staleSession.staleForMs,
        unresolvedEventIds: staleSession.unresolvedEventIds,
      },
      level: "warn",
      msg: "stale requires_action run detected",
    },
  });
}

function terminalizeFailedRun(input: {
  config: StaleRunReaperConfig;
  db: StaleRunReaperDb;
  deps: Pick<StaleRunReaperDeps, "logger" | "runEvents">;
  runId: string;
  staleSession: StaleRequiresActionSession;
}): boolean {
  const errorPayload = staleRequiresActionErrorPayload({
    runId: input.runId,
    staleSession: input.staleSession,
    staleThresholdMs: input.config.requiresActionStaleMs,
  });

  const terminalized = input.db.setRunStatusIfCurrent(input.runId, "failed", ["running"]);
  if (!terminalized) {
    input.deps.logger?.warn(
      { runId: input.runId, sessionId: input.staleSession.sessionId },
      "stale run was no longer running after session delete; skipping terminal events",
    );
    return false;
  }

  safeEmit(input.deps, input.runId, { kind: "error", payload: errorPayload });
  safeEmit(input.deps, input.runId, {
    kind: "phase",
    payload: { phase: "failed", reason: STALE_REQUIRES_ACTION_ERROR_TYPE },
  });
  safeEmit(input.deps, input.runId, {
    kind: "complete",
    payload: {
      aborted: false,
      error: errorPayload,
      errored: errorPayload,
      status: "failed",
      timedOut: false,
    },
  });
  return true;
}

function terminalizeStartupOrphanRun(input: {
  db: StaleRunReaperDb;
  deps: Pick<StaleRunReaperDeps, "logger" | "runEvents">;
  reason: string;
  runId: string;
}): boolean {
  const terminalized = input.db.setRunStatusIfCurrent(input.runId, "aborted", ["running"]);
  if (!terminalized) {
    input.deps.logger?.warn(
      { reason: input.reason, runId: input.runId },
      "startup orphan run was no longer running; skipping abort events",
    );
    return false;
  }

  safeEmit(input.deps, input.runId, { kind: "phase", payload: { phase: "aborted" } });
  safeEmit(input.deps, input.runId, {
    kind: "complete",
    payload: {
      aborted: true,
      status: "aborted",
      timedOut: false,
    },
  });
  input.deps.logger?.warn(
    { reason: input.reason, runId: input.runId },
    "aborted startup orphan run not recoverable as stale requires_action",
  );
  return true;
}

export function createStaleRunReaper(deps: StaleRunReaperDeps): StaleRunReaper {
  const config = StaleRunReaperConfigSchema.parse(deps.config ?? {});
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());

  let started = false;
  let abortController: AbortController | undefined;
  let loopPromise: Promise<void> | undefined;
  let scanInFlight: Promise<StaleRunReaperSummary> | undefined;
  const manualReapSignal = new AbortController().signal;

  function currentSignal(): AbortSignal {
    return abortController?.signal ?? manualReapSignal;
  }

  function snapshotRunningCandidates(): StaleRunReaperCandidate[] {
    if (!config.enabled) {
      return [];
    }

    const candidates: StaleRunReaperCandidate[] = [];
    for (const runSummary of deps.db.listRuns({ limit: config.scanLimit, status: "running" })) {
      const run = deps.db.getRunById(runSummary.runId);
      if (run === null || run.sessionIds.length === 0) {
        continue;
      }

      candidates.push({ runId: run.runId, sessionIds: [...run.sessionIds] });
    }

    return candidates;
  }

  async function findStaleRequiresActionSession(
    sessionIds: readonly string[],
    signal: AbortSignal,
  ): Promise<StaleRequiresActionSession | null> {
    const nowMs = now().getTime();

    for (const sessionId of sessionIds) {
      const events = await readSessionEventsTail(
        deps.anthropicClient,
        sessionId,
        config.sessionEventLimit,
        deps.logger,
        signal,
      );
      const staleSession = analyzeRequiresActionStaleness({
        events,
        nowMs,
        requiresActionStaleMs: config.requiresActionStaleMs,
        sessionId,
      });
      if (staleSession !== null) {
        return staleSession;
      }
    }

    return null;
  }

  async function recoverStaleRun(
    runId: string,
    staleSession: StaleRequiresActionSession,
    signal: AbortSignal,
  ): Promise<"cancelled" | "deferred" | "recovered" | "skipped"> {
    emitStaleRunDetected(deps, runId, staleSession);

    if (deps.cancelRun !== undefined) {
      const cancelResult = await deps.cancelRun(runId);
      if (cancelResult === "cancelled") {
        deps.logger?.warn(
          { runId, sessionId: staleSession.sessionId, staleForMs: staleSession.staleForMs },
          "cancelled active stale requires_action run",
        );
        return "cancelled";
      }
      if (cancelResult === "timed_out") {
        deps.logger?.warn(
          { runId, sessionId: staleSession.sessionId, staleForMs: staleSession.staleForMs },
          "active stale requires_action run did not stop before cancel timeout; deferring recovery",
        );
        return "skipped";
      }
    }

    if (deps.db.getRunStatus(runId) !== "running") {
      return "skipped";
    }

    const deleteResult = await interruptAndDeleteSession({
      client: deps.anthropicClient,
      logger: deps.logger,
      runId,
      sessionId: staleSession.sessionId,
      signal,
      sleep,
    });
    if (!deleteResult.ok) {
      deps.logger?.warn(
        {
          err: deleteResult.error,
          runId,
          sessionId: staleSession.sessionId,
          stage: deleteResult.stage,
          staleForMs: staleSession.staleForMs,
        },
        "stale session delete did not complete; deferring run terminalization",
      );
      return "deferred";
    }

    if (!terminalizeFailedRun({ config, db: deps.db, deps, runId, staleSession })) {
      return "skipped";
    }

    deps.logger?.warn(
      { runId, sessionId: staleSession.sessionId, staleForMs: staleSession.staleForMs },
      "recovered stale requires_action run",
    );
    return "recovered";
  }

  async function processCandidate(
    candidate: StaleRunReaperCandidate,
    mode: StaleRunReaperMode,
    summary: StaleRunReaperSummary,
    signal: AbortSignal,
  ): Promise<void> {
    if (candidate.sessionIds.length === 0) {
      if (mode === "startup") {
        terminalizeStartupOrphanRun({
          db: deps.db,
          deps,
          reason: "no_session_id",
          runId: candidate.runId,
        });
      }
      summary.skipped += 1;
      return;
    }

    let staleSession: StaleRequiresActionSession | null;
    try {
      staleSession = await findStaleRequiresActionSession(candidate.sessionIds, signal);
    } catch (err) {
      if (mode === "startup") {
        deps.logger?.warn(
          { err, runId: candidate.runId },
          "failed to inspect startup candidate session events; aborting orphan run",
        );
        terminalizeStartupOrphanRun({
          db: deps.db,
          deps,
          reason: "session_events_unavailable",
          runId: candidate.runId,
        });
        summary.skipped += 1;
        return;
      }

      throw err;
    }

    if (staleSession === null) {
      if (mode === "startup") {
        terminalizeStartupOrphanRun({
          db: deps.db,
          deps,
          reason: "not_stale_requires_action",
          runId: candidate.runId,
        });
        summary.skipped += 1;
      }
      return;
    }

    summary.staleRequiresAction += 1;
    const outcome = await recoverStaleRun(candidate.runId, staleSession, signal);
    if (outcome === "cancelled") {
      summary.cancelled += 1;
    } else if (outcome === "recovered") {
      summary.recovered += 1;
    } else {
      summary.skipped += 1;
    }
  }

  async function runReapOnce(
    opts: { candidates?: readonly StaleRunReaperCandidate[]; mode?: StaleRunReaperMode },
    signal: AbortSignal,
  ): Promise<StaleRunReaperSummary> {
    const summary: StaleRunReaperSummary = {
      cancelled: 0,
      errors: 0,
      recovered: 0,
      scanned: 0,
      skipped: 0,
      staleRequiresAction: 0,
    };
    if (!config.enabled) {
      return summary;
    }

    const mode: StaleRunReaperMode =
      opts.mode ?? (opts.candidates === undefined ? "live" : "startup");

    if (opts.candidates !== undefined) {
      summary.scanned = opts.candidates.length;
      for (const candidate of opts.candidates) {
        try {
          await processCandidate(candidate, mode, summary, signal);
        } catch (err) {
          summary.errors += 1;
          deps.logger?.warn(
            { err, runId: candidate.runId },
            "stale requires_action run reaper failed for run",
          );
        }
      }

      return summary;
    }

    const runningRuns = deps.db.listRuns({ limit: config.scanLimit, status: "running" });
    summary.scanned = runningRuns.length;

    for (const runSummary of runningRuns) {
      try {
        const run = deps.db.getRunById(runSummary.runId);
        if (run === null || run.sessionIds.length === 0) {
          summary.skipped += 1;
          continue;
        }

        await processCandidate(
          { runId: run.runId, sessionIds: run.sessionIds },
          mode,
          summary,
          signal,
        );
      } catch (err) {
        summary.errors += 1;
        deps.logger?.warn(
          { err, runId: runSummary.runId },
          "stale requires_action run reaper failed for run",
        );
      }
    }

    return summary;
  }

  function reapOnce(
    opts: { candidates?: readonly StaleRunReaperCandidate[]; mode?: StaleRunReaperMode } = {},
  ): Promise<StaleRunReaperSummary> {
    if (scanInFlight !== undefined) {
      return scanInFlight;
    }

    const promise = runReapOnce(opts, currentSignal());
    scanInFlight = promise;
    const clearInFlight = () => {
      if (scanInFlight === promise) {
        scanInFlight = undefined;
      }
    };
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  }

  async function loop(
    signal: AbortSignal,
    startupCandidates: readonly StaleRunReaperCandidate[],
  ): Promise<void> {
    let pendingStartupCandidates: readonly StaleRunReaperCandidate[] | undefined =
      startupCandidates.length > 0 ? startupCandidates : undefined;

    while (started && !signal.aborted) {
      try {
        const candidatesForCycle = pendingStartupCandidates;
        pendingStartupCandidates = undefined;
        const summary =
          candidatesForCycle === undefined
            ? await reapOnce()
            : await reapOnce({ candidates: candidatesForCycle });
        if (summary.staleRequiresAction > 0 || summary.errors > 0) {
          deps.logger?.info({ summary }, "stale run reaper cycle completed");
        }
      } catch (err) {
        deps.logger?.error({ err }, "stale run reaper cycle threw");
      }

      if (!started || signal.aborted) {
        return;
      }

      await sleep(config.intervalMs, signal);
    }
  }

  function start(opts: { startupCandidates?: readonly StaleRunReaperCandidate[] } = {}): void {
    if (started || !config.enabled) {
      return;
    }

    const startupCandidates = (opts.startupCandidates ?? []).filter(
      (candidate) => candidate.sessionIds.length > 0,
    );
    started = true;
    abortController = new AbortController();
    deps.logger?.info(
      {
        intervalMs: config.intervalMs,
        requiresActionStaleMs: config.requiresActionStaleMs,
        startupCandidateCount: startupCandidates.length,
      },
      "stale run reaper started",
    );
    loopPromise = loop(abortController.signal, startupCandidates).catch((err) => {
      deps.logger?.error({ err }, "stale run reaper loop crashed");
    });
  }

  async function stop(): Promise<void> {
    if (!started) {
      return;
    }

    started = false;
    abortController?.abort();
    if (loopPromise !== undefined) {
      await loopPromise;
      loopPromise = undefined;
    }
    abortController = undefined;
    deps.logger?.info("stale run reaper stopped");
  }

  return {
    reapOnce,
    snapshotRunningCandidates,
    start,
    stop,
  };
}
