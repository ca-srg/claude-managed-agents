import { afterEach, describe, expect, test } from "bun:test";
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
  EventListParams,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { Logger } from "pino";

import type { RunDetailOutput, RunSummaryOutput } from "@/features/run-api/schemas";
import { createRunApiRoutes, type RunApiDeps } from "@/features/run-api/server";
import {
  createRunQueueModule,
  type RunQueueModuleDeps,
  RunTargetResolutionError,
} from "@/features/run-queue/handler";
import { createDbModule } from "@/shared/persistence/db";
import { createRunEventsModule } from "@/shared/run-events";
import type { SessionClient, SessionResult } from "@/shared/session";
import type { RunEvent, RunPhase, RunState, RunStatus, RunSummary } from "@/shared/types";

type DbModule = ReturnType<typeof createDbModule>;
type EnqueueInput = Parameters<RunApiDeps["runQueue"]["enqueue"]>[0];
type QueueResponse = { position: number; runId: string; status: "queued" };
type SchemaErrorResponse = {
  error: { issues: unknown[]; message: string; type: string };
};
type StopErrorResponse = {
  error: { issues?: unknown[]; message: string; runId?: string; status?: RunStatus; type: string };
};
type StopResponse = { runId: string; stopped: true };
type SubIssueSeed = { issueId: number; issueNumber: number; taskId: string };
type ParsedSseMessage = { data?: unknown; event?: string; id?: string };

const openDbs: DbModule[] = [];
const silentLogger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
} as unknown as Logger;

function createEmptySessionUsage(): SessionResult["usage"] {
  return {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    inputTokens: 0,
    modelRequestCount: 0,
    outputTokens: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });

  if (resolveFn === undefined) {
    throw new Error("Deferred promise was not initialized");
  }

  return { promise, resolve: resolveFn };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await sleep(5);
  }

  throw new Error(`Timed out waiting for ${label}`);
}

function createRunSummary(runId: string, status: RunStatus): RunSummary {
  return {
    branch: `branch-${runId}`,
    issueNumber: 42,
    repo: "acme/widgets",
    runId,
    startedAt: "2026-04-28T00:00:00.000Z",
    status,
  };
}

function createFakeHarness(
  opts: { cancelResult?: boolean; enqueueError?: unknown; runs?: RunSummary[] } = {},
): {
  app: ReturnType<typeof createRunApiRoutes>;
  canceledRunIds: string[];
  emittedEvents: Array<Parameters<RunApiDeps["runEvents"]["emit"]>>;
  enqueuedInputs: EnqueueInput[];
  errorLogs: unknown[];
} {
  const canceledRunIds: string[] = [];
  const enqueuedInputs: EnqueueInput[] = [];
  const emittedEvents: Array<Parameters<RunApiDeps["runEvents"]["emit"]>> = [];
  const errorLogs: unknown[] = [];
  const deps: RunApiDeps = {
    db: {
      getRunById: () => null,
      getSessionsByRun: () => [],
      listRuns: (query) => {
        let runs = opts.runs ?? [];
        if (query.status !== undefined) {
          runs = runs.filter((run) => run.status === query.status);
        }
        if (query.repo !== undefined) {
          runs = runs.filter((run) => run.repo === query.repo);
        }

        return runs.slice(0, query.limit ?? runs.length);
      },
    },
    logger: {
      ...silentLogger,
      error(fields: unknown) {
        errorLogs.push(fields);
      },
    } as Logger,
    runEvents: {
      emit(runId, event) {
        emittedEvents.push([runId, event]);
        return {
          id: `event-${emittedEvents.length}`,
          kind: event.kind,
          payload: event.payload,
          runId,
          ts: event.ts ?? "2026-04-28T00:00:00.000Z",
        };
      },
      subscribe() {
        return {
          [Symbol.asyncIterator](): AsyncIterableIterator<RunEvent> {
            return {
              async next(): Promise<IteratorResult<RunEvent>> {
                return { done: true, value: undefined };
              },
              async return(): Promise<IteratorResult<RunEvent>> {
                return { done: true, value: undefined };
              },
              [Symbol.asyncIterator](): AsyncIterableIterator<RunEvent> {
                return this;
              },
            };
          },
        };
      },
    },
    runQueue: {
      async cancel(runId) {
        canceledRunIds.push(runId);
        return opts.cancelResult ?? false;
      },
      enqueue(input) {
        if (opts.enqueueError !== undefined) {
          throw opts.enqueueError;
        }

        enqueuedInputs.push(input);
        return { position: enqueuedInputs.length, runId: `run-${enqueuedInputs.length}` };
      },
      getStatus() {
        return null;
      },
    },
  };

  return {
    app: createRunApiRoutes(deps),
    canceledRunIds,
    emittedEvents,
    enqueuedInputs,
    errorLogs,
  };
}

async function postJson(
  app: ReturnType<typeof createRunApiRoutes>,
  body: unknown,
): Promise<Response> {
  return await app.request("/api/runs", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

async function postStop(
  app: ReturnType<typeof createRunApiRoutes>,
  runId: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = { method: "POST" };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "Content-Type": "application/json" };
  }

  return await app.request(`/api/runs/${runId}/stop`, init);
}

function setupTestDb(
  opts: {
    anthropicClient?: SessionClient;
    executor?: RunQueueModuleDeps["executor"];
    sseHeartbeatIntervalMs?: number;
  } = {},
): {
  app: ReturnType<typeof createRunApiRoutes>;
  db: DbModule;
  runEvents: ReturnType<typeof createRunEventsModule>;
  runQueue: ReturnType<typeof createRunQueueModule>;
} {
  const db = createDbModule(":memory:");
  db.addRegisteredRepository("acme/widgets");
  openDbs.push(db);
  const runEvents = createRunEventsModule({ db });
  const runQueue = createRunQueueModule({
    db,
    executor:
      opts.executor ??
      (async (input) => ({
        aborted: false,
        runId: input.runId,
        status: "completed",
        timedOut: false,
      })),
    runEvents,
  });

  return {
    app: createRunApiRoutes({
      anthropicClient: opts.anthropicClient,
      db,
      logger: silentLogger,
      runEvents,
      runQueue,
      sseHeartbeatIntervalMs: opts.sseHeartbeatIntervalMs,
    }),
    db,
    runEvents,
    runQueue,
  };
}

function seedRun(
  db: DbModule,
  input: {
    branch?: string;
    issueNumber?: number;
    phase?: RunPhase;
    prUrl?: string;
    repo?: string;
    repositories?: RunState["repositories"];
    runId: string;
    sessionIds?: string[];
    startedAt?: string;
    status?: RunStatus;
    subIssues?: SubIssueSeed[];
  },
): void {
  db.insertRun({
    branch: input.branch ?? `branch-${input.runId}`,
    issueNumber: input.issueNumber ?? 42,
    repo: input.repo ?? "acme/widgets",
    ...(input.repositories === undefined ? {} : { repositories: input.repositories }),
    runId: input.runId,
    // sessionIds は別テーブル (sessions) で管理されるため insertRun の入力としては
    // 空にしておき、後段で insertSession 経由で seed する。
    sessionIds: [],
    startedAt: input.startedAt ?? "2026-04-28T00:00:00.000Z",
    subIssues: input.subIssues ?? [],
    ...(input.prUrl === undefined ? {} : { prUrl: input.prUrl }),
  });

  for (const sessionId of input.sessionIds ?? []) {
    db.insertSession(input.runId, createSessionResult(sessionId));
  }

  if (input.status !== undefined) {
    db.setRunStatus(input.runId, input.status);
  }
  if (input.phase !== undefined) {
    db.setRunPhase(input.runId, input.phase);
  }
}

function createSessionResult(sessionId: string) {
  return {
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
    usage: createEmptySessionUsage(),
  };
}

function createRunningEvent(
  id: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.status_running" }> {
  return {
    id,
    processed_at: "2026-04-28T00:00:00.000Z",
    type: "session.status_running",
  };
}

function createAgentMessageEvent(
  id: string,
  text: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "agent.message" }> {
  return {
    content: [{ text, type: "text" }],
    id,
    processed_at: "2026-04-28T00:00:00.000Z",
    type: "agent.message",
  };
}

function createIdleEvent(
  id: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.status_idle" }> {
  return {
    id,
    processed_at: "2026-04-28T00:00:00.000Z",
    stop_reason: { type: "end_turn" },
    type: "session.status_idle",
  };
}

function createFakeSessionClient(script: {
  history?: BetaManagedAgentsSessionEvent[];
  live?: BetaManagedAgentsStreamSessionEvents[];
}): {
  calls: {
    listCalls: Array<{ params?: EventListParams; sessionId: string; signal?: AbortSignal }>;
    sendCalls: Array<{ params: EventSendParams; sessionId: string }>;
    streamCalls: Array<{ sessionId: string; signal?: AbortSignal }>;
  };
  client: SessionClient;
} {
  const calls = {
    listCalls: [] as Array<{ params?: EventListParams; sessionId: string; signal?: AbortSignal }>,
    sendCalls: [] as Array<{ params: EventSendParams; sessionId: string }>,
    streamCalls: [] as Array<{ sessionId: string; signal?: AbortSignal }>,
  };

  function createIterable<TEvent>(events: TEvent[]): AsyncIterable<TEvent> {
    return {
      async *[Symbol.asyncIterator](): AsyncIterableIterator<TEvent> {
        for (const event of events) {
          yield event;
        }
      },
    };
  }

  const eventsClient = {
    list(sessionId: string, params?: EventListParams, options?: { signal?: AbortSignal }) {
      calls.listCalls.push({ params, sessionId, signal: options?.signal });
      return createIterable(script.history ?? []);
    },
    async send(sessionId: string, params: EventSendParams) {
      calls.sendCalls.push({ params, sessionId });
      return { ok: true };
    },
    async stream(sessionId: string, options?: { signal?: AbortSignal }) {
      calls.streamCalls.push({ sessionId, signal: options?.signal });
      return createIterable(script.live ?? []);
    },
  };

  return {
    calls,
    client: {
      beta: { sessions: { events: eventsClient } },
    } as unknown as SessionClient,
  };
}

function createPerSessionFakeClient(scripts: {
  [sessionId: string]: {
    history?: BetaManagedAgentsSessionEvent[];
    live?: BetaManagedAgentsStreamSessionEvents[];
  };
}): {
  calls: {
    listCalls: Array<{ params?: EventListParams; sessionId: string; signal?: AbortSignal }>;
    streamCalls: Array<{ sessionId: string; signal?: AbortSignal }>;
  };
  client: SessionClient;
} {
  const calls = {
    listCalls: [] as Array<{ params?: EventListParams; sessionId: string; signal?: AbortSignal }>,
    streamCalls: [] as Array<{ sessionId: string; signal?: AbortSignal }>,
  };

  function createIterable<TEvent>(events: TEvent[]): AsyncIterable<TEvent> {
    return {
      async *[Symbol.asyncIterator](): AsyncIterableIterator<TEvent> {
        for (const event of events) {
          yield event;
        }
      },
    };
  }

  const eventsClient = {
    list(sessionId: string, params?: EventListParams, options?: { signal?: AbortSignal }) {
      calls.listCalls.push({ params, sessionId, signal: options?.signal });
      return createIterable(scripts[sessionId]?.history ?? []);
    },
    async stream(sessionId: string, options?: { signal?: AbortSignal }) {
      calls.streamCalls.push({ sessionId, signal: options?.signal });
      return createIterable(scripts[sessionId]?.live ?? []);
    },
  };

  return {
    calls,
    client: {
      beta: { sessions: { events: eventsClient } },
    } as unknown as SessionClient,
  };
}

function parseSseMessages(text: string): ParsedSseMessage[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.trim().length > 0 && !chunk.startsWith(":"))
    .map((chunk) => {
      const message: ParsedSseMessage = {};
      const dataLines: string[] = [];

      for (const line of chunk.split("\n")) {
        if (line.startsWith("id: ")) {
          message.id = line.slice("id: ".length);
        } else if (line.startsWith("event: ")) {
          message.event = line.slice("event: ".length);
        } else if (line.startsWith("data: ")) {
          dataLines.push(line.slice("data: ".length));
        }
      }

      if (dataLines.length > 0) {
        message.data = JSON.parse(dataLines.join("\n")) as unknown;
      }

      return message;
    });
}

async function readFirstChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("Expected response body");
  }

  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value);
}

async function postStopRaw(
  app: ReturnType<typeof createRunApiRoutes>,
  runId: string,
  body: string,
): Promise<Response> {
  return await app.request(`/api/runs/${runId}/stop`, {
    body,
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

function isQueuedPhasePayload(payload: unknown): payload is { phase: "queued" } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "phase" in payload &&
    payload.phase === "queued"
  );
}

async function expectSchemaError(
  app: ReturnType<typeof createRunApiRoutes>,
  body: unknown,
): Promise<SchemaErrorResponse> {
  const response = await postJson(app, body);
  const payload = (await response.json()) as SchemaErrorResponse;

  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(payload.error.type).toBe("schema");
  expect(payload.error.message).toBe("invalid request body");
  expect(payload.error.issues.length).not.toBe(0);

  return payload;
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe("createRunApiRoutes", () => {
  test("GET /api/runs returns empty runs when DB is empty", async () => {
    const { app } = setupTestDb();

    const response = await app.request("/api/runs");
    const payload = (await response.json()) as RunSummaryOutput;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toEqual({ runs: [], total: 0 });
  });

  test("GET /api/runs returns seeded runs", async () => {
    const { app, db } = setupTestDb();
    seedRun(db, { runId: "run-1", startedAt: "2026-04-28T00:00:01.000Z" });
    seedRun(db, { runId: "run-2", startedAt: "2026-04-28T00:00:02.000Z" });
    seedRun(db, { runId: "run-3", startedAt: "2026-04-28T00:00:03.000Z" });

    const response = await app.request("/api/runs");
    const payload = (await response.json()) as RunSummaryOutput;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.total).toBe(3);
    expect(payload.runs.map((run) => run.runId).sort()).toEqual(["run-1", "run-2", "run-3"]);
  });

  test("GET /api/runs returns resolved repositories for multi-repo runs", async () => {
    const { app, db } = setupTestDb();
    const repositories: NonNullable<RunState["repositories"]> = [
      {
        baseBranch: "main",
        branch: "agent/issue-42/fix-api",
        mountPath: "/workspace/acme__widgets",
        repo: "acme/widgets",
        role: "primary",
      },
      {
        baseBranch: "main",
        branch: "agent/issue-42/fix-api",
        mountPath: "/workspace/acme__api",
        repo: "acme/api",
        role: "target",
      },
    ];
    seedRun(db, { repositories, runId: "multi-repo-run" });

    const response = await app.request("/api/runs");
    const payload = (await response.json()) as RunSummaryOutput;

    expect(response.status).toBe(200);
    expect(payload.runs.find((run) => run.runId === "multi-repo-run")?.repositories).toEqual(
      repositories,
    );
  });

  test("GET /api/runs?status=running filters by status", async () => {
    const { app, db } = setupTestDb();
    seedRun(db, { runId: "queued-run", status: "queued" });
    seedRun(db, { runId: "running-run-1", status: "running" });
    seedRun(db, { runId: "running-run-2", status: "running" });

    const response = await app.request("/api/runs?status=running");
    const payload = (await response.json()) as RunSummaryOutput;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.total).toBe(2);
    expect(payload.runs.map((run) => run.runId).sort()).toEqual(["running-run-1", "running-run-2"]);
    expect(payload.runs.every((run) => run.status === "running")).toBe(true);
  });

  test("GET /api/runs?repo=owner/name filters by repo", async () => {
    const { app, db } = setupTestDb();
    seedRun(db, { repo: "owner/name", runId: "target-run-1" });
    seedRun(db, { repo: "other/repo", runId: "other-run" });
    seedRun(db, { repo: "owner/name", runId: "target-run-2" });

    const response = await app.request("/api/runs?repo=owner/name");
    const payload = (await response.json()) as RunSummaryOutput;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.total).toBe(2);
    expect(payload.runs.map((run) => run.runId).sort()).toEqual(["target-run-1", "target-run-2"]);
    expect(payload.runs.every((run) => run.repo === "owner/name")).toBe(true);
  });

  test("GET /api/runs?limit=2 returns at most two runs", async () => {
    const { app, db } = setupTestDb();
    seedRun(db, { runId: "run-1", startedAt: "2026-04-28T00:00:01.000Z" });
    seedRun(db, { runId: "run-2", startedAt: "2026-04-28T00:00:02.000Z" });
    seedRun(db, { runId: "run-3", startedAt: "2026-04-28T00:00:03.000Z" });

    const response = await app.request("/api/runs?limit=2");
    const payload = (await response.json()) as RunSummaryOutput;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.total).toBe(2);
    expect(payload.runs).toHaveLength(2);
  });

  test("GET /api/runs?status=invalid returns 400", async () => {
    const { app } = setupTestDb();

    const response = await app.request("/api/runs?status=invalid");
    const payload = (await response.json()) as SchemaErrorResponse;

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.error.type).toBe("schema");
    expect(payload.error.message).toBe("invalid request body");
    expect(payload.error.issues).toContainEqual(expect.objectContaining({ path: ["status"] }));
  });

  test("GET /api/runs/:runId returns run detail with sessions and subIssues", async () => {
    const { app, db } = setupTestDb();
    seedRun(db, {
      phase: "child_execution",
      prUrl: "https://github.com/acme/widgets/pull/7",
      runId: "detail-run",
      status: "running",
      subIssues: [
        { issueId: 101, issueNumber: 11, taskId: "task-a" },
        { issueId: 102, issueNumber: 12, taskId: "task-b" },
      ],
    });
    db.insertSession("detail-run", {
      aborted: false,
      durationMs: 1_234,
      errored: false,
      eventsProcessed: 9,
      idleReached: true,
      lastEventId: "event-9",
      model: undefined,
      sessionId: "session-1",
      timedOut: false,
      toolErrors: 1,
      toolInvocations: 4,
      usage: createEmptySessionUsage(),
    });
    const response = await app.request("/api/runs/detail-run");
    const payload = (await response.json()) as RunDetailOutput;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toMatchObject({
      phase: "child_execution",
      prUrl: "https://github.com/acme/widgets/pull/7",
      repo: "acme/widgets",
      runId: "detail-run",
      status: "running",
    });
    expect(payload.sessions).toEqual([
      {
        aborted: false,
        durationMs: 1_234,
        errored: false,
        eventsProcessed: 9,
        idleReached: true,
        lastEventId: "event-9",
        runId: "detail-run",
        sessionId: "session-1",
        timedOut: false,
        toolErrors: 1,
        toolInvocations: 4,
        usage: createEmptySessionUsage(),
      },
    ]);
    expect(payload.subIssues).toEqual([
      { issueId: 101, issueNumber: 11, taskId: "task-a" },
      { issueId: 102, issueNumber: 12, taskId: "task-b" },
    ]);
    expect(payload.events).toBeUndefined();
  });

  test("GET /api/runs/:runId returns resolved repositories for multi-repo runs", async () => {
    const { app, db } = setupTestDb();
    const repositories: NonNullable<RunState["repositories"]> = [
      {
        baseBranch: "main",
        branch: "agent/issue-42/fix-api",
        mountPath: "/workspace/acme__widgets",
        repo: "acme/widgets",
        role: "primary",
      },
      {
        baseBranch: "main",
        branch: "agent/issue-42/fix-api",
        mountPath: "/workspace/acme__api",
        repo: "acme/api",
        role: "target",
      },
    ];
    seedRun(db, { repositories, runId: "multi-repo-detail" });

    const response = await app.request("/api/runs/multi-repo-detail");
    const payload = (await response.json()) as RunDetailOutput;

    expect(response.status).toBe(200);
    expect(payload.repositories).toEqual(repositories);
  });

  test("GET /api/runs/:runId returns 404 for unknown runId", async () => {
    const { app } = setupTestDb();

    const response = await app.request("/api/runs/missing-run");
    const payload = (await response.json()) as StopErrorResponse;

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toEqual({
      error: { message: "run not found", runId: "missing-run", type: "not_found" },
    });
  });

  test("GET /api/runs/:runId/events returns 404 for unknown runId", async () => {
    const { app } = setupTestDb();

    const response = await app.request("/api/runs/missing-run/events");
    const payload = (await response.json()) as StopErrorResponse;

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toEqual({
      error: { message: "run not found", runId: "missing-run", type: "not_found" },
    });
  });

  test("GET /api/runs/:runId/events skips session streams when Anthropic client is absent", async () => {
    const { app, db, runEvents } = setupTestDb();
    seedRun(db, { runId: "run-sse-no-client" });
    db.insertSession("run-sse-no-client", createSessionResult("sesn-skipped"));
    runEvents.emit("run-sse-no-client", {
      id: "evt-1",
      kind: "log",
      payload: { message: "run only" },
      ts: "2026-04-28T00:00:01.000Z",
    });
    runEvents.emit("run-sse-no-client", {
      id: "evt-2",
      kind: "complete",
      payload: { status: "completed" },
      ts: "2026-04-28T00:00:02.000Z",
    });

    const response = await app.request("/api/runs/run-sse-no-client/events");
    const messages = parseSseMessages(await response.text());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("Cache-Control")).toContain("no-cache");
    expect(messages.map((message) => message.id)).toEqual(["evt-1", "evt-2"]);
    expect(messages.map((message) => message.event)).toEqual(["log", "complete"]);
    expect(messages[0]?.data).toEqual({ message: "run only" });
    expect(messages.some((message) => message.id?.startsWith("s:"))).toBe(false);
  });

  test("GET /api/runs/:runId/events replays run events and terminates on complete", async () => {
    const { app, db, runEvents } = setupTestDb();
    seedRun(db, { runId: "run-sse-basic" });
    runEvents.emit("run-sse-basic", {
      id: "evt-1",
      kind: "phase",
      payload: { phase: "preflight" },
      ts: "2026-04-28T00:00:01.000Z",
    });
    runEvents.emit("run-sse-basic", {
      id: "evt-2",
      kind: "subIssue",
      payload: { issueNumber: 101, taskId: "task-1" },
      ts: "2026-04-28T00:00:02.000Z",
    });
    runEvents.emit("run-sse-basic", {
      id: "evt-3",
      kind: "complete",
      payload: { status: "completed" },
      ts: "2026-04-28T00:00:03.000Z",
    });

    const response = await app.request("/api/runs/run-sse-basic/events");
    const messages = parseSseMessages(await response.text());

    expect(messages).toEqual([
      { data: { phase: "preflight" }, event: "phase", id: "evt-1" },
      { data: { issueNumber: 101, taskId: "task-1" }, event: "subIssue", id: "evt-2" },
      { data: { status: "completed" }, event: "complete", id: "evt-3" },
    ]);
  });

  test("GET /api/runs/:runId/events receives the queue-enriched complete payload", async () => {
    const releaseExecutor = createDeferred();
    const prUrl = "https://github.com/acme/widgets/pull/7";
    const decompositionPlan = { tasks: [{ id: "task-1", title: "Ship SSE fix" }] };
    let executorStarted = false;
    const { app, db, runQueue } = setupTestDb({
      executor: async (input) => {
        executorStarted = true;
        await releaseExecutor.promise;

        return {
          aborted: false,
          decompositionPlan,
          prUrl,
          runId: input.runId,
          status: "completed",
          timedOut: false,
        };
      },
    });

    const startResponse = await postJson(app, { issue: 42, repo: "acme/widgets" });
    const { runId } = (await startResponse.json()) as QueueResponse;
    const response = await app.request(`/api/runs/${runId}/events`);
    const textPromise = response.text();

    runQueue.start();
    await waitFor(() => executorStarted, "executor start");
    releaseExecutor.resolve();

    const messages = parseSseMessages(await textPromise);
    const completeMessages = messages.filter((message) => message.event === "complete");
    const persistedCompleteEvents = db
      .listRunEvents({ limit: 20, runId })
      .filter((event) => event.kind === "complete");

    expect(response.status).toBe(200);
    expect(completeMessages).toHaveLength(1);
    expect(completeMessages[0]?.data).toEqual({
      aborted: false,
      decompositionPlan,
      prUrl,
      status: "completed",
      timedOut: false,
    });
    expect(persistedCompleteEvents).toHaveLength(1);
    expect(persistedCompleteEvents[0]?.payload).toEqual(completeMessages[0]?.data);
  });

  test("GET /api/runs/:runId/events keeps streaming after error until complete", async () => {
    const { app, db, runEvents } = setupTestDb();
    seedRun(db, { runId: "run-sse-error-complete" });
    runEvents.emit("run-sse-error-complete", {
      id: "evt-1-error",
      kind: "error",
      payload: { message: "session failed" },
      ts: "2026-04-28T00:00:01.000Z",
    });
    runEvents.emit("run-sse-error-complete", {
      id: "evt-2-complete",
      kind: "complete",
      payload: { status: "failed" },
      ts: "2026-04-28T00:00:02.000Z",
    });

    const response = await app.request("/api/runs/run-sse-error-complete/events");
    const messages = parseSseMessages(await response.text());

    expect(response.status).toBe(200);
    expect(messages).toEqual([
      { data: { message: "session failed" }, event: "error", id: "evt-1-error" },
      { data: { status: "failed" }, event: "complete", id: "evt-2-complete" },
    ]);
  });

  test("GET /api/runs/:runId/events propagates Last-Event-ID to runEvents.subscribe", async () => {
    const { app, db, runEvents } = setupTestDb();
    seedRun(db, { runId: "run-sse-resume" });
    for (const index of [1, 2, 3, 4]) {
      runEvents.emit("run-sse-resume", {
        id: `evt-${index}`,
        kind: "log",
        payload: { index },
        ts: `2026-04-28T00:00:0${index}.000Z`,
      });
    }
    runEvents.emit("run-sse-resume", {
      id: "evt-5",
      kind: "complete",
      payload: { status: "completed" },
      ts: "2026-04-28T00:00:05.000Z",
    });

    const response = await app.request("/api/runs/run-sse-resume/events", {
      headers: { "Last-Event-ID": "evt-2" },
    });
    const messages = parseSseMessages(await response.text());

    expect(messages.map((message) => message.id)).toEqual(["evt-3", "evt-4", "evt-5"]);
    expect(messages.map((message) => message.data)).toEqual([
      { index: 3 },
      { index: 4 },
      { status: "completed" },
    ]);
  });

  test("GET /api/runs/:runId/events multiplexes Anthropic session events", async () => {
    const { calls, client } = createFakeSessionClient({
      history: [createRunningEvent("sesn-evt-1")],
      live: [createAgentMessageEvent("sesn-evt-2", "hello"), createIdleEvent("sesn-evt-3")],
    });
    const { app, db, runEvents } = setupTestDb({ anthropicClient: client });
    seedRun(db, { runId: "run-sse-session" });
    db.insertSession("run-sse-session", createSessionResult("sesn-tail"));

    const response = await app.request("/api/runs/run-sse-session/events");
    const completionTimer = setTimeout(() => {
      runEvents.emit("run-sse-session", {
        id: "evt-complete",
        kind: "complete",
        payload: { status: "completed" },
        ts: "2026-04-28T00:00:10.000Z",
      });
    }, 20);

    try {
      const messages = parseSseMessages(await response.text());
      const sessionMessages = messages.filter((message) => message.id?.startsWith("s:sesn-tail:"));

      expect(calls.listCalls).toHaveLength(1);
      expect(calls.listCalls[0]?.params?.limit).toBe(100);
      expect(calls.listCalls[0]?.params?.order).toBe("asc");
      expect(calls.listCalls[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(calls.streamCalls[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(sessionMessages.map((message) => message.event)).toEqual([
        "session",
        "session",
        "session",
      ]);
      expect(sessionMessages.map((message) => message.id)).toEqual([
        "s:sesn-tail:sesn-evt-1",
        "s:sesn-tail:sesn-evt-2",
        "s:sesn-tail:sesn-evt-3",
      ]);
      expect(messages[messages.length - 1]).toEqual({
        data: { status: "completed" },
        event: "complete",
        id: "evt-complete",
      });
    } finally {
      clearTimeout(completionTimer);
    }
  });

  test("GET /api/runs/:runId/events dynamically subscribes to sessions emitted via run-events", async () => {
    const { calls, client } = createPerSessionFakeClient({
      "sesn-child": {
        history: [createRunningEvent("sesn-child-1")],
        live: [createAgentMessageEvent("sesn-child-2", "child reply")],
      },
      "sesn-parent": {
        history: [createRunningEvent("sesn-parent-1")],
        live: [createAgentMessageEvent("sesn-parent-2", "parent thinking")],
      },
    });
    const { app, db, runEvents } = setupTestDb({ anthropicClient: client });
    seedRun(db, {
      runId: "run-dynamic-session",
      sessionIds: ["sesn-parent"],
    });

    const response = await app.request("/api/runs/run-dynamic-session/events");
    const childCreatedTimer = setTimeout(() => {
      runEvents.emit("run-dynamic-session", {
        id: "evt-child-created",
        kind: "session",
        payload: {
          details: { role: "child" },
          kind: "created",
          sessionId: "sesn-child",
        },
        ts: "2026-04-28T00:00:01.000Z",
      });
    }, 20);
    const completionTimer = setTimeout(() => {
      runEvents.emit("run-dynamic-session", {
        id: "evt-complete",
        kind: "complete",
        payload: { status: "completed" },
        ts: "2026-04-28T00:00:02.000Z",
      });
    }, 60);

    try {
      const messages = parseSseMessages(await response.text());

      // 接続時点の sessionId と、後から run-events 経由で告知された sessionId の両方で
      // Anthropic の events.list が呼ばれている (= 動的に session events stream が
      // merger に追加された)
      expect(calls.listCalls.map((call) => call.sessionId).sort()).toEqual([
        "sesn-child",
        "sesn-parent",
      ]);

      const sessionMessages = messages.filter((message) => message.id?.startsWith("s:"));
      const sessionIds = new Set(sessionMessages.map((message) => message.id));
      expect(sessionIds.has("s:sesn-parent:sesn-parent-1")).toBe(true);
      expect(sessionIds.has("s:sesn-parent:sesn-parent-2")).toBe(true);
      expect(sessionIds.has("s:sesn-child:sesn-child-1")).toBe(true);
      expect(sessionIds.has("s:sesn-child:sesn-child-2")).toBe(true);

      const lastMessage = messages[messages.length - 1];
      expect(lastMessage).toEqual({
        data: { status: "completed" },
        event: "complete",
        id: "evt-complete",
      });
    } finally {
      clearTimeout(childCreatedTimer);
      clearTimeout(completionTimer);
    }
  });

  test("GET /api/runs/:runId/events handles session stream error paths", async () => {
    const warnCalls: Array<{ fields: unknown; message: string }> = [];
    const db = createDbModule(":memory:");
    db.addRegisteredRepository("acme/widgets");
    openDbs.push(db);
    const runEvents = createRunEventsModule({ db });
    const runQueue = createRunQueueModule({
      db,
      executor: async (input) => ({
        aborted: false,
        runId: input.runId,
        status: "completed",
        timedOut: false,
      }),
      runEvents,
    });
    const historyFails = true;
    const client = {
      beta: {
        sessions: {
          events: {
            list() {
              return {
                async *[Symbol.asyncIterator]() {
                  if (historyFails) {
                    throw new Error("session history unavailable");
                  }

                  yield createRunningEvent("unreachable-history-event");
                },
              };
            },
            async stream() {
              return {
                async *[Symbol.asyncIterator]() {
                  yield createIdleEvent("unused-live-event");
                },
              };
            },
          },
        },
      },
    } as unknown as SessionClient;
    const logger = {
      warn(fields: unknown, message: string) {
        warnCalls.push({ fields, message });
      },
    } as Logger;
    const app = createRunApiRoutes({ db, logger, runEvents, runQueue, anthropicClient: client });

    seedRun(db, { runId: "run-sse-session-error" });
    db.insertSession("run-sse-session-error", createSessionResult("sesn-error"));
    runEvents.emit("run-sse-session-error", {
      id: "evt-complete",
      kind: "complete",
      payload: { status: "completed" },
      ts: "2026-04-28T00:00:01.000Z",
    });

    const response = await app.request("/api/runs/run-sse-session-error/events");
    const messages = parseSseMessages(await response.text());

    expect(response.status).toBe(200);
    expect(messages).toEqual([
      { data: { status: "completed" }, event: "complete", id: "evt-complete" },
    ]);
    expect(warnCalls).toEqual([
      {
        fields: expect.objectContaining({ sessionId: "sesn-error" }),
        message: "run api session events stream failed",
      },
    ]);
  });

  test("GET /api/runs/:runId/events emits keepalive heartbeats", async () => {
    const { app, db } = setupTestDb({ sseHeartbeatIntervalMs: 20 });
    seedRun(db, { runId: "run-sse-heartbeat" });

    const response = await app.request("/api/runs/run-sse-heartbeat/events");
    const text = await readFirstChunk(response);

    expect(response.status).toBe(200);
    expect(text).toContain(": keepalive\n\n");
  });

  test("GET /api/runs/:runId/events closes runEvents subscription on client disconnect", async () => {
    let nextCalled = false;
    let returnCalled = false;
    let resolveNext: ((result: IteratorResult<RunEvent>) => void) | undefined;
    let observedSignal: AbortSignal | undefined;
    const requestAbortController = new AbortController();
    const deps: RunApiDeps = {
      db: {
        getRunById: () => ({
          branch: "branch-disconnect-run",
          issueNumber: 42,
          repo: "acme/widgets",
          runId: "disconnect-run",
          sessionIds: [],
          startedAt: "2026-04-28T00:00:00.000Z",
          subIssues: [],
        }),
        getSessionsByRun: () => [],
        listRuns: () => [],
      },
      logger: silentLogger,
      runEvents: {
        emit(runId, event) {
          return {
            id: event.id ?? "unused-event",
            kind: event.kind,
            payload: event.payload,
            runId,
            ts: event.ts ?? "2026-04-28T00:00:00.000Z",
          };
        },
        subscribe(_runId, opts) {
          const subscribeSignal = opts?.signal;
          observedSignal = subscribeSignal;
          return {
            [Symbol.asyncIterator]() {
              return {
                next(): Promise<IteratorResult<RunEvent>> {
                  nextCalled = true;
                  return new Promise((resolve) => {
                    resolveNext = resolve;
                    subscribeSignal?.addEventListener(
                      "abort",
                      () => resolve({ done: true, value: undefined }),
                      { once: true },
                    );
                  });
                },
                async return(): Promise<IteratorResult<RunEvent>> {
                  returnCalled = true;
                  resolveNext?.({ done: true, value: undefined });
                  return { done: true, value: undefined };
                },
              };
            },
          };
        },
      },
      runQueue: {
        async cancel() {
          return false;
        },
        enqueue() {
          return { position: 1, runId: "unused-run" };
        },
        getStatus() {
          return null;
        },
      },
      sseHeartbeatIntervalMs: 10_000,
    };
    const app = createRunApiRoutes(deps);

    const response = await app.request("/api/runs/disconnect-run/events", {
      signal: requestAbortController.signal,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("Expected response body");
    }
    const readPromise = reader.read().catch(() => undefined);

    await waitFor(() => nextCalled, "run event subscription next");
    requestAbortController.abort();
    await reader.cancel();
    await readPromise;

    await waitFor(() => returnCalled, "run event subscription cleanup");
    expect(observedSignal?.aborted).toBe(true);
  });

  test("POST /api/runs enqueues a valid body and returns queued status", async () => {
    const { app, emittedEvents, enqueuedInputs } = createFakeHarness();

    const response = await postJson(app, {
      configPath: "maestro.config.ts",
      dryRun: true,
      issue: 42,
      repo: "acme/widgets",
      vaultId: "vault-1",
    });
    const payload = (await response.json()) as QueueResponse;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toEqual({ position: 1, runId: "run-1", status: "queued" });
    expect(enqueuedInputs).toEqual([
      {
        configPath: "maestro.config.ts",
        dryRun: true,
        issue: 42,
        origin: "github_issue",
        repo: "acme/widgets",
        vaultId: "vault-1",
      },
    ]);
    expect(emittedEvents).toEqual([]);
  });

  test("POST /api/runs rejects conflicting issue URL and explicit repo before enqueueing", async () => {
    const { app, enqueuedInputs } = createFakeHarness();
    const payload = await expectSchemaError(app, {
      issue: "https://github.com/acme/widgets/issues/42",
      repo: "acme/api",
    });

    expect(payload.error.issues).toContainEqual(expect.objectContaining({ path: ["repo"] }));
    expect(enqueuedInputs).toEqual([]);
  });

  test("POST /api/runs maps run target resolution failures to 400", async () => {
    const { app, enqueuedInputs } = createFakeHarness({
      enqueueError: new RunTargetResolutionError(
        "Repository acme/api is not registered and enabled",
      ),
    });

    const response = await postJson(app, { issue: 42, repo: "acme/widgets" });
    const payload = (await response.json()) as StopErrorResponse;

    expect(response.status).toBe(400);
    expect(payload.error).toEqual({
      message: "Repository acme/api is not registered and enabled",
      type: "run_target_resolution",
    });
    expect(enqueuedInputs).toEqual([]);
  });

  test("POST /api/runs maps enqueue persistence failures to 500", async () => {
    const { app, enqueuedInputs, errorLogs } = createFakeHarness({
      enqueueError: new Error("database is locked"),
    });

    const response = await postJson(app, { issue: 42, repo: "acme/widgets" });
    const payload = (await response.json()) as StopErrorResponse;

    expect(response.status).toBe(500);
    expect(payload.error).toEqual({
      message: "failed to enqueue run",
      type: "server_error",
    });
    expect(payload.error.type).not.toBe("run_target_resolution");
    expect(errorLogs).toHaveLength(1);
    expect((errorLogs[0] as { err?: unknown }).err instanceof Error).toBe(true);
    expect(enqueuedInputs).toEqual([]);
  });

  test("POST /api/runs rejects blank Linear issue identifiers before enqueueing", async () => {
    const { app, enqueuedInputs } = createFakeHarness();
    const payload = await expectSchemaError(app, {
      linearIssue: "   ",
      origin: "linear_issue",
      repo: "acme/widgets",
    });

    expect(payload.error.issues).toContainEqual(expect.objectContaining({ path: ["linearIssue"] }));
    expect(enqueuedInputs).toEqual([]);
  });

  test("POST /api/runs rejects Linear issue payloads without a repo before enqueueing", async () => {
    const { app, enqueuedInputs } = createFakeHarness();
    const payload = await expectSchemaError(app, {
      linearIssue: "ENG-123",
      origin: "linear_issue",
    });

    expect(payload.error.issues).toContainEqual(expect.objectContaining({ path: ["repo"] }));
    expect(enqueuedInputs).toEqual([]);
  });

  test("POST /api/runs rejects bodies missing issue", async () => {
    const { app, enqueuedInputs } = createFakeHarness();
    const payload = await expectSchemaError(app, { repo: "acme/widgets" });

    expect(payload.error.issues).toContainEqual(expect.objectContaining({ path: ["issue"] }));
    expect(enqueuedInputs).toEqual([]);
  });

  test("POST /api/runs accepts missing repo field for registered-repository resolution", async () => {
    const { app, enqueuedInputs } = createFakeHarness();
    const response = await postJson(app, { issue: 42 });
    const payload = (await response.json()) as QueueResponse;

    expect(response.status).toBe(200);
    expect(payload).toEqual({ position: 1, runId: "run-1", status: "queued" });
    expect(enqueuedInputs).toEqual([{ dryRun: false, issue: 42, origin: "github_issue" }]);
  });

  test("POST /api/runs rejects malformed JSON error body without enqueueing", async () => {
    const { app, enqueuedInputs } = createFakeHarness();
    const response = await app.request("/api/runs", {
      body: "not-json",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    const payload = (await response.json()) as SchemaErrorResponse;

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.error.type).toBe("schema");
    expect(payload.error.message).toBe("invalid request body");
    expect(payload.error.issues).toContainEqual(
      expect.objectContaining({ code: "invalid_json", message: "invalid JSON body" }),
    );
    expect(enqueuedInputs).toEqual([]);
  });

  test("POST /api/runs rejects non-positive issue numbers", async () => {
    const { app, enqueuedInputs } = createFakeHarness();
    const payload = await expectSchemaError(app, { issue: -1, repo: "acme/widgets" });

    expect(payload.error.issues).toContainEqual(expect.objectContaining({ path: ["issue"] }));
    expect(enqueuedInputs).toEqual([]);
  });

  test("POST /api/runs rejects malformed repo slugs", async () => {
    const { app, enqueuedInputs } = createFakeHarness();
    const payload = await expectSchemaError(app, { issue: 42, repo: "not-a-slug" });

    expect(payload.error.issues).toContainEqual(expect.objectContaining({ path: ["repo"] }));
    expect(enqueuedInputs).toEqual([]);
  });

  test("POST /api/runs rejects unknown fields", async () => {
    const { app, enqueuedInputs } = createFakeHarness();
    const payload = await expectSchemaError(app, { extra: true, issue: 42, repo: "acme/widgets" });

    expect(payload.error.issues).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys" }),
    );
    expect(enqueuedInputs).toEqual([]);
  });

  test("POST /api/runs/:runId/stop returns 404 for unknown runId", async () => {
    const { app, canceledRunIds } = createFakeHarness();

    const response = await postStop(app, "missing-run");
    const payload = (await response.json()) as StopErrorResponse;

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toEqual({
      error: { message: "run not found", runId: "missing-run", type: "not_found" },
    });
    expect(canceledRunIds).toEqual([]);
  });

  test("POST /api/runs/:runId/stop returns 409 for terminal run states", async () => {
    const terminalStatuses: RunStatus[] = ["completed", "failed", "aborted"];

    for (const status of terminalStatuses) {
      const runId = `terminal-${status}`;
      const { app, canceledRunIds } = createFakeHarness({
        runs: [createRunSummary(runId, status)],
      });

      const response = await postStop(app, runId);
      const payload = (await response.json()) as StopErrorResponse;

      expect(response.status).toBe(409);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(payload).toEqual({
        error: {
          message: "run is already terminal",
          runId,
          status,
          type: "already_terminal",
        },
      });
      expect(canceledRunIds).toEqual([]);
    }
  });

  test("POST /api/runs/:runId/stop returns 504 when cancel times out", async () => {
    const { app, canceledRunIds } = createFakeHarness({
      cancelResult: false,
      runs: [createRunSummary("run-1", "queued")],
    });

    const response = await postStop(app, "run-1", {});
    const payload = (await response.json()) as StopErrorResponse;

    expect(response.status).toBe(504);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toEqual({
      error: { message: "run cancellation timed out", runId: "run-1", type: "cancel_timeout" },
    });
    expect(canceledRunIds).toEqual(["run-1"]);
  });

  test("POST /api/runs/:runId/stop cancels a queued run and removes it from the queue", async () => {
    const db = createDbModule(":memory:");
    db.addRegisteredRepository("acme/widgets");
    openDbs.push(db);
    const runEvents = createRunEventsModule({ db });
    const executorRunIds: string[] = [];
    const runQueue = createRunQueueModule({
      db,
      executor: async (input) => {
        executorRunIds.push(input.runId);
        return { aborted: false, runId: input.runId, status: "completed", timedOut: false };
      },
      runEvents,
    });
    const app = createRunApiRoutes({ db, logger: silentLogger, runEvents, runQueue });

    const startResponse = await postJson(app, { issue: 42, repo: "acme/widgets" });
    const { runId } = (await startResponse.json()) as QueueResponse;

    const stopResponse = await postStop(app, runId, {});
    const stopPayload = (await stopResponse.json()) as StopResponse;

    expect(stopResponse.status).toBe(200);
    expect(stopResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(stopPayload).toEqual({ runId, stopped: true });
    expect(runQueue.getStatus(runId)).toBe("aborted");
    expect(db.listRuns({ limit: 10_000 }).find((run) => run.runId === runId)?.status).toBe(
      "aborted",
    );

    runQueue.start();
    await sleep(20);
    await runQueue.stop();

    expect(executorRunIds).toEqual([]);
  });

  test("POST /api/runs/:runId/stop cancels a running run and marks it aborted", async () => {
    const db = createDbModule(":memory:");
    db.addRegisteredRepository("acme/widgets");
    openDbs.push(db);
    const runEvents = createRunEventsModule({ db });
    let executorStarted = false;
    let observedAbort = false;
    const runQueue = createRunQueueModule({
      db,
      executor: async (input) => {
        executorStarted = true;
        await new Promise<void>((resolve) => {
          const timeoutId = setTimeout(resolve, 10_000);
          const finish = () => {
            clearTimeout(timeoutId);
            resolve();
          };

          if (input.signal.aborted) {
            finish();
            return;
          }

          input.signal.addEventListener("abort", finish, { once: true });
        });
        observedAbort = input.signal.aborted;

        return {
          aborted: input.signal.aborted,
          runId: input.runId,
          status: input.signal.aborted ? "aborted" : "completed",
          timedOut: false,
        };
      },
      runEvents,
    });
    const app = createRunApiRoutes({ db, logger: silentLogger, runEvents, runQueue });

    const startResponse = await postJson(app, { issue: 42, repo: "acme/widgets" });
    const { runId } = (await startResponse.json()) as QueueResponse;
    runQueue.start();
    await waitFor(
      () => executorStarted && runQueue.getStatus(runId) === "running",
      "running status",
    );

    const stopResponse = await postStop(app, runId);
    const stopPayload = (await stopResponse.json()) as StopResponse;

    expect(stopResponse.status).toBe(200);
    expect(stopResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(stopPayload).toEqual({ runId, stopped: true });
    expect(observedAbort).toBe(true);
    expect(db.listRuns({ limit: 10_000 }).find((run) => run.runId === runId)?.status).toBe(
      "aborted",
    );

    await runQueue.stop();
  });

  test("POST /api/runs/:runId/stop rejects malformed bodies", async () => {
    const { app, canceledRunIds } = createFakeHarness({
      cancelResult: true,
      runs: [createRunSummary("run-1", "queued")],
    });

    const response = await postStopRaw(app, "run-1", '{"force":"not-a-bool"}');
    const payload = (await response.json()) as StopErrorResponse;

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.error.type).toBe("schema");
    expect(payload.error.message).toBe("invalid request body");
    expect(payload.error.issues?.length).not.toBe(0);
    expect(canceledRunIds).toEqual([]);
  });

  test("POST /api/runs/:runId/stop rejects malformed JSON error bodies", async () => {
    const { app, canceledRunIds } = createFakeHarness({
      cancelResult: true,
      runs: [createRunSummary("run-1", "queued")],
    });

    const response = await postStopRaw(app, "run-1", "not-json");
    const payload = (await response.json()) as StopErrorResponse;

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload.error.type).toBe("schema");
    expect(payload.error.message).toBe("invalid request body");
    expect(payload.error.issues).toContainEqual(
      expect.objectContaining({ code: "invalid_json", message: "invalid JSON body" }),
    );
    expect(canceledRunIds).toEqual([]);
  });

  test("POST /api/runs/:runId/stop accepts an empty body", async () => {
    const { app, canceledRunIds } = createFakeHarness({
      cancelResult: true,
      runs: [createRunSummary("run-1", "queued")],
    });

    const response = await postStop(app, "run-1");
    const payload = (await response.json()) as StopResponse;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toEqual({ runId: "run-1", stopped: true });
    expect(canceledRunIds).toEqual(["run-1"]);
  });

  test("POST /api/runs preserves FIFO serialization through runQueue", async () => {
    const db = createDbModule(":memory:");
    db.addRegisteredRepository("acme/widgets");
    openDbs.push(db);
    const runEvents = createRunEventsModule({ db });
    const executionOrder: number[] = [];
    let activeExecutors = 0;
    let maxActiveExecutors = 0;
    const runQueue = createRunQueueModule({
      db,
      executor: async (input) => {
        activeExecutors += 1;
        maxActiveExecutors = Math.max(maxActiveExecutors, activeExecutors);
        if (!("issue" in input)) {
          throw new Error("Expected GitHub-origin run input");
        }
        executionOrder.push(input.issue);
        await sleep(20);
        activeExecutors -= 1;

        return { aborted: false, runId: input.runId, status: "completed", timedOut: false };
      },
      runEvents,
    });
    const app = createRunApiRoutes({ db, logger: silentLogger, runEvents, runQueue });

    const responses = await Promise.all([
      postJson(app, { issue: 1, repo: "acme/widgets" }),
      postJson(app, { issue: 2, repo: "acme/widgets" }),
      postJson(app, { issue: 3, repo: "acme/widgets" }),
    ]);
    const payloads = (await Promise.all(responses.map((response) => response.json()))) as [
      QueueResponse,
      QueueResponse,
      QueueResponse,
    ];

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(payloads.map((payload) => payload.position)).toEqual([1, 2, 3]);
    expect(payloads.map((payload) => payload.status)).toEqual(["queued", "queued", "queued"]);

    runQueue.start();

    await waitFor(
      () => runQueue.getStatus(payloads[2].runId) === "completed",
      "third run completion",
    );

    expect(executionOrder).toEqual([1, 2, 3]);
    expect(maxActiveExecutors).toBe(1);
    for (const payload of payloads) {
      const queuedEvents = db
        .listRunEvents({ limit: 20, runId: payload.runId })
        .filter((event) => event.kind === "phase" && isQueuedPhasePayload(event.payload));
      expect(queuedEvents).toHaveLength(1);
    }
  });
});
