import { describe, expect, test } from "bun:test";

import {
  type Clock,
  type DbReader,
  findRunByIssueRepo,
  type ProcessControl,
  type SessionStatus,
  type StopSessionClient,
  stopRun,
  stopRunByIssueRepo,
} from "@/features/run-stop/handler";
import type { RunState } from "@/shared/types";

function createRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    branch: "agent/issue-42/test",
    issueNumber: 42,
    pid: 12_345,
    repo: "acme/widgets",
    runId: "run-1",
    sessionIds: [],
    startedAt: "2026-04-24T10:00:00.000Z",
    subIssues: [],
    ...overrides,
  };
}

function createDbReader(runs: RunState[]): DbReader {
  return {
    getRunById(runId) {
      return runs.find((run) => run.runId === runId) ?? null;
    },
    getRunsByRepo(repo) {
      return runs.filter((run) => run.repo === repo);
    },
  };
}

function createSyntheticClock(): Clock {
  let currentTimeMs = 0;
  return {
    now: () => currentTimeMs,
    wait: async (ms) => {
      currentTimeMs += ms;
    },
  };
}

type FakeProcessControl = ProcessControl & {
  sigtermCalls: number[];
};

function createProcessControl(opts: {
  initialAlive: boolean;
  diesAfterSignals?: number;
}): FakeProcessControl {
  let alive = opts.initialAlive;
  const sigtermCalls: number[] = [];
  let signalsRemaining = opts.diesAfterSignals ?? 0;

  return {
    isAlive() {
      const wasAlive = alive;
      if (alive && signalsRemaining > 0) {
        signalsRemaining -= 1;
        if (signalsRemaining === 0) {
          alive = false;
        }
      }
      return wasAlive;
    },
    sendTerm(pid) {
      sigtermCalls.push(pid);
    },
    sigtermCalls,
  };
}

type RetrieveOutcome = SessionStatus | null | "not_found" | "error";

type FakeSessionClient = StopSessionClient & {
  retrieveCalls: string[];
  archiveCalls: string[];
};

function createSessionClient(opts: {
  statuses?: Record<string, RetrieveOutcome>;
  archiveErrors?: readonly string[];
}): FakeSessionClient {
  const retrieveCalls: string[] = [];
  const archiveCalls: string[] = [];
  const archiveErrors = new Set(opts.archiveErrors ?? []);

  return {
    archiveCalls,
    retrieveCalls,
    beta: {
      sessions: {
        async retrieve(sessionId) {
          retrieveCalls.push(sessionId);
          const value = opts.statuses?.[sessionId];

          if (value === "not_found") {
            const err = new Error("not found") as Error & { status: number };
            err.status = 404;
            throw err;
          }

          if (value === "error") {
            throw new Error("transport error");
          }

          return { status: value ?? "terminated" };
        },
        async archive(sessionId) {
          archiveCalls.push(sessionId);
          if (archiveErrors.has(sessionId)) {
            throw new Error("archive failed");
          }
          return {};
        },
      },
    },
  };
}

describe("findRunByIssueRepo", () => {
  test("returns the run with the most recent startedAt when multiple runs match", () => {
    const runs = [
      createRunState({
        prUrl: "https://github.com/acme/widgets/pull/1",
        runId: "older",
        startedAt: "2026-04-23T10:00:00.000Z",
      }),
      createRunState({
        runId: "newer",
        startedAt: "2026-04-24T10:00:00.000Z",
      }),
    ];
    const db = createDbReader(runs);

    const result = findRunByIssueRepo(
      { issueNumber: 42, repo: { name: "widgets", owner: "acme" } },
      db,
    );

    expect(result?.runId).toBe("newer");
  });

  test("returns null when no runs match the issue/repo", () => {
    const db = createDbReader([createRunState({ issueNumber: 99 })]);

    const result = findRunByIssueRepo(
      { issueNumber: 42, repo: { name: "widgets", owner: "acme" } },
      db,
    );

    expect(result).toBeNull();
  });

  test("returns the most recent run even when all are finalized with prUrl", () => {
    const runs = [
      createRunState({
        prUrl: "https://github.com/acme/widgets/pull/1",
        runId: "first",
        startedAt: "2026-04-22T10:00:00.000Z",
      }),
      createRunState({
        prUrl: "https://github.com/acme/widgets/pull/2",
        runId: "second",
        startedAt: "2026-04-24T10:00:00.000Z",
      }),
    ];
    const db = createDbReader(runs);

    const result = findRunByIssueRepo(
      { issueNumber: 42, repo: { name: "widgets", owner: "acme" } },
      db,
    );

    expect(result?.runId).toBe("second");
  });
});

describe("stopRun", () => {
  test("returns not_stopped/not_found when run does not exist", async () => {
    const db = createDbReader([]);

    const outcome = await stopRun("missing", { db });

    expect(outcome).toEqual({ reason: "not_found", status: "not_stopped" });
  });

  test("returns not_stopped/already_completed when prUrl is set and nothing is alive", async () => {
    const run = createRunState({ prUrl: "https://github.com/acme/widgets/pull/1" });
    const db = createDbReader([run]);
    const processControl = createProcessControl({ initialAlive: false });

    const outcome = await stopRun(run.runId, { db, processControl });

    expect(outcome).toEqual({
      reason: "already_completed",
      runId: run.runId,
      status: "not_stopped",
    });
  });

  test("returns not_stopped/pid_missing when pid is undefined and no live sessions", async () => {
    const run = createRunState({ pid: undefined });
    const db = createDbReader([run]);

    const outcome = await stopRun(run.runId, { db });

    expect(outcome).toEqual({ reason: "pid_missing", runId: run.runId, status: "not_stopped" });
  });

  test("returns not_stopped/process_not_running when the pid is dead and no live sessions", async () => {
    const run = createRunState();
    const db = createDbReader([run]);
    const processControl = createProcessControl({ initialAlive: false });

    const outcome = await stopRun(run.runId, { db, processControl });

    expect(outcome).toEqual({
      reason: "process_not_running",
      runId: run.runId,
      status: "not_stopped",
    });
    expect(processControl.sigtermCalls).toEqual([]);
  });

  test("sends SIGTERM and returns stopped when the process exits within the deadline", async () => {
    const run = createRunState();
    const db = createDbReader([run]);
    const processControl = createProcessControl({ diesAfterSignals: 3, initialAlive: true });

    const outcome = await stopRun(run.runId, {
      clock: createSyntheticClock(),
      db,
      maxWaitMs: 5_000,
      pollIntervalMs: 100,
      processControl,
    });

    expect(outcome).toEqual({ runId: run.runId, status: "stopped" });
    expect(processControl.sigtermCalls).toEqual([12_345]);
  });

  test("returns still_running_after_signal if the process refuses to exit", async () => {
    const run = createRunState();
    const db = createDbReader([run]);
    const processControl = createProcessControl({ initialAlive: true });

    const outcome = await stopRun(run.runId, {
      clock: createSyntheticClock(),
      db,
      maxWaitMs: 1_000,
      pollIntervalMs: 100,
      processControl,
    });

    expect(outcome).toEqual({
      reason: "still_running_after_signal",
      runId: run.runId,
      status: "not_stopped",
    });
    expect(processControl.sigtermCalls).toEqual([12_345]);
  });

  test("archives live sessions and returns stopped when prUrl is set but a session is still running", async () => {
    const run = createRunState({
      prUrl: "https://github.com/acme/widgets/pull/1",
      sessionIds: ["sesn_live", "sesn_done"],
    });
    const db = createDbReader([run]);
    const processControl = createProcessControl({ initialAlive: false });
    const sessionClient = createSessionClient({
      statuses: { sesn_done: "terminated", sesn_live: "running" },
    });

    const outcome = await stopRun(run.runId, {
      db,
      processControl,
      sessionClient,
    });

    expect(outcome).toEqual({ runId: run.runId, status: "stopped" });
    expect([...sessionClient.retrieveCalls].sort()).toEqual(["sesn_done", "sesn_live"]);
    expect(sessionClient.archiveCalls).toEqual(["sesn_live"]);
    expect(processControl.sigtermCalls).toEqual([]);
  });

  test("treats sessions that return 404 as terminated", async () => {
    const run = createRunState({
      pid: undefined,
      prUrl: "https://github.com/acme/widgets/pull/1",
      sessionIds: ["sesn_missing"],
    });
    const db = createDbReader([run]);
    const sessionClient = createSessionClient({
      statuses: { sesn_missing: "not_found" },
    });

    const outcome = await stopRun(run.runId, { db, sessionClient });

    expect(outcome).toEqual({
      reason: "already_completed",
      runId: run.runId,
      status: "not_stopped",
    });
    expect(sessionClient.archiveCalls).toEqual([]);
  });

  test("treats retrieve transport errors as live and attempts archive", async () => {
    const run = createRunState({
      sessionIds: ["sesn_flaky"],
    });
    const db = createDbReader([run]);
    const processControl = createProcessControl({ initialAlive: false });
    const sessionClient = createSessionClient({
      statuses: { sesn_flaky: "error" },
    });

    const outcome = await stopRun(run.runId, {
      db,
      processControl,
      sessionClient,
    });

    expect(outcome).toEqual({ runId: run.runId, status: "stopped" });
    expect(sessionClient.archiveCalls).toEqual(["sesn_flaky"]);
  });

  test("returns stopped even when archive fails (best-effort)", async () => {
    const run = createRunState({
      sessionIds: ["sesn_bad"],
    });
    const db = createDbReader([run]);
    const processControl = createProcessControl({ initialAlive: false });
    const sessionClient = createSessionClient({
      archiveErrors: ["sesn_bad"],
      statuses: { sesn_bad: "running" },
    });

    const outcome = await stopRun(run.runId, {
      db,
      processControl,
      sessionClient,
    });

    expect(outcome).toEqual({ runId: run.runId, status: "stopped" });
    expect(sessionClient.archiveCalls).toEqual(["sesn_bad"]);
  });

  test("stops both local pid and remote sessions when both are alive", async () => {
    const run = createRunState({
      sessionIds: ["sesn_alive"],
    });
    const db = createDbReader([run]);
    const processControl = createProcessControl({ diesAfterSignals: 1, initialAlive: true });
    const sessionClient = createSessionClient({
      statuses: { sesn_alive: "idle" },
    });

    const outcome = await stopRun(run.runId, {
      clock: createSyntheticClock(),
      db,
      maxWaitMs: 1_000,
      pollIntervalMs: 100,
      processControl,
      sessionClient,
    });

    expect(outcome).toEqual({ runId: run.runId, status: "stopped" });
    expect(processControl.sigtermCalls).toEqual([12_345]);
    expect(sessionClient.archiveCalls).toEqual(["sesn_alive"]);
  });
});

describe("stopRunByIssueRepo", () => {
  test("returns not_found when no run matches", async () => {
    const db = createDbReader([]);

    const outcome = await stopRunByIssueRepo(
      { issueNumber: 42, repo: { name: "widgets", owner: "acme" } },
      { db },
    );

    expect(outcome).toEqual({ reason: "not_found", status: "not_stopped" });
  });

  test("delegates to stopRun for the most recent matching run", async () => {
    const run = createRunState({ runId: "target" });
    const db = createDbReader([run]);
    const processControl = createProcessControl({ diesAfterSignals: 1, initialAlive: true });

    const outcome = await stopRunByIssueRepo(
      { issueNumber: 42, repo: { name: "widgets", owner: "acme" } },
      {
        clock: createSyntheticClock(),
        db,
        maxWaitMs: 1_000,
        pollIntervalMs: 100,
        processControl,
      },
    );

    expect(outcome).toEqual({ runId: "target", status: "stopped" });
    expect(processControl.sigtermCalls).toEqual([12_345]);
  });
});
