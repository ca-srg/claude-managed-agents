import { afterEach, describe, expect, test } from "bun:test";
import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsSessionEvent,
  EventListParams,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";

import {
  createStaleRunReaper,
  parseStaleRunReaperConfigFromEnv,
} from "@/features/stale-run-reaper/reaper";
import { createDbModule } from "@/shared/persistence/db";
import { createRunEventsModule } from "@/shared/run-events";
import type { RunState, RunStatus } from "@/shared/types";

type DbModule = ReturnType<typeof createDbModule>;

type FakeClientCalls = {
  deletes: string[];
  listCalls: Array<{ params?: EventListParams; sessionId: string }>;
  sends: Array<{ params: EventSendParams; sessionId: string }>;
};

const openDbs: DbModule[] = [];
const RUN_ID = "run-stale-reaper";
const SESSION_ID = "sess-stale-reaper";
const OLD_PROCESSED_AT = "2026-04-23T00:00:00.000Z";
const FRESH_PROCESSED_AT = "2026-04-23T00:16:00.000Z";
const NOW = new Date("2026-04-23T00:20:00.000Z");

function createRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    branch: "agent/issue-42/example",
    issueNumber: 42,
    repo: "acme/widgets",
    runId: RUN_ID,
    sessionIds: [],
    startedAt: "2026-04-23T00:00:00.000Z",
    subIssues: [],
    ...overrides,
  };
}

function seedRunningRun(db: DbModule, input: { runId?: string; sessionId?: string } = {}): void {
  const runId = input.runId ?? RUN_ID;
  const sessionId = input.sessionId ?? SESSION_ID;

  db.insertRun(createRunState({ runId }));
  db.setRunStatus(runId, "running");
  db.insertSessionPlaceholder(runId, sessionId);
}

function getDbStatus(db: DbModule, runId = RUN_ID): RunStatus | null {
  return db.listRuns({ limit: 100 }).find((run) => run.runId === runId)?.status ?? null;
}

function createCustomToolUseEvent(
  id: string,
  name = "create_final_pr",
): BetaManagedAgentsAgentCustomToolUseEvent {
  return {
    id,
    input: {},
    name,
    processed_at: OLD_PROCESSED_AT,
    type: "agent.custom_tool_use",
  };
}

function createRequiresActionIdleEvent(
  id: string,
  eventIds: ReadonlyArray<string>,
  processedAt: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.status_idle" }> {
  return {
    id,
    processed_at: processedAt,
    stop_reason: { event_ids: [...eventIds], type: "requires_action" },
    type: "session.status_idle",
  };
}

function createCustomToolResultEvent(
  id: string,
  customToolUseId: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "user.custom_tool_result" }> {
  return {
    custom_tool_use_id: customToolUseId,
    id,
    type: "user.custom_tool_result",
  };
}

function createIdleEvent(
  id: string,
  processedAt = OLD_PROCESSED_AT,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.status_idle" }> {
  return {
    id,
    processed_at: processedAt,
    stop_reason: { type: "end_turn" },
    type: "session.status_idle",
  };
}

function createRunningEvent(
  id: string,
  processedAt = OLD_PROCESSED_AT,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.status_running" }> {
  return {
    id,
    processed_at: processedAt,
    type: "session.status_running",
  };
}

function createFakeClient(eventsBySession: Record<string, BetaManagedAgentsSessionEvent[]>): {
  calls: FakeClientCalls;
  client: Parameters<typeof createStaleRunReaper>[0]["anthropicClient"];
} {
  const calls: FakeClientCalls = { deletes: [], listCalls: [], sends: [] };

  return {
    calls,
    client: {
      beta: {
        sessions: {
          async delete(sessionId: string) {
            calls.deletes.push(sessionId);
            return { id: sessionId, type: "session_deleted" };
          },
          events: {
            list(sessionId: string, params?: EventListParams) {
              calls.listCalls.push({ params, sessionId });
              return {
                async *[Symbol.asyncIterator]() {
                  for (const event of eventsBySession[sessionId] ?? []) {
                    yield event;
                  }
                },
              };
            },
            async send(sessionId: string, params: EventSendParams) {
              calls.sends.push({ params, sessionId });
              return { ok: true };
            },
          },
        },
      },
    },
  };
}

function createHarness(events: BetaManagedAgentsSessionEvent[]): {
  calls: FakeClientCalls;
  db: DbModule;
  reaper: ReturnType<typeof createStaleRunReaper>;
} {
  const db = createDbModule(":memory:");
  openDbs.push(db);
  const runEvents = createRunEventsModule({ db });
  const { calls, client } = createFakeClient({ [SESSION_ID]: events });

  seedRunningRun(db);

  return {
    calls,
    db,
    reaper: createStaleRunReaper({
      anthropicClient: client,
      config: {
        intervalMs: 1_000,
        requiresActionStaleMs: 10 * 60 * 1_000,
      },
      db,
      now: () => NOW,
      runEvents,
    }),
  };
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe("createStaleRunReaper", () => {
  test("recovers a running run stuck in stale requires_action", async () => {
    const toolUse = createCustomToolUseEvent("evt-tool-1");
    const { calls, db, reaper } = createHarness([
      createRequiresActionIdleEvent("evt-idle-1", [toolUse.id], OLD_PROCESSED_AT),
      toolUse,
    ]);

    const summary = await reaper.reapOnce();

    expect(summary).toEqual({
      cancelled: 0,
      errors: 0,
      recovered: 1,
      scanned: 1,
      skipped: 0,
      staleRequiresAction: 1,
    });
    expect(getDbStatus(db)).toBe("failed");

    const toolResultSend = calls.sends.at(0);
    expect(toolResultSend).toBeDefined();
    if (toolResultSend === undefined) {
      throw new Error("expected stale custom tool result send");
    }
    const toolResultEvent = toolResultSend.params.events.at(0);
    expect(toolResultEvent).toMatchObject({
      custom_tool_use_id: toolUse.id,
      is_error: true,
      type: "user.custom_tool_result",
    });
    expect(calls.sends.at(1)?.params.events.at(0)).toEqual({ type: "user.interrupt" });
    expect(calls.deletes).toEqual([SESSION_ID]);

    const runEvents = db.listRunEvents({ limit: 20, runId: RUN_ID });
    expect(runEvents.map((event) => event.kind)).toContain("error");
    expect(runEvents.map((event) => event.kind)).toContain("complete");
  });

  test("leaves fresh requires_action runs alone", async () => {
    const toolUse = createCustomToolUseEvent("evt-tool-fresh");
    const { calls, db, reaper } = createHarness([
      createRequiresActionIdleEvent("evt-idle-fresh", [toolUse.id], FRESH_PROCESSED_AT),
      toolUse,
    ]);

    const summary = await reaper.reapOnce();

    expect(summary.staleRequiresAction).toBe(0);
    expect(summary.recovered).toBe(0);
    expect(getDbStatus(db)).toBe("running");
    expect(calls.sends).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
  });

  test("does not reap a requires_action idle whose tool result already exists", async () => {
    const toolUse = createCustomToolUseEvent("evt-tool-resolved");
    const { calls, db, reaper } = createHarness([
      createRequiresActionIdleEvent("evt-idle-resolved", [toolUse.id], OLD_PROCESSED_AT),
      createCustomToolResultEvent("evt-result-resolved", toolUse.id),
      toolUse,
    ]);

    const summary = await reaper.reapOnce();

    expect(summary.staleRequiresAction).toBe(0);
    expect(getDbStatus(db)).toBe("running");
    expect(calls.sends).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
  });

  test("requires latest session status to be requires_action idle", async () => {
    const toolUse = createCustomToolUseEvent("evt-tool-running");
    const { calls, db, reaper } = createHarness([
      createRunningEvent("evt-running-latest"),
      createRequiresActionIdleEvent("evt-idle-old", [toolUse.id], OLD_PROCESSED_AT),
      toolUse,
    ]);

    const summary = await reaper.reapOnce();

    expect(summary.staleRequiresAction).toBe(0);
    expect(getDbStatus(db)).toBe("running");
    expect(calls.sends).toHaveLength(0);
  });

  test("delegates active stale runs to cancelRun before terminalizing", async () => {
    const db = createDbModule(":memory:");
    openDbs.push(db);
    const runEvents = createRunEventsModule({ db });
    const toolUse = createCustomToolUseEvent("evt-tool-cancel");
    const { calls, client } = createFakeClient({
      [SESSION_ID]: [
        createRequiresActionIdleEvent("evt-idle-cancel", [toolUse.id], OLD_PROCESSED_AT),
        toolUse,
      ],
    });
    seedRunningRun(db);

    const cancelledRunIds: string[] = [];
    const reaper = createStaleRunReaper({
      anthropicClient: client,
      cancelRun: async (runId) => {
        cancelledRunIds.push(runId);
        db.setRunStatus(runId, "aborted");
        return "cancelled";
      },
      config: { requiresActionStaleMs: 10 * 60 * 1_000 },
      db,
      now: () => NOW,
      runEvents,
    });

    const summary = await reaper.reapOnce();

    expect(summary.cancelled).toBe(1);
    expect(summary.recovered).toBe(0);
    expect(cancelledRunIds).toEqual([RUN_ID]);
    expect(getDbStatus(db)).toBe("aborted");
    expect(calls.sends).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
  });

  test("defers manual recovery when active cancellation times out", async () => {
    const db = createDbModule(":memory:");
    openDbs.push(db);
    const runEvents = createRunEventsModule({ db });
    const toolUse = createCustomToolUseEvent("evt-tool-timeout");
    const { calls, client } = createFakeClient({
      [SESSION_ID]: [
        createRequiresActionIdleEvent("evt-idle-timeout", [toolUse.id], OLD_PROCESSED_AT),
        toolUse,
      ],
    });
    seedRunningRun(db);

    const reaper = createStaleRunReaper({
      anthropicClient: client,
      cancelRun: async () => "timed_out",
      config: { requiresActionStaleMs: 10 * 60 * 1_000 },
      db,
      now: () => NOW,
      runEvents,
    });

    const summary = await reaper.reapOnce();

    expect(summary).toMatchObject({ recovered: 0, skipped: 1, staleRequiresAction: 1 });
    expect(getDbStatus(db)).toBe("running");
    expect(calls.sends).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
  });

  test("ignores terminal idle sessions", async () => {
    const { calls, db, reaper } = createHarness([createIdleEvent("evt-idle-done")]);

    const summary = await reaper.reapOnce();

    expect(summary.staleRequiresAction).toBe(0);
    expect(getDbStatus(db)).toBe("running");
    expect(calls.sends).toHaveLength(0);
  });
});

describe("parseStaleRunReaperConfigFromEnv", () => {
  test("parses env overrides", () => {
    expect(
      parseStaleRunReaperConfigFromEnv({
        STALE_RUN_REAPER_ENABLED: "false",
        STALE_RUN_REAPER_INTERVAL_SECONDS: "30",
        STALE_RUN_REAPER_REQUIRES_ACTION_STALE_SECONDS: "120",
      }),
    ).toMatchObject({
      enabled: false,
      intervalMs: 30_000,
      requiresActionStaleMs: 120_000,
    });
  });
});
