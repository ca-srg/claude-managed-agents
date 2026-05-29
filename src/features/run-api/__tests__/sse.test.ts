import { describe, expect, test } from "bun:test";

import {
  createDynamicMerger,
  formatSseEvent,
  mergeAsyncIterables,
  withHeartbeat,
} from "@/features/run-api/sse";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function* delayedValues<T>(values: Array<{ delayMs: number; value: T }>): AsyncIterable<T> {
  for (const item of values) {
    await sleep(item.delayMs);
    yield item.value;
  }
}

function createNeverIterable<T>(): AsyncIterable<T> {
  let pendingResolve: ((result: IteratorResult<T>) => void) | undefined;

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          return new Promise((resolve) => {
            pendingResolve = resolve;
          });
        },
        async return(): Promise<IteratorResult<T>> {
          pendingResolve?.({ done: true, value: undefined });
          return { done: true, value: undefined };
        },
      };
    },
  };
}

type ControllableIterable<T> = {
  iterable: AsyncIterable<T>;
  push(value: T): void;
  end(): void;
  returnCalled(): boolean;
};

function createControllableIterable<T>(): ControllableIterable<T> {
  const buffer: IteratorResult<T>[] = [];
  let waiter: ((result: IteratorResult<T>) => void) | undefined;
  let ended = false;
  let returnCalled = false;

  const dispatchOrBuffer = (result: IteratorResult<T>): void => {
    if (waiter !== undefined) {
      const resolve = waiter;
      waiter = undefined;
      resolve(result);
      return;
    }
    buffer.push(result);
  };

  return {
    end() {
      ended = true;
      dispatchOrBuffer({ done: true, value: undefined });
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            if (buffer.length > 0) {
              return Promise.resolve(buffer.shift() as IteratorResult<T>);
            }
            if (ended) {
              return Promise.resolve({ done: true, value: undefined });
            }
            return new Promise<IteratorResult<T>>((resolve) => {
              waiter = resolve;
            });
          },
          async return(): Promise<IteratorResult<T>> {
            returnCalled = true;
            ended = true;
            if (waiter !== undefined) {
              const resolve = waiter;
              waiter = undefined;
              resolve({ done: true, value: undefined });
            }
            return { done: true, value: undefined };
          },
        };
      },
    },
    push(value: T) {
      dispatchOrBuffer({ done: false, value });
    },
    returnCalled() {
      return returnCalled;
    },
  };
}

describe("SSE helpers", () => {
  test("formatSseEvent formats id, event, and JSON data", () => {
    expect(formatSseEvent({ data: { phase: "preflight" }, event: "phase", id: "evt-1" })).toBe(
      'id: evt-1\nevent: phase\ndata: {"phase":"preflight"}\n\n',
    );
  });

  test("formatSseEvent omits optional id and event fields", () => {
    expect(formatSseEvent({ data: { ok: true } })).toBe('data: {"ok":true}\n\n');
  });

  test("mergeAsyncIterables yields whichever source is ready next", async () => {
    const merged = mergeAsyncIterables(
      delayedValues([
        { delayMs: 20, value: "a-1" },
        { delayMs: 20, value: "a-2" },
      ]),
      delayedValues([
        { delayMs: 5, value: "b-1" },
        { delayMs: 20, value: "b-2" },
      ]),
    );

    const values: string[] = [];
    for await (const value of merged) {
      values.push(value);
    }

    expect(values).toEqual(["b-1", "a-1", "b-2", "a-2"]);
  });

  test("withHeartbeat emits heartbeat comments at the configured interval", async () => {
    const abortController = new AbortController();
    const iterator = withHeartbeat(createNeverIterable<string>(), 5, abortController.signal)[
      Symbol.asyncIterator
    ]();

    const first = await iterator.next();
    expect(first).toEqual({ done: false, value: { __heartbeat: true } });

    abortController.abort();
    await iterator.return?.();
  });

  test("createDynamicMerger forwards values from initial streams in arrival order", async () => {
    const a = createControllableIterable<string>();
    const b = createControllableIterable<string>();
    const abortController = new AbortController();
    const merger = createDynamicMerger<string>({ signal: abortController.signal });

    merger.addStream(a.iterable, "a");
    merger.addStream(b.iterable, "b");

    a.push("a-1");
    b.push("b-1");
    a.push("a-2");

    const iterator = merger.asyncIterable[Symbol.asyncIterator]();
    const first = await iterator.next();
    const second = await iterator.next();
    const third = await iterator.next();

    expect([first.value, second.value, third.value]).toEqual(["a-1", "b-1", "a-2"]);

    abortController.abort();
    await iterator.return?.();
  });

  test("createDynamicMerger picks up streams added after iteration starts", async () => {
    const a = createControllableIterable<string>();
    const b = createControllableIterable<string>();
    const abortController = new AbortController();
    const merger = createDynamicMerger<string>({ signal: abortController.signal });

    merger.addStream(a.iterable, "a");
    const iterator = merger.asyncIterable[Symbol.asyncIterator]();

    a.push("a-1");
    const first = await iterator.next();
    expect(first.value).toBe("a-1");

    // 後から追加された stream の値も merger 経由で受け取れる
    merger.addStream(b.iterable, "b");
    b.push("b-1");
    const second = await iterator.next();
    expect(second.value).toBe("b-1");

    abortController.abort();
    await iterator.return?.();
  });

  test("createDynamicMerger calls return() on every active iterator when aborted", async () => {
    const a = createControllableIterable<string>();
    const b = createControllableIterable<string>();
    const abortController = new AbortController();
    const merger = createDynamicMerger<string>({ signal: abortController.signal });

    merger.addStream(a.iterable, "a");
    merger.addStream(b.iterable, "b");

    // pending 状態を作るために 1 つだけ消費
    a.push("a-1");
    const iterator = merger.asyncIterable[Symbol.asyncIterator]();
    await iterator.next();

    abortController.abort();

    // signal の abort が伝播するまで microtask を流す
    await sleep(0);

    expect(a.returnCalled()).toBe(true);
    expect(b.returnCalled()).toBe(true);

    const finalResult = await iterator.next();
    expect(finalResult).toEqual({ done: true, value: undefined });
  });
});
