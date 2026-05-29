import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { createDbModule } from "@/shared/persistence/db";
import type { RunEvent } from "@/shared/types";

export { LIVE_TAIL_HEARTBEAT_INTERVAL_MS, LIVE_TAIL_HISTORY_PAGE_SIZE } from "./constants";

type DbModule = Pick<ReturnType<typeof createDbModule>, "insertRunEvent" | "listRunEvents">;

type RunEventsModuleDependencies = {
  db: DbModule;
  logger?: Logger;
};

type EmitRunEventInput = Omit<RunEvent, "id" | "runId" | "ts"> & {
  id?: string;
  ts?: string;
};

type SubscribeOptions = {
  fromEventId?: string;
  signal?: AbortSignal;
};

type LoadHistoryOptions = {
  fromEventId?: string;
  limit?: number;
};

type BunUuidApi = {
  randomUUIDv7?: () => string;
};

type QueueWaiter<T> = (result: IteratorResult<T>) => void;

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  #buffer: T[] = [];
  #closed = false;
  #waiters: Array<QueueWaiter<T>> = [];

  get closed(): boolean {
    return this.#closed;
  }

  push(value: T): boolean {
    if (this.#closed) {
      return false;
    }

    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value });
      return true;
    }

    this.#buffer.push(value);
    return true;
  }

  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    this.#buffer = [];

    for (const waiter of this.#waiters) {
      waiter({ done: true, value: undefined });
    }
    this.#waiters = [];
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.#buffer.length > 0) {
      return { done: false, value: this.#buffer.shift() as T };
    }

    if (this.#closed) {
      return { done: true, value: undefined };
    }

    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  async return(): Promise<IteratorResult<T>> {
    this.close();
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function createRunEventId(): string {
  const maybeBun = globalThis as typeof globalThis & { Bun?: BunUuidApi };
  const uuidv7 = maybeBun.Bun?.randomUUIDv7;

  if (uuidv7 !== undefined) {
    return uuidv7();
  }

  return `${Date.now().toString().padStart(13, "0")}-${randomUUID()}`;
}

function shouldYieldEvent(
  event: RunEvent,
  seenEventIds: Set<string>,
  fromEventId: string | undefined,
): boolean {
  if (seenEventIds.has(event.id)) {
    return false;
  }

  if (fromEventId !== undefined && event.id <= fromEventId) {
    return false;
  }

  seenEventIds.add(event.id);
  return true;
}

export function createRunEventsModule(deps: RunEventsModuleDependencies) {
  const subscribers = new Map<string, Set<AsyncQueue<RunEvent>>>();
  let closed = false;

  function register(runId: string, queue: AsyncQueue<RunEvent>): void {
    let queues = subscribers.get(runId);
    if (queues === undefined) {
      queues = new Set();
      subscribers.set(runId, queues);
    }
    queues.add(queue);
  }

  function unregister(runId: string, queue: AsyncQueue<RunEvent>): void {
    const queues = subscribers.get(runId);
    if (queues === undefined) {
      return;
    }

    queues.delete(queue);
    if (queues.size === 0) {
      subscribers.delete(runId);
    }
  }

  function fanOut(runId: string, event: RunEvent): void {
    const queues = subscribers.get(runId);
    if (queues === undefined) {
      return;
    }

    for (const queue of [...queues]) {
      if (!queue.push(event)) {
        queues.delete(queue);
      }
    }

    if (queues.size === 0) {
      subscribers.delete(runId);
    }
  }

  function loadHistory(runId: string, opts: LoadHistoryOptions = {}): RunEvent[] {
    return deps.db.listRunEvents({
      fromEventId: opts.fromEventId,
      limit: opts.limit,
      runId,
    });
  }

  function emit(runId: string, event: EmitRunEventInput): RunEvent {
    const runEvent: RunEvent = {
      id: event.id ?? createRunEventId(),
      kind: event.kind,
      payload: event.payload,
      runId,
      ts: event.ts ?? new Date().toISOString(),
    };

    deps.db.insertRunEvent(runEvent);

    if (!closed) {
      fanOut(runId, runEvent);
    }

    return runEvent;
  }

  function subscribe(runId: string, opts: SubscribeOptions = {}): AsyncIterable<RunEvent> {
    return {
      async *[Symbol.asyncIterator]() {
        const seenEventIds = new Set<string>();
        let watermark = opts.fromEventId;
        let queue: AsyncQueue<RunEvent> | undefined;
        let abortListener: (() => void) | undefined;

        try {
          for (const historyEvent of loadHistory(runId, { fromEventId: opts.fromEventId })) {
            if (opts.signal?.aborted) {
              return;
            }
            watermark = historyEvent.id;
            if (shouldYieldEvent(historyEvent, seenEventIds, opts.fromEventId)) {
              yield historyEvent;
            }
          }

          if (closed || opts.signal?.aborted) {
            return;
          }

          queue = new AsyncQueue<RunEvent>();
          register(runId, queue);

          abortListener = () => {
            queue?.close();
          };
          opts.signal?.addEventListener("abort", abortListener, { once: true });

          if (opts.signal?.aborted) {
            return;
          }

          for (const catchUpEvent of loadHistory(runId, { fromEventId: watermark })) {
            if (opts.signal?.aborted) {
              return;
            }
            if (shouldYieldEvent(catchUpEvent, seenEventIds, opts.fromEventId)) {
              yield catchUpEvent;
            }
          }

          for await (const liveEvent of queue) {
            if (opts.signal?.aborted) {
              return;
            }
            if (shouldYieldEvent(liveEvent, seenEventIds, opts.fromEventId)) {
              yield liveEvent;
            }
          }
        } catch (error) {
          deps.logger?.warn({ err: error, runId }, "run events subscription failed");
          throw error;
        } finally {
          if (abortListener !== undefined) {
            opts.signal?.removeEventListener("abort", abortListener);
          }
          if (queue !== undefined) {
            unregister(runId, queue);
            queue.close();
          }
        }
      },
    };
  }

  function close(): void {
    if (closed) {
      return;
    }

    closed = true;
    for (const queues of subscribers.values()) {
      for (const queue of queues) {
        queue.close();
      }
    }
    subscribers.clear();
  }

  return {
    close,
    emit,
    loadHistory,
    subscribe,
  };
}
