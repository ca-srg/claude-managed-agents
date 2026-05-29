import process from "node:process";

import type { Logger } from "pino";

type CleanupHandler = () => Promise<void>;

type CleanupLogger = Pick<Logger, "error" | "info">;

type CleanupRuntime = {
  addSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  offUnhandledRejection(listener: (reason: unknown) => void): void;
  offUncaughtException(listener: (error: Error) => void): void;
  onUnhandledRejection(listener: (reason: unknown) => void): void;
  onUncaughtException(listener: (error: Error) => void): void;
  removeSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  rethrow(value: unknown): void;
  setExitCode(code: number): void;
};

type DrainTrigger =
  | { exitCode: number; kind: "normal" }
  | { exitCode: number; kind: "signal" }
  | { error: unknown; exitCode: number; kind: "error" };

export type CreateCleanupRegistryOptions = {
  logger: CleanupLogger;
  runtime?: CleanupRuntime;
  timeoutMs?: number;
};

export type CleanupRegistry = {
  register(fn: CleanupHandler): void;
  triggerAll(): Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const ERROR_EXIT_CODE = 1;
const NORMAL_EXIT_CODE = 0;
const SIGINT_EXIT_CODE = 130;
const SIGTERM_EXIT_CODE = 143;

function createProcessRuntime(processRef: NodeJS.Process): CleanupRuntime {
  return {
    addSignalListener(signal, listener) {
      processRef.on(signal, listener);
    },
    offUnhandledRejection(listener) {
      processRef.off("unhandledRejection", listener);
    },
    offUncaughtException(listener) {
      processRef.off("uncaughtException", listener);
    },
    onUnhandledRejection(listener) {
      processRef.on("unhandledRejection", listener);
    },
    onUncaughtException(listener) {
      processRef.on("uncaughtException", listener);
    },
    removeSignalListener(signal, listener) {
      processRef.off(signal, listener);
    },
    rethrow(value) {
      queueMicrotask(() => {
        throw value;
      });
    },
    setExitCode(code) {
      processRef.exitCode = code;
    },
  };
}

async function runCleanupWithTimeout(
  cleanupHandler: CleanupHandler,
  timeoutMs: number,
): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      Promise.resolve().then(() => cleanupHandler()),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Cleanup handler timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export function createCleanupRegistry({
  logger,
  runtime = createProcessRuntime(process),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: CreateCleanupRegistryOptions): CleanupRegistry {
  const cleanupHandlers: CleanupHandler[] = [];
  let activeTrigger: DrainTrigger = { exitCode: NORMAL_EXIT_CODE, kind: "normal" };
  let triggerPromise: Promise<void> | null = null;

  const unregisterListeners = () => {
    runtime.removeSignalListener("SIGINT", handleSigint);
    runtime.removeSignalListener("SIGTERM", handleSigterm);
    runtime.offUncaughtException(handleUncaughtException);
    runtime.offUnhandledRejection(handleUnhandledRejection);
  };

  async function drainCleanupHandlers(): Promise<void> {
    while (cleanupHandlers.length > 0) {
      const cleanupHandler = cleanupHandlers.pop();

      if (!cleanupHandler) {
        continue;
      }

      try {
        await runCleanupWithTimeout(cleanupHandler, timeoutMs);
      } catch (error) {
        logger.error({ err: error }, "cleanup handler failed");
      }
    }
  }

  function recordTrigger(nextTrigger: DrainTrigger): void {
    if (nextTrigger.kind === "error") {
      if (activeTrigger.kind !== "error") {
        activeTrigger = nextTrigger;
      }

      runtime.setExitCode(ERROR_EXIT_CODE);
      return;
    }

    if (activeTrigger.kind === "error") {
      return;
    }

    if (nextTrigger.kind === "signal") {
      if (activeTrigger.kind === "normal") {
        activeTrigger = nextTrigger;
        runtime.setExitCode(nextTrigger.exitCode);
      }

      return;
    }

    if (activeTrigger.kind === "normal") {
      runtime.setExitCode(nextTrigger.exitCode);
    }
  }

  function startDrain(nextTrigger: DrainTrigger) {
    recordTrigger(nextTrigger);

    if (triggerPromise) {
      return triggerPromise;
    }

    triggerPromise = (async () => {
      try {
        await drainCleanupHandlers();
      } finally {
        unregisterListeners();
      }

      if (activeTrigger.kind === "error") {
        runtime.rethrow(activeTrigger.error);
      }
    })();

    return triggerPromise;
  }

  function handleSigint(): void {
    logger.info({ signal: "SIGINT" }, "received shutdown signal; draining cleanup handlers");
    void startDrain({ exitCode: SIGINT_EXIT_CODE, kind: "signal" });
  }

  function handleSigterm(): void {
    logger.info({ signal: "SIGTERM" }, "received shutdown signal; draining cleanup handlers");
    void startDrain({ exitCode: SIGTERM_EXIT_CODE, kind: "signal" });
  }

  function handleUncaughtException(error: Error): void {
    logger.error({ err: error, origin: "uncaughtException" }, "received uncaught exception");
    void startDrain({ error, exitCode: ERROR_EXIT_CODE, kind: "error" });
  }

  function handleUnhandledRejection(reason: unknown): void {
    if (reason instanceof Error) {
      logger.error({ err: reason, origin: "unhandledRejection" }, "received unhandled rejection");
    } else {
      logger.error({ origin: "unhandledRejection", reason }, "received unhandled rejection");
    }

    void startDrain({ error: reason, exitCode: ERROR_EXIT_CODE, kind: "error" });
  }

  runtime.addSignalListener("SIGINT", handleSigint);
  runtime.addSignalListener("SIGTERM", handleSigterm);
  runtime.onUncaughtException(handleUncaughtException);
  runtime.onUnhandledRejection(handleUnhandledRejection);

  return {
    register(fn) {
      if (triggerPromise) {
        logger.info("cleanup already draining; skipping late registration");
        return;
      }

      cleanupHandlers.push(fn);
    },
    triggerAll() {
      return startDrain({ exitCode: NORMAL_EXIT_CODE, kind: "normal" });
    },
  };
}
