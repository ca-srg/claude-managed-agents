import { describe, expect, test } from "bun:test";

import { createCleanupRegistry } from "../signals";

type CleanupEvent = "SIGINT" | "SIGTERM" | "uncaughtException" | "unhandledRejection";

type MockRuntime = {
  addSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  offUnhandledRejection(listener: (reason: unknown) => void): void;
  offUncaughtException(listener: (error: Error) => void): void;
  onUnhandledRejection(listener: (reason: unknown) => void): void;
  onUncaughtException(listener: (error: Error) => void): void;
  removeSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  rethrow(value: unknown): void;
  setExitCode(code: number): void;
};

function createMockLogger() {
  return {
    error: (..._args: unknown[]) => {},
    info: (..._args: unknown[]) => {},
  };
}

function createMockRuntime() {
  const listeners = {
    SIGINT: new Set<() => void>(),
    SIGTERM: new Set<() => void>(),
    uncaughtException: new Set<(error: Error) => void>(),
    unhandledRejection: new Set<(reason: unknown) => void>(),
  };
  let exitCode: number | undefined;
  let rethrownValue: unknown;

  const runtime: MockRuntime = {
    addSignalListener(signal, listener) {
      listeners[signal].add(listener);
    },
    offUnhandledRejection(listener) {
      listeners.unhandledRejection.delete(listener);
    },
    offUncaughtException(listener) {
      listeners.uncaughtException.delete(listener);
    },
    onUnhandledRejection(listener) {
      listeners.unhandledRejection.add(listener);
    },
    onUncaughtException(listener) {
      listeners.uncaughtException.add(listener);
    },
    removeSignalListener(signal, listener) {
      listeners[signal].delete(listener);
    },
    rethrow(value) {
      rethrownValue = value;
    },
    setExitCode(code) {
      exitCode = code;
    },
  };

  function emit(event: "SIGINT"): void;
  function emit(event: "SIGTERM"): void;
  function emit(event: "uncaughtException", error: Error): void;
  function emit(event: "unhandledRejection", reason: unknown): void;
  function emit(event: CleanupEvent, payload?: Error | unknown): void {
    if (event === "SIGINT" || event === "SIGTERM") {
      for (const listener of listeners[event]) {
        listener();
      }

      return;
    }

    if (event === "uncaughtException") {
      if (!(payload instanceof Error)) {
        throw new Error("uncaughtException requires an Error payload");
      }

      for (const listener of listeners.uncaughtException) {
        listener(payload);
      }

      return;
    }

    for (const listener of listeners.unhandledRejection) {
      listener(payload);
    }
  }

  return {
    emit,
    getExitCode: () => exitCode,
    getRethrownValue: () => rethrownValue,
    runtime,
  };
}

describe("createCleanupRegistry", () => {
  test("runs a registered cleanup on simulated SIGINT", async () => {
    const mockRuntime = createMockRuntime();
    let cleanupRuns = 0;
    const registry = createCleanupRegistry({
      logger: createMockLogger(),
      runtime: mockRuntime.runtime,
    });

    registry.register(async () => {
      cleanupRuns += 1;
    });

    mockRuntime.emit("SIGINT");
    await registry.triggerAll();

    expect(cleanupRuns).toBe(1);
    expect(mockRuntime.getExitCode()).toBe(130);
  });

  test("runs multiple cleanups in LIFO order", async () => {
    const mockRuntime = createMockRuntime();
    const callOrder: string[] = [];
    const registry = createCleanupRegistry({
      logger: createMockLogger(),
      runtime: mockRuntime.runtime,
    });

    registry.register(async () => {
      callOrder.push("first");
    });
    registry.register(async () => {
      callOrder.push("second");
    });

    mockRuntime.emit("SIGINT");
    await registry.triggerAll();

    expect(callOrder).toEqual(["second", "first"]);
  });

  test("continues running later cleanups when one cleanup throws", async () => {
    const mockRuntime = createMockRuntime();
    const callOrder: string[] = [];
    const registry = createCleanupRegistry({
      logger: createMockLogger(),
      runtime: mockRuntime.runtime,
    });

    registry.register(async () => {
      callOrder.push("after-error");
    });
    registry.register(async () => {
      throw new Error("cleanup failed");
    });

    mockRuntime.emit("SIGINT");
    await registry.triggerAll();

    expect(callOrder).toEqual(["after-error"]);
  });

  test("enforces the configured timeout for each cleanup and continues draining", async () => {
    const mockRuntime = createMockRuntime();
    const callOrder: string[] = [];
    const registry = createCleanupRegistry({
      logger: createMockLogger(),
      runtime: mockRuntime.runtime,
      timeoutMs: 20,
    });

    registry.register(async () => {
      callOrder.push("fast");
    });
    registry.register(async () => {
      callOrder.push("slow-start");
      await new Promise<void>(() => {});
    });

    const startedAt = Date.now();
    mockRuntime.emit("SIGINT");
    await registry.triggerAll();
    const elapsedMs = Date.now() - startedAt;

    expect(callOrder).toEqual(["slow-start", "fast"]);
    expect(elapsedMs >= 20).toBe(true);
  });

  test("triggerAll sets exit code 0 for a normal cleanup drain", async () => {
    const mockRuntime = createMockRuntime();
    const registry = createCleanupRegistry({
      logger: createMockLogger(),
      runtime: mockRuntime.runtime,
    });

    await registry.triggerAll();

    expect(mockRuntime.getExitCode()).toBe(0);
  });

  test("updates the exit code when SIGINT arrives during a manual cleanup drain", async () => {
    const mockRuntime = createMockRuntime();
    const registry = createCleanupRegistry({
      logger: createMockLogger(),
      runtime: mockRuntime.runtime,
    });

    registry.register(async () => {
      mockRuntime.emit("SIGINT");
    });

    await registry.triggerAll();

    expect(mockRuntime.getExitCode()).toBe(130);
  });

  test("rethrows the original uncaught exception after cleanup finishes", async () => {
    const mockRuntime = createMockRuntime();
    const expectedError = new Error("boom");
    const callOrder: string[] = [];
    const registry = createCleanupRegistry({
      logger: createMockLogger(),
      runtime: mockRuntime.runtime,
    });

    registry.register(async () => {
      callOrder.push("after-error");
    });
    registry.register(async () => {
      callOrder.push("emit-error");
      mockRuntime.emit("uncaughtException", expectedError);
    });

    await registry.triggerAll();

    expect(callOrder).toEqual(["emit-error", "after-error"]);
    expect(mockRuntime.getExitCode()).toBe(1);
    expect(mockRuntime.getRethrownValue()).toBe(expectedError);
  });

  test("rethrows the original unhandled rejection reason after cleanup finishes", async () => {
    const mockRuntime = createMockRuntime();
    const rejectionReason = { code: "EFAIL", source: "task-13" };
    const registry = createCleanupRegistry({
      logger: createMockLogger(),
      runtime: mockRuntime.runtime,
    });

    registry.register(async () => {
      mockRuntime.emit("unhandledRejection", rejectionReason);
    });

    await registry.triggerAll();

    expect(mockRuntime.getExitCode()).toBe(1);
    expect(mockRuntime.getRethrownValue()).toBe(rejectionReason);
  });

  test("runs once even when SIGINT arrives multiple times", async () => {
    const mockRuntime = createMockRuntime();
    let cleanupRuns = 0;
    const registry = createCleanupRegistry({
      logger: createMockLogger(),
      runtime: mockRuntime.runtime,
    });

    registry.register(async () => {
      cleanupRuns += 1;
    });

    mockRuntime.emit("SIGINT");
    mockRuntime.emit("SIGINT");
    await registry.triggerAll();
    await registry.triggerAll();

    expect(cleanupRuns).toBe(1);
  });
});
