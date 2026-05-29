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
  "getRunById" | "listRuns" | "setRunStatus"
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

export type StaleRunReaper = {
  reapOnce(): Promise<StaleRunReaperSummary>;
  start(): void;
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
  { type: "session.status_idle" | "session.status_running" }
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
  return event.type === "session.status_idle" || event.type === "session.status_running";
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

async function readSessionEventsTail(
  client: StaleRunReaperSessionClient,
  sessionId: string,
  limit: number,
): Promise<BetaManagedAgentsSessionEvent[]> {
  const events: BetaManagedAgentsSessionEvent[] = [];
  for await (const event of client.beta.sessions.events.list(sessionId, { limit, order: "desc" })) {
    events.push(event);
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

function buildStaleToolResultParams(input: {
  runId: string;
  staleSession: StaleRequiresActionSession;
  toolUse: BetaManagedAgentsAgentCustomToolUseEvent;
}): EventSendParams {
  const payload = {
    error: {
      message:
        "This custom tool request was stale in requires_action and the run was reaped by the server.",
      runId: input.runId,
      sessionId: input.staleSession.sessionId,
      staleForMs: input.staleSession.staleForMs,
      type: STALE_REQUIRES_ACTION_ERROR_TYPE,
    },
  };
  const sessionThreadId = input.toolUse.session_thread_id;

  return {
    events: [
      {
        content: [{ text: JSON.stringify(payload), type: "text" }],
        custom_tool_use_id: input.toolUse.id,
        is_error: true,
        ...(sessionThreadId ? { session_thread_id: sessionThreadId } : {}),
        type: "user.custom_tool_result",
      },
    ],
  };
}

async function sendStaleToolResults(input: {
  client: StaleRunReaperSessionClient;
  logger: Logger | undefined;
  runId: string;
  staleSession: StaleRequiresActionSession;
}): Promise<void> {
  for (const toolUse of input.staleSession.pendingToolUses) {
    try {
      await input.client.beta.sessions.events.send(
        input.staleSession.sessionId,
        buildStaleToolResultParams({
          runId: input.runId,
          staleSession: input.staleSession,
          toolUse,
        }),
      );
    } catch (err) {
      input.logger?.warn(
        { err, runId: input.runId, sessionId: input.staleSession.sessionId, toolUseId: toolUse.id },
        "failed to send stale requires_action tool result",
      );
    }
  }
}

async function interruptAndDeleteSession(input: {
  client: StaleRunReaperSessionClient;
  logger: Logger | undefined;
  runId: string;
  sessionId: string;
}): Promise<void> {
  try {
    await input.client.beta.sessions.events.send(input.sessionId, {
      events: [{ type: "user.interrupt" }],
    });
  } catch (err) {
    input.logger?.warn(
      { err, runId: input.runId, sessionId: input.sessionId },
      "failed to interrupt stale session before delete",
    );
  }

  try {
    await input.client.beta.sessions.delete(input.sessionId);
  } catch (err) {
    input.logger?.warn(
      { err, runId: input.runId, sessionId: input.sessionId },
      "failed to delete stale session",
    );
  }
}

function isRunStillRunning(db: StaleRunReaperDb, runId: string, scanLimit: number): boolean {
  return db.listRuns({ limit: scanLimit, status: "running" }).some((run) => run.runId === runId);
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
}): void {
  const errorPayload = staleRequiresActionErrorPayload({
    runId: input.runId,
    staleSession: input.staleSession,
    staleThresholdMs: input.config.requiresActionStaleMs,
  });

  input.db.setRunStatus(input.runId, "failed");
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
}

export function createStaleRunReaper(deps: StaleRunReaperDeps): StaleRunReaper {
  const config = StaleRunReaperConfigSchema.parse(deps.config ?? {});
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());

  let started = false;
  let abortController: AbortController | undefined;
  let loopPromise: Promise<void> | undefined;

  async function findStaleRequiresActionSession(
    sessionIds: readonly string[],
  ): Promise<StaleRequiresActionSession | null> {
    const nowMs = now().getTime();

    for (const sessionId of sessionIds) {
      const events = await readSessionEventsTail(
        deps.anthropicClient,
        sessionId,
        config.sessionEventLimit,
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
  ): Promise<"cancelled" | "recovered" | "skipped"> {
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

    if (!isRunStillRunning(deps.db, runId, config.scanLimit)) {
      return "skipped";
    }

    await sendStaleToolResults({
      client: deps.anthropicClient,
      logger: deps.logger,
      runId,
      staleSession,
    });
    await interruptAndDeleteSession({
      client: deps.anthropicClient,
      logger: deps.logger,
      runId,
      sessionId: staleSession.sessionId,
    });

    if (!isRunStillRunning(deps.db, runId, config.scanLimit)) {
      return "skipped";
    }

    terminalizeFailedRun({ config, db: deps.db, deps, runId, staleSession });
    deps.logger?.warn(
      { runId, sessionId: staleSession.sessionId, staleForMs: staleSession.staleForMs },
      "recovered stale requires_action run",
    );
    return "recovered";
  }

  async function reapOnce(): Promise<StaleRunReaperSummary> {
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

    const runningRuns = deps.db.listRuns({ limit: config.scanLimit, status: "running" });
    summary.scanned = runningRuns.length;

    for (const runSummary of runningRuns) {
      try {
        const run = deps.db.getRunById(runSummary.runId);
        if (run === null || run.sessionIds.length === 0) {
          summary.skipped += 1;
          continue;
        }

        const staleSession = await findStaleRequiresActionSession(run.sessionIds);
        if (staleSession === null) {
          continue;
        }

        summary.staleRequiresAction += 1;
        const outcome = await recoverStaleRun(run.runId, staleSession);
        if (outcome === "cancelled") {
          summary.cancelled += 1;
        } else if (outcome === "recovered") {
          summary.recovered += 1;
        } else {
          summary.skipped += 1;
        }
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

  async function loop(signal: AbortSignal): Promise<void> {
    while (started && !signal.aborted) {
      try {
        const summary = await reapOnce();
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

  function start(): void {
    if (started || !config.enabled) {
      return;
    }

    started = true;
    abortController = new AbortController();
    deps.logger?.info(
      {
        intervalMs: config.intervalMs,
        requiresActionStaleMs: config.requiresActionStaleMs,
      },
      "stale run reaper started",
    );
    loopPromise = loop(abortController.signal).catch((err) => {
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
    deps.logger?.info("stale run reaper stopped");
  }

  return {
    reapOnce,
    start,
    stop,
  };
}
