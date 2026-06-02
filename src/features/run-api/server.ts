import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
  EventListParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Logger } from "pino";

import {
  type RunDetailOutput,
  RunListQuerySchema,
  RunStartInputSchema,
  RunStopInputSchema,
  type RunSummaryOutput,
} from "@/features/run-api/schemas";
import { createDynamicMerger, formatSseEvent, withHeartbeat } from "@/features/run-api/sse";
import { type createRunQueueModule, RunTargetResolutionError } from "@/features/run-queue/handler";
import type { createDbModule } from "@/shared/persistence/db";
import type { createRunEventsModule } from "@/shared/run-events";
import {
  LIVE_TAIL_HEARTBEAT_INTERVAL_MS,
  LIVE_TAIL_HISTORY_PAGE_SIZE,
} from "@/shared/run-events/constants";
import type { SessionClient } from "@/shared/session";
import type { RunEvent, RunStatus } from "@/shared/types";

export type RunApiDeps = {
  db: Pick<ReturnType<typeof createDbModule>, "getRunById" | "getSessionsByRun" | "listRuns">;
  logger: Logger;
  runEvents: Pick<ReturnType<typeof createRunEventsModule>, "emit" | "subscribe">;
  runQueue: Pick<ReturnType<typeof createRunQueueModule>, "cancel" | "enqueue" | "getStatus">;
  anthropicClient?: SessionClient;
  sseHeartbeatIntervalMs?: number;
};

const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["aborted", "completed", "failed"]);
const KEEPALIVE_COMMENT = ": keepalive\n\n";
const ABORTED_ITERATION = Symbol("ABORTED_ITERATION");

type SessionEvent = BetaManagedAgentsSessionEvent | BetaManagedAgentsStreamSessionEvents;
type SessionSseEvent = {
  kind: "session";
  payload: {
    event: SessionEvent;
    sessionId: string;
  };
};
type MergedRunEvent = RunEvent | SessionSseEvent;
type RequestOptions = { signal?: AbortSignal };
type AbortableSessionEventsClient = {
  list(
    sessionId: string,
    params?: EventListParams,
    options?: RequestOptions,
  ): AsyncIterable<BetaManagedAgentsSessionEvent>;
  stream(
    sessionId: string,
    options?: RequestOptions,
  ): PromiseLike<AsyncIterable<BetaManagedAgentsStreamSessionEvents>>;
};

function schemaError(issues: unknown[]) {
  return {
    error: {
      issues,
      message: "invalid request body",
      type: "schema",
    },
  };
}

async function parseOptionalJsonBody(
  request: Request,
): Promise<{ body: unknown } | { issues: unknown[] }> {
  try {
    const rawBody = await request.text();
    return { body: rawBody.trim() === "" ? {} : JSON.parse(rawBody) };
  } catch {
    return {
      issues: [{ code: "invalid_json", message: "invalid JSON body", path: [] }],
    };
  }
}

function isRunEvent(event: MergedRunEvent): event is RunEvent {
  return "id" in event && "runId" in event && "ts" in event;
}

function sessionEventId(event: SessionSseEvent): string {
  return `s:${event.payload.sessionId}:${event.payload.event.id}`;
}

type SessionLifecycleCreated = RunEvent & {
  kind: "session";
  payload: { kind: "created"; sessionId: string };
};

function isSessionCreatedRunEvent(event: MergedRunEvent): event is SessionLifecycleCreated {
  if (!isRunEvent(event) || event.kind !== "session") {
    return false;
  }
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as { kind?: unknown; sessionId?: unknown };
  return candidate.kind === "created" && typeof candidate.sessionId === "string";
}

function createAbortController(requestSignal: AbortSignal): {
  abort: () => void;
  cleanup: () => void;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  if (requestSignal.aborted) {
    abort();
  } else {
    requestSignal.addEventListener("abort", abort, { once: true });
  }

  return {
    abort,
    cleanup() {
      requestSignal.removeEventListener("abort", abort);
    },
    signal: controller.signal,
  };
}

async function nextWithAbort<TEvent>(
  iterator: AsyncIterator<TEvent>,
  signal: AbortSignal,
): Promise<IteratorResult<TEvent> | typeof ABORTED_ITERATION> {
  if (signal.aborted) {
    return ABORTED_ITERATION;
  }

  let abortListener: (() => void) | undefined;

  try {
    return await Promise.race([
      iterator.next(),
      new Promise<typeof ABORTED_ITERATION>((resolve) => {
        abortListener = () => resolve(ABORTED_ITERATION);
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function promiseWithAbort<TValue>(
  promiseLike: PromiseLike<TValue>,
  signal: AbortSignal,
): Promise<TValue | typeof ABORTED_ITERATION> {
  if (signal.aborted) {
    return ABORTED_ITERATION;
  }

  let abortListener: (() => void) | undefined;

  try {
    return await Promise.race([
      Promise.resolve(promiseLike),
      new Promise<typeof ABORTED_ITERATION>((resolve) => {
        abortListener = () => resolve(ABORTED_ITERATION);
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function* iterateAbortably<TEvent>(
  iterable: AsyncIterable<TEvent>,
  signal: AbortSignal,
): AsyncIterable<TEvent> {
  const iterator = iterable[Symbol.asyncIterator]();

  try {
    while (!signal.aborted) {
      const result = await nextWithAbort(iterator, signal);
      if (result === ABORTED_ITERATION || result.done === true) {
        return;
      }

      yield result.value;
    }
  } finally {
    await iterator.return?.();
  }
}

async function* createSessionEventsIterable(options: {
  client: SessionClient;
  logger: Logger;
  sessionId: string;
  signal: AbortSignal;
}): AsyncIterable<SessionSseEvent> {
  const eventsClient = options.client.beta.sessions.events as AbortableSessionEventsClient;
  const seenEventIds = new Set<string>();

  try {
    for await (const historyEvent of iterateAbortably(
      eventsClient.list(
        options.sessionId,
        { limit: LIVE_TAIL_HISTORY_PAGE_SIZE, order: "asc" },
        { signal: options.signal },
      ),
      options.signal,
    )) {
      seenEventIds.add(historyEvent.id);
      yield { kind: "session", payload: { event: historyEvent, sessionId: options.sessionId } };
    }

    if (options.signal.aborted) {
      return;
    }

    const liveStream = await promiseWithAbort(
      eventsClient.stream(options.sessionId, { signal: options.signal }),
      options.signal,
    );
    if (liveStream === ABORTED_ITERATION || options.signal.aborted) {
      return;
    }

    for await (const liveEvent of iterateAbortably(liveStream, options.signal)) {
      if (seenEventIds.has(liveEvent.id)) {
        continue;
      }

      seenEventIds.add(liveEvent.id);
      yield { kind: "session", payload: { event: liveEvent, sessionId: options.sessionId } };

      // NOTE: 以前は `session.status_idle` で stream を閉じていたが、idle 中も親→子→親の
      // 流れでメッセージが続くケース (この親 session は child session 完了後に再びアクティブ化) で
      // ライブログが途切れる原因になっていたため、abort されるまで stream を継続させる。
    }
  } catch (error) {
    if (!options.signal.aborted) {
      options.logger.warn(
        { err: error, sessionId: options.sessionId },
        "run api session events stream failed",
      );
    }
  }
}

function toSseEvent(event: MergedRunEvent): { data: unknown; event: string; id: string } {
  if (isRunEvent(event)) {
    return { data: event.payload, event: event.kind, id: event.id };
  }

  return { data: event.payload, event: "session", id: sessionEventId(event) };
}

export function createRunApiRoutes(deps: RunApiDeps): Hono {
  const app = new Hono();

  app.post("/api/runs", async (c) => {
    c.header("Cache-Control", "no-store");

    const bodyResult = await parseOptionalJsonBody(c.req.raw);
    if ("issues" in bodyResult) {
      return c.json(schemaError(bodyResult.issues), 400);
    }

    const parsedInput = RunStartInputSchema.safeParse(bodyResult.body ?? {});
    if (!parsedInput.success) {
      return c.json(schemaError(parsedInput.error.issues), 400);
    }

    let queued: { position: number; runId: string };
    try {
      queued = deps.runQueue.enqueue(parsedInput.data);
    } catch (error) {
      if (!(error instanceof RunTargetResolutionError)) {
        deps.logger.error({ err: error }, "failed to enqueue run");
        return c.json(
          {
            error: {
              message: "failed to enqueue run",
              type: "server_error",
            },
          },
          500,
        );
      }

      return c.json(
        {
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "run_target_resolution",
          },
        },
        400,
      );
    }

    return c.json({ position: queued.position, runId: queued.runId, status: "queued" }, 200);
  });

  app.post("/api/runs/:runId/stop", async (c) => {
    c.header("Cache-Control", "no-store");

    const bodyResult = await parseOptionalJsonBody(c.req.raw);
    if ("issues" in bodyResult) {
      return c.json(schemaError(bodyResult.issues), 400);
    }

    const parsedInput = RunStopInputSchema.safeParse(bodyResult.body ?? {});
    if (!parsedInput.success) {
      return c.json(schemaError(parsedInput.error.issues), 400);
    }

    const runId = c.req.param("runId");
    const run = deps.db.listRuns({ limit: 10_000 }).find((summary) => summary.runId === runId);
    if (run === undefined) {
      return c.json({ error: { message: "run not found", runId, type: "not_found" } }, 404);
    }

    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return c.json(
        {
          error: {
            message: "run is already terminal",
            runId,
            status: run.status,
            type: "already_terminal",
          },
        },
        409,
      );
    }

    const stopped = await deps.runQueue.cancel(runId);
    if (!stopped) {
      return c.json(
        { error: { message: "run cancellation timed out", runId, type: "cancel_timeout" } },
        504,
      );
    }

    return c.json({ runId, stopped: true }, 200);
  });

  app.get("/api/runs", (c) => {
    c.header("Cache-Control", "no-store");

    const parsedQuery = RunListQuerySchema.safeParse(c.req.query());
    if (!parsedQuery.success) {
      return c.json(schemaError(parsedQuery.error.issues), 400);
    }

    const query = parsedQuery.data;
    const summaries = deps.db.listRuns({
      limit: query.limit,
      repo: query.repo,
      status: query.status,
    });
    const runs: RunSummaryOutput["runs"] = summaries.map((summary) => {
      const run = deps.db.getRunById(summary.runId);
      return run?.repositories === undefined
        ? summary
        : { ...summary, repositories: run.repositories };
    });
    const payload: RunSummaryOutput = { runs, total: runs.length };

    return c.json(payload, 200);
  });

  app.get("/api/runs/:runId/events", async (c) => {
    const runId = c.req.param("runId");
    const run = deps.db.getRunById(runId);
    if (run == null) {
      c.header("Cache-Control", "no-store");
      return c.json({ error: { message: "run not found", runId, type: "not_found" } }, 404);
    }

    c.header("Cache-Control", "no-cache, no-store");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    const fromEventId = c.req.header("Last-Event-ID");
    const abortController = createAbortController(c.req.raw.signal);
    const heartbeatIntervalMs = deps.sseHeartbeatIntervalMs ?? LIVE_TAIL_HEARTBEAT_INTERVAL_MS;

    return streamSSE(c, async (stream) => {
      stream.onAbort(abortController.abort);

      try {
        const merger = createDynamicMerger<MergedRunEvent>({
          logger: deps.logger,
          signal: abortController.signal,
        });
        const knownSessionIds = new Set<string>();

        const addSessionStream = (sessionId: string): void => {
          const client = deps.anthropicClient;
          if (client === undefined) {
            return;
          }
          if (knownSessionIds.has(sessionId)) {
            return;
          }
          knownSessionIds.add(sessionId);
          merger.addStream(
            createSessionEventsIterable({
              client,
              logger: deps.logger,
              sessionId,
              signal: abortController.signal,
            }),
            `session:${sessionId}`,
          );
        };

        // 接続時点で run に登録済みの session を最初に購読
        for (const sessionId of run.sessionIds) {
          addSessionStream(sessionId);
        }

        // run-events を購読しつつ、session.created を検出したら新しい session events
        // stream を動的に merger に追加する。これにより接続後に spawn された child session の
        // ライブログも追跡できる。
        const subscription = deps.runEvents.subscribe(runId, {
          fromEventId,
          signal: abortController.signal,
        });
        // for-await ではなく iterator を直接保持し、merger 経由の cleanup で subscription
        // 自身の `return()` が確実に呼ばれるようにする (Hono streamSSE の onAbort と
        // run-events の signal 連動のための保険)。
        const wrappedRunEvents: AsyncIterable<MergedRunEvent> = {
          async *[Symbol.asyncIterator]() {
            const iterator = subscription[Symbol.asyncIterator]();
            try {
              while (true) {
                const result = await iterator.next();
                if (result.done === true) {
                  return;
                }
                yield result.value;
                if (isSessionCreatedRunEvent(result.value)) {
                  addSessionStream(result.value.payload.sessionId);
                }
              }
            } finally {
              await iterator.return?.();
            }
          },
        };
        merger.addStream(wrappedRunEvents, "run-events");

        const heartbeatStream = withHeartbeat(
          merger.asyncIterable,
          heartbeatIntervalMs,
          abortController.signal,
        );

        for await (const event of heartbeatStream) {
          if (abortController.signal.aborted) {
            break;
          }

          if ("__heartbeat" in event) {
            await stream.write(KEEPALIVE_COMMENT);
            continue;
          }

          await stream.write(formatSseEvent(toSseEvent(event)));

          if (isRunEvent(event) && event.kind === "complete") {
            break;
          }
        }
      } finally {
        abortController.abort();
        abortController.cleanup();
      }
    });
  });

  app.get("/api/runs/:runId", (c) => {
    c.header("Cache-Control", "no-store");

    const runId = c.req.param("runId");
    const run = deps.db.getRunById(runId);
    if (run == null) {
      return c.json({ error: { message: "run not found", runId, type: "not_found" } }, 404);
    }

    const summary = deps.db.listRuns({ limit: 10_000 }).find((item) => item.runId === runId);
    if (summary === undefined) {
      return c.json({ error: { message: "run not found", runId, type: "not_found" } }, 404);
    }

    const sessions: RunDetailOutput["sessions"] = deps.db
      .getSessionsByRun(runId)
      .map((session) => ({
        ...session,
        lastEventId: session.lastEventId ?? null,
        runId,
      }));
    // Sub-issue ordering is now driven entirely by the run-state subIssues
    // list — child task results were dropped together with the legacy
    // `spawn_child_task` custom tool when migrating to Managed Agents'
    // multi-agent coordinator topology.
    const subIssues: RunDetailOutput["subIssues"] = [...run.subIssues];
    const payload: RunDetailOutput = {
      ...summary,
      ...(run.repositories === undefined ? {} : { repositories: run.repositories }),
      sessions,
      subIssues,
    };

    return c.json(payload, 200);
  });

  return app;
}
