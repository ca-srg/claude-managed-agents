import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDbModule } from "@/shared/persistence/db";
import { createRunEventsModule } from "@/shared/run-events";
import type { RunEvent, RunState } from "@/shared/types";

type DbModule = ReturnType<typeof createDbModule>;
type RunEventsModule = ReturnType<typeof createRunEventsModule>;

const RUN_ID = "run-events-test";
const PENDING_TIMEOUT_MS = 25;

function createRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    branch: "feature/run-events",
    issueNumber: 42,
    repo: "acme/widgets",
    runId: RUN_ID,
    sessionIds: [],
    startedAt: "2026-04-24T10:00:00.000Z",
    subIssues: [],
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQueueRegistration(): Promise<void> {
  await Promise.resolve();
}

async function expectNextValue(
  iterator: AsyncIterator<RunEvent>,
  expected: RunEvent,
): Promise<void> {
  await expect(iterator.next()).resolves.toEqual({ done: false, value: expected });
}

async function expectNextDone(iterator: AsyncIterator<RunEvent>): Promise<void> {
  await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
}

async function expectPromisePending<T>(promise: Promise<T>): Promise<void> {
  const state = await Promise.race([
    promise.then(() => "resolved" as const),
    delay(PENDING_TIMEOUT_MS).then(() => "pending" as const),
  ]);

  expect(state).toBe("pending");
}

describe("createRunEventsModule", () => {
  let db: DbModule;
  let runEvents: RunEventsModule;

  beforeEach(() => {
    db = createDbModule(":memory:");
    db.initDb();
    db.insertRun(createRunState());
    runEvents = createRunEventsModule({ db });
  });

  afterEach(() => {
    runEvents.close();
    db.close();
  });

  test("live stream subscriber receives event emitted after subscription", async () => {
    const iterator = runEvents.subscribe(RUN_ID)[Symbol.asyncIterator]();
    const pending = iterator.next();
    await waitForQueueRegistration();

    const event = runEvents.emit(RUN_ID, {
      id: "00000000-0000-7000-8000-000000000001",
      kind: "log",
      payload: { message: "live" },
      ts: "2026-04-24T10:00:01.000Z",
    });

    await expect(pending).resolves.toEqual({ done: false, value: event });
    await iterator.return?.();
  });

  test("subscribe without fromEventId replays a persisted event", async () => {
    const event = runEvents.emit(RUN_ID, {
      id: "00000000-0000-7000-8000-000000000011",
      kind: "phase",
      payload: { phase: "preflight" },
      ts: "2026-04-24T10:00:11.000Z",
    });

    const iterator = runEvents.subscribe(RUN_ID)[Symbol.asyncIterator]();

    await expectNextValue(iterator, event);
    await iterator.return?.();
  });

  test("fromEventId resume replays later events then waits for live events", async () => {
    const a = runEvents.emit(RUN_ID, {
      id: "00000000-0000-7000-8000-000000000101",
      kind: "log",
      payload: { message: "a" },
      ts: "2026-04-24T10:01:01.000Z",
    });
    const b = runEvents.emit(RUN_ID, {
      id: "00000000-0000-7000-8000-000000000102",
      kind: "log",
      payload: { message: "b" },
      ts: "2026-04-24T10:01:02.000Z",
    });
    const c = runEvents.emit(RUN_ID, {
      id: "00000000-0000-7000-8000-000000000103",
      kind: "log",
      payload: { message: "c" },
      ts: "2026-04-24T10:01:03.000Z",
    });

    const iterator = runEvents.subscribe(RUN_ID, { fromEventId: a.id })[Symbol.asyncIterator]();

    await expectNextValue(iterator, b);
    await expectNextValue(iterator, c);

    const pending = iterator.next();
    await expectPromisePending(pending);
    runEvents.close();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  test("multiple subscribers fan-out receives the same live event", async () => {
    const first = runEvents.subscribe(RUN_ID)[Symbol.asyncIterator]();
    const second = runEvents.subscribe(RUN_ID)[Symbol.asyncIterator]();
    const firstPending = first.next();
    const secondPending = second.next();
    await waitForQueueRegistration();

    const event = runEvents.emit(RUN_ID, {
      id: "00000000-0000-7000-8000-000000000201",
      kind: "session",
      payload: { sessionId: "session-1" },
      ts: "2026-04-24T10:02:01.000Z",
    });

    await expect(firstPending).resolves.toEqual({ done: false, value: event });
    await expect(secondPending).resolves.toEqual({ done: false, value: event });
    await first.return?.();
    await second.return?.();
  });

  test("close ends all subscribers cleanly", async () => {
    const first = runEvents.subscribe(RUN_ID)[Symbol.asyncIterator]();
    const second = runEvents.subscribe(RUN_ID)[Symbol.asyncIterator]();
    const firstPending = first.next();
    const secondPending = second.next();
    await waitForQueueRegistration();

    runEvents.close();
    runEvents.close();

    await expect(firstPending).resolves.toEqual({ done: true, value: undefined });
    await expect(secondPending).resolves.toEqual({ done: true, value: undefined });
  });

  test("AbortSignal.abort stops the iterator", async () => {
    const controller = new AbortController();
    const iterator = runEvents
      .subscribe(RUN_ID, { signal: controller.signal })
      [Symbol.asyncIterator]();
    const pending = iterator.next();
    await waitForQueueRegistration();

    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expectNextDone(iterator);
  });
});
