import type { Logger } from "pino";

export type SseEventInput = {
  data: unknown;
  event?: string;
  id?: string;
};

export type HeartbeatEvent = { __heartbeat: true };

type IndexedIteratorResult<T> = {
  index: number;
  result: IteratorResult<T>;
};

type AbortableDelay = {
  cancel: () => void;
  promise: Promise<"aborted" | "heartbeat">;
};

type QueueWaiter<T> = (result: IteratorResult<T>) => void;

class DynamicQueue<T> implements AsyncIterableIterator<T> {
  #buffer: T[] = [];
  #closed = false;
  #waiters: Array<QueueWaiter<T>> = [];

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

export type DynamicMerger<T> = {
  addStream(stream: AsyncIterable<T>, label?: string): void;
  asyncIterable: AsyncIterable<T>;
  close(): void;
};

export type DynamicMergerOptions = {
  logger?: Pick<Logger, "warn">;
  signal: AbortSignal;
};

/**
 * Stream merger that supports adding new sources at any time, even after iteration starts.
 *
 * Each added stream is consumed concurrently and its values are forwarded to a single
 * shared queue. The merger stays open until `close()` is called or the abort signal fires;
 * streams that finish on their own do not close the merger, so newly added streams keep
 * working until cancellation.
 *
 * On close (or abort), each active source iterator's `return()` is invoked so that
 * generators clean up resources (e.g. unregister subscribers, close DB cursors).
 */
export function createDynamicMerger<T>(options: DynamicMergerOptions): DynamicMerger<T> {
  const queue = new DynamicQueue<T>();
  const activeIterators = new Set<AsyncIterator<T>>();
  let closed = false;

  const returnIterator = async (iterator: AsyncIterator<T>): Promise<void> => {
    try {
      await iterator.return?.();
    } catch (error) {
      options.logger?.warn({ err: error }, "dynamic merger iterator return failed");
    }
  };

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    queue.close();

    const iterators = [...activeIterators];
    activeIterators.clear();
    for (const iterator of iterators) {
      void returnIterator(iterator);
    }
  };

  if (options.signal.aborted) {
    close();
  } else {
    options.signal.addEventListener("abort", close, { once: true });
  }

  const addStream = (stream: AsyncIterable<T>, label?: string): void => {
    if (closed) {
      return;
    }

    const iterator = stream[Symbol.asyncIterator]();
    activeIterators.add(iterator);

    void (async () => {
      try {
        while (!closed) {
          const result = await iterator.next();
          if (result.done === true) {
            return;
          }
          if (closed) {
            return;
          }
          queue.push(result.value);
        }
      } catch (error) {
        if (!options.signal.aborted) {
          options.logger?.warn({ err: error, label }, "dynamic merger source stream errored");
        }
      } finally {
        activeIterators.delete(iterator);
      }
    })();
  };

  return {
    addStream,
    asyncIterable: {
      [Symbol.asyncIterator]() {
        return queue[Symbol.asyncIterator]();
      },
    },
    close,
  };
}

export function formatSseEvent(input: SseEventInput): string {
  const lines: string[] = [];

  if (input.id !== undefined) {
    lines.push(`id: ${input.id}`);
  }

  if (input.event !== undefined) {
    lines.push(`event: ${input.event}`);
  }

  lines.push(`data: ${JSON.stringify(input.data)}`);

  return `${lines.join("\n")}\n\n`;
}

export async function* mergeAsyncIterables<T>(...streams: AsyncIterable<T>[]): AsyncIterable<T> {
  const iterators = streams.map((stream) => stream[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<IndexedIteratorResult<T>>>();

  const queueNext = (index: number): void => {
    const iterator = iterators[index];
    if (iterator === undefined) {
      return;
    }

    pending.set(
      index,
      iterator.next().then((result) => ({ index, result })),
    );
  };

  try {
    for (const index of iterators.keys()) {
      queueNext(index);
    }

    while (pending.size > 0) {
      const { index, result } = await Promise.race(pending.values());
      pending.delete(index);

      if (result.done === true) {
        continue;
      }

      yield result.value;
      queueNext(index);
    }
  } finally {
    await Promise.allSettled(
      iterators.map(async (iterator) => {
        await iterator.return?.();
      }),
    );
  }
}

function createHeartbeatDelay(intervalMs: number, signal: AbortSignal): AbortableDelay {
  let abortListener: (() => void) | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<"aborted" | "heartbeat">((resolve) => {
    if (signal.aborted) {
      resolve("aborted");
      return;
    }

    abortListener = () => resolve("aborted");
    signal.addEventListener("abort", abortListener, { once: true });
    timeoutHandle = setTimeout(() => resolve("heartbeat"), Math.max(0, intervalMs));
  });

  return {
    cancel() {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }

      if (abortListener !== undefined) {
        signal.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
    },
    promise,
  };
}

export async function* withHeartbeat<T>(
  stream: AsyncIterable<T>,
  intervalMs: number,
  signal: AbortSignal,
): AsyncIterable<T | HeartbeatEvent> {
  const iterator = stream[Symbol.asyncIterator]();
  let pendingNext = iterator.next();

  try {
    while (!signal.aborted) {
      const heartbeatDelay = createHeartbeatDelay(intervalMs, signal);

      try {
        const winner = await Promise.race([
          pendingNext.then((result) => ({ result, type: "event" }) as const),
          heartbeatDelay.promise.then((type) => ({ type }) as const),
        ]);

        if (winner.type !== "event") {
          if (winner.type === "heartbeat") {
            yield { __heartbeat: true };
            continue;
          }

          return;
        }

        if (winner.result.done === true) {
          return;
        }

        yield winner.result.value;
        pendingNext = iterator.next();
      } finally {
        heartbeatDelay.cancel();
      }
    }
  } finally {
    await iterator.return?.();
  }
}
