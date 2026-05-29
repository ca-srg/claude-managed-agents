import { afterEach, describe, expect, test } from "bun:test";

import { createRunQueueModule, type RunQueueModuleDeps } from "@/features/run-queue/handler";
import type { RunStartInput } from "@/features/run-queue/schemas";
import { createDbModule } from "@/shared/persistence/db";
import { createRunEventsModule } from "@/shared/run-events";
import type { RunState, RunStatus } from "@/shared/types";

type DbModule = ReturnType<typeof createDbModule>;
type RunQueueModule = ReturnType<typeof createRunQueueModule>;

const openDbs: DbModule[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function createRunInput(issue: number, label: string): RunStartInput {
  return {
    configPath: label,
    dryRun: false,
    issue,
    repo: `acme/${label}`,
  };
}

function createRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    branch: "queued/issue-42",
    issueNumber: 42,
    repo: "acme/widgets",
    runId: "run-orphan",
    sessionIds: [],
    startedAt: "2026-04-28T00:00:00.000Z",
    subIssues: [],
    ...overrides,
  };
}

function getDbStatus(db: DbModule, runId: string): RunStatus | null {
  return db.listRuns({ limit: 100 }).find((run) => run.runId === runId)?.status ?? null;
}

function createHarness(executor: RunQueueModuleDeps["executor"]): {
  db: DbModule;
  queue: RunQueueModule;
} {
  const db = createDbModule(":memory:");
  openDbs.push(db);
  const runEvents = createRunEventsModule({ db });
  const queue = createRunQueueModule({ db, executor, runEvents });

  return { db, queue };
}

afterEach(async () => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe("createRunQueueModule", () => {
  test("FIFO order runs jobs one at a time", async () => {
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    const { queue } = createHarness(async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(input.configPath ?? "unknown");
      await sleep(20);
      active -= 1;

      return { aborted: false, runId: input.runId, status: "completed", timedOut: false };
    });

    const first = queue.enqueue(createRunInput(1, "a"));
    const second = queue.enqueue(createRunInput(2, "b"));
    const third = queue.enqueue(createRunInput(3, "c"));

    expect(first.position).toBe(1);
    expect(second.position).toBe(2);
    expect(third.position).toBe(3);

    queue.start();

    await waitFor(() => queue.getStatus(third.runId) === "completed", "third job completion");

    expect(calls).toEqual(["a", "b", "c"]);
    expect(maxActive).toBe(1);
  });

  test("enqueue returns a 1-indexed position when worker is already started", async () => {
    const deferred = createDeferred();
    const { queue } = createHarness(async (input) => {
      await deferred.promise;

      return { aborted: false, runId: input.runId, status: "completed", timedOut: false };
    });

    queue.start();

    const run = queue.enqueue(createRunInput(1, "a"));

    expect(run.position).toBe(1);

    await waitFor(() => queue.getStatus(run.runId) === "running", "started worker running status");

    deferred.resolve();

    await waitFor(() => queue.getStatus(run.runId) === "completed", "started worker completion");
  });

  test("cancel queued removes the job and keeps FIFO for remaining runs", async () => {
    const calls: string[] = [];
    const { queue } = createHarness(async (input) => {
      calls.push(input.configPath ?? "unknown");
      await sleep(10);

      return { aborted: false, runId: input.runId, status: "completed", timedOut: false };
    });

    const first = queue.enqueue(createRunInput(1, "a"));
    const second = queue.enqueue(createRunInput(2, "b"));
    const third = queue.enqueue(createRunInput(3, "c"));

    await expect(queue.cancel(second.runId)).resolves.toBe(true);
    expect(queue.getStatus(second.runId)).toBe("aborted");

    queue.start();

    await waitFor(() => queue.getStatus(third.runId) === "completed", "remaining jobs completion");

    expect(queue.getStatus(first.runId)).toBe("completed");
    expect(queue.getStatus(second.runId)).toBe("aborted");
    expect(calls).toEqual(["a", "c"]);
  });

  test("cancel running aborts the executor and persists aborted status", async () => {
    let executorStarted = false;
    const { queue } = createHarness(async (input) => {
      executorStarted = true;
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) {
          resolve();
          return;
        }

        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });

      return {
        aborted: input.signal.aborted,
        runId: input.runId,
        status: "aborted",
        timedOut: false,
      };
    });

    const run = queue.enqueue(createRunInput(1, "a"));
    queue.start();

    await waitFor(
      () => executorStarted && queue.getStatus(run.runId) === "running",
      "running status",
    );

    await expect(queue.cancel(run.runId)).resolves.toBe(true);

    expect(queue.getStatus(run.runId)).toBe("aborted");
  });

  test("DB state machine persists queued, running, and completed", async () => {
    const deferred = createDeferred();
    const { db, queue } = createHarness(async (input) => {
      await deferred.promise;

      return { aborted: false, runId: input.runId, status: "completed", timedOut: false };
    });

    const run = queue.enqueue(createRunInput(1, "a"));

    expect(getDbStatus(db, run.runId)).toBe("queued");

    queue.start();

    await waitFor(() => getDbStatus(db, run.runId) === "running", "running status in DB");

    deferred.resolve();

    await waitFor(() => getDbStatus(db, run.runId) === "completed", "completed status in DB");
  });

  test("successful executor emits one enriched complete payload with prUrl", async () => {
    const prUrl = "https://github.com/acme/widgets/pull/7";
    const { db, queue } = createHarness(async (input) => ({
      aborted: false,
      prUrl,
      runId: input.runId,
      status: "completed",
      timedOut: false,
    }));

    const run = queue.enqueue(createRunInput(1, "pr-success"));
    queue.start();

    await waitFor(() => getDbStatus(db, run.runId) === "completed", "completed status in DB");

    const completeEvents = db
      .listRunEvents({ limit: 20, runId: run.runId })
      .filter((event) => event.kind === "complete");

    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0]?.payload).toEqual({
      aborted: false,
      prUrl,
      status: "completed",
      timedOut: false,
    });
  });

  test("dry-run executor emits one enriched complete payload with decompositionPlan", async () => {
    const decompositionPlan = { tasks: [{ id: "task-1", title: "Plan task" }] };
    const { db, queue } = createHarness(async (input) => ({
      aborted: false,
      decompositionPlan,
      runId: input.runId,
      status: "completed",
      timedOut: false,
    }));

    const run = queue.enqueue({ ...createRunInput(2, "dry-success"), dryRun: true });
    queue.start();

    await waitFor(() => getDbStatus(db, run.runId) === "completed", "dry-run completed status");

    const completeEvents = db
      .listRunEvents({ limit: 20, runId: run.runId })
      .filter((event) => event.kind === "complete");

    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0]?.payload).toEqual({
      aborted: false,
      decompositionPlan,
      status: "completed",
      timedOut: false,
    });
  });

  test("failed executor results persist status and emit error and complete payloads", async () => {
    const executionError = { message: "executor failed", type: "executor_failed" };
    const decompositionPlan = { tasks: 0 };
    const prUrl = "https://github.com/acme/widgets/pull/1";
    const { db, queue } = createHarness(async (input) => ({
      aborted: false,
      decompositionPlan,
      errored: executionError,
      prUrl,
      runId: input.runId,
      status: "failed",
      timedOut: false,
    }));

    const run = queue.enqueue(createRunInput(1, "a"));
    queue.start();

    await waitFor(() => getDbStatus(db, run.runId) === "failed", "failed status in DB");

    const events = db.listRunEvents({ limit: 20, runId: run.runId });
    const errorEvent = events.find((event) => event.kind === "error");
    const completeEvent = events.find((event) => event.kind === "complete");

    expect(errorEvent?.payload).toEqual(executionError);
    expect(completeEvent?.payload).toEqual({
      aborted: false,
      decompositionPlan,
      errored: executionError,
      prUrl,
      status: "failed",
      timedOut: false,
    });
  });

  test("constructor resync aborts orphaned running rows", () => {
    const db = createDbModule(":memory:");
    openDbs.push(db);
    db.insertRun(createRunState());
    db.setRunStatus("run-orphan", "running");

    expect(getDbStatus(db, "run-orphan")).toBe("running");

    const runEvents = createRunEventsModule({ db });
    createRunQueueModule({
      db,
      executor: async (input) => ({
        aborted: false,
        runId: input.runId,
        status: "completed",
        timedOut: false,
      }),
      runEvents,
    });

    expect(getDbStatus(db, "run-orphan")).toBe("aborted");
  });

  describe("error paths", () => {
    test("error path: executor throw marks run failed and emits error payload", async () => {
      const { db, queue } = createHarness(async () => {
        throw new Error("executor exploded");
      });

      const run = queue.enqueue(createRunInput(1, "throwing"));
      queue.start();

      await waitFor(() => getDbStatus(db, run.runId) === "failed", "failed thrown executor");

      const events = db.listRunEvents({ limit: 20, runId: run.runId });
      const errorEvent = events.find((event) => event.kind === "error");
      const completeEvent = events.find((event) => event.kind === "complete");

      expect(errorEvent?.payload).toEqual({ message: "executor exploded" });
      expect(completeEvent?.payload).toEqual({
        aborted: false,
        errored: { message: "executor exploded" },
        status: "failed",
        timedOut: false,
      });
    });

    test("error path: failed result without error emits fallback payload", async () => {
      const { db, queue } = createHarness(async (input) => ({
        aborted: false,
        runId: input.runId,
        status: "failed",
        timedOut: false,
      }));

      const run = queue.enqueue(createRunInput(1, "fallback-failure"));
      queue.start();

      await waitFor(() => getDbStatus(db, run.runId) === "failed", "fallback failed result");

      const errorEvent = db
        .listRunEvents({ limit: 20, runId: run.runId })
        .find((event) => event.kind === "error");

      expect(errorEvent?.payload).toEqual({ message: "executor returned failed status" });
    });
  });

  describe("race conditions", () => {
    test("race: cancel during enqueue arrives correctly", async () => {
      const { db, queue } = createHarness(async (input) => ({
        aborted: false,
        runId: input.runId,
        status: "completed",
        timedOut: false,
      }));

      const run = queue.enqueue(createRunInput(1, "cancel-while-queued"));

      await expect(queue.cancel(run.runId)).resolves.toBe(true);

      expect(getDbStatus(db, run.runId)).toBe("aborted");
      expect(queue.getStatus(run.runId)).toBe("aborted");
      expect(
        db
          .listRunEvents({ limit: 20, runId: run.runId })
          .filter((event) => event.kind === "phase")
          .map((event) => event.payload),
      ).toEqual([{ phase: "queued" }, { phase: "aborted" }]);
    });

    test("race: cancel during execution aborts the active run", async () => {
      const executorStarted = createDeferred();
      const abortObserved = createDeferred();
      const { db, queue } = createHarness(async (input) => {
        executorStarted.resolve();

        if (!input.signal.aborted) {
          await new Promise<void>((resolve) => {
            input.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }

        abortObserved.resolve();
        return {
          aborted: input.signal.aborted,
          runId: input.runId,
          status: "aborted",
          timedOut: false,
        };
      });

      const run = queue.enqueue(createRunInput(1, "cancel-during-exec"));
      queue.start();
      await executorStarted.promise;

      await expect(queue.cancel(run.runId)).resolves.toBe(true);
      await abortObserved.promise;

      expect(getDbStatus(db, run.runId)).toBe("aborted");
    });

    test("race: queue.stop() with active run waits for completion", async () => {
      const executorStarted = createDeferred();
      const releaseExecutor = createDeferred();
      let stopResolved = false;
      const { db, queue } = createHarness(async (input) => {
        executorStarted.resolve();
        await releaseExecutor.promise;

        return { aborted: false, runId: input.runId, status: "completed", timedOut: false };
      });

      const run = queue.enqueue(createRunInput(1, "graceful-stop"));
      queue.start();
      await executorStarted.promise;

      const stopPromise = queue.stop({ force: false }).then(() => {
        stopResolved = true;
      });

      await Promise.resolve();
      expect(stopResolved).toBe(false);
      expect(getDbStatus(db, run.runId)).toBe("running");

      releaseExecutor.resolve();
      await stopPromise;

      expect(stopResolved).toBe(true);
      expect(getDbStatus(db, run.runId)).toBe("completed");
    });

    test("race: queue.stop({ force: true }) aborts active run", async () => {
      const executorStarted = createDeferred();
      const { db, queue } = createHarness(async (input) => {
        executorStarted.resolve();

        if (!input.signal.aborted) {
          await new Promise<void>((resolve) => {
            input.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }

        throw new Error("executor noticed abort");
      });

      const run = queue.enqueue(createRunInput(1, "force-stop"));
      queue.start();
      await executorStarted.promise;

      await queue.stop({ force: true });

      expect(getDbStatus(db, run.runId)).toBe("aborted");
      expect(
        db.listRunEvents({ limit: 20, runId: run.runId }).find((event) => event.kind === "error"),
      ).toBeUndefined();
    });

    test("race: repeated start and unknown cancel are no-ops", async () => {
      const releaseExecutor = createDeferred();
      const { queue } = createHarness(async (input) => {
        await releaseExecutor.promise;

        return { aborted: false, runId: input.runId, status: "completed", timedOut: false };
      });

      const run = queue.enqueue(createRunInput(1, "idempotent-start"));

      queue.start();
      queue.start();

      await expect(queue.cancel("missing-run")).resolves.toBe(false);

      releaseExecutor.resolve();
      await waitFor(
        () => queue.getStatus(run.runId) === "completed",
        "idempotent start completion",
      );
    });

    test("race: mismatched executor run id is logged but stored run completes", async () => {
      const warnings: unknown[] = [];
      const db = createDbModule(":memory:");
      openDbs.push(db);
      const runEvents = createRunEventsModule({ db });
      const queue = createRunQueueModule({
        db,
        executor: async (input) => ({
          aborted: false,
          runId: `${input.runId}-mismatch`,
          status: "completed",
          timedOut: false,
        }),
        logger: {
          warn(fields: unknown) {
            warnings.push(fields);
          },
        } as RunQueueModuleDeps["logger"],
        runEvents,
      });

      const run = queue.enqueue(createRunInput(1, "mismatch"));
      queue.start();

      await waitFor(() => getDbStatus(db, run.runId) === "completed", "mismatched completion");

      expect(warnings).toEqual([
        expect.objectContaining({ actualRunId: `${run.runId}-mismatch`, expectedRunId: run.runId }),
      ]);
    });
  });
});
