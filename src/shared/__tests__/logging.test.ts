import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

import { attachTaskLogger, createLogger, createRunId } from "../logging";

const createdTempDirs: string[] = [];
const SAMPLE_GITHUB_APP_TOKEN = "ghs_1234567890abcdefghij1234567890abcdef";
const SAMPLE_ANTHROPIC_TOKEN = "sk-ant-example_secret-token_1234567890";

afterEach(async () => {
  await Promise.all(
    createdTempDirs
      .splice(0)
      .map((directoryPath) => rm(directoryPath, { recursive: true, force: true })),
  );
});

async function createTempLogFile(): Promise<string> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "maestro-logging-"));
  createdTempDirs.push(tempDirectory);
  return join(tempDirectory, "logging.json");
}

async function flushLogger(logger: Logger): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    logger.flush((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function readLogEntries(logFile: string): Promise<Array<Record<string, unknown>>> {
  const logContent = await readFile(logFile, "utf8");

  return logContent
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("createLogger emits JSON with runId, timestamp, level, and msg", async () => {
  const logFile = await createTempLogFile();
  const logger = createLogger({ level: "info", logFile });

  logger.info("hello world");
  await flushLogger(logger);

  const [entry] = await readLogEntries(logFile);

  expect(entry).toBeDefined();
  expect(typeof entry?.runId).toBe("string");
  expect(typeof entry?.timestamp).toBe("string");
  expect(entry?.level).toBe(30);
  expect(entry?.msg).toBe("hello world");
});

test("createLogger redacts configured fields and token-shaped strings", async () => {
  const logFile = await createTempLogFile();
  const logger = createLogger({ level: "info", logFile });

  logger.info(
    {
      Bearer: SAMPLE_GITHUB_APP_TOKEN,
      api_key: SAMPLE_ANTHROPIC_TOKEN,
      github_token: SAMPLE_GITHUB_APP_TOKEN,
      headers: {
        authorization: `Bearer ${SAMPLE_GITHUB_APP_TOKEN}`,
      },
      nested: {
        authorization: `Bearer ${SAMPLE_GITHUB_APP_TOKEN}`,
      },
      notes: {
        detail: `contains ${SAMPLE_GITHUB_APP_TOKEN} and ${SAMPLE_ANTHROPIC_TOKEN}`,
      },
    },
    `Bearer ${SAMPLE_GITHUB_APP_TOKEN} and ${SAMPLE_ANTHROPIC_TOKEN}`,
  );
  await flushLogger(logger);

  const [entry] = await readLogEntries(logFile);
  const serializedEntry = JSON.stringify(entry);

  expect(entry?.github_token).toBe("[REDACTED]");
  expect(entry?.authorization).toBeUndefined();
  expect(entry?.api_key).toBe("[REDACTED]");
  expect(entry?.Bearer).toBe("[REDACTED]");
  expect((entry?.headers as Record<string, unknown>).authorization).toBe("[REDACTED]");
  expect((entry?.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
  expect((entry?.notes as Record<string, unknown>).detail).toBe(
    "contains [REDACTED] and [REDACTED]",
  );
  expect(entry?.msg).toBe("Bearer [REDACTED] and [REDACTED]");
  expect(serializedEntry).not.toContain(SAMPLE_GITHUB_APP_TOKEN);
  expect(serializedEntry).not.toContain(SAMPLE_ANTHROPIC_TOKEN);
});

test("attachTaskLogger preserves runId and adds taskId binding", async () => {
  const logFile = await createTempLogFile();
  const logger = createLogger({ level: "info", logFile });
  const rootRunId = logger.bindings().runId;
  const taskLogger = attachTaskLogger(logger, "task-123");

  expect(taskLogger.bindings().runId).toBe(rootRunId);
  expect(taskLogger.bindings().taskId).toBe("task-123");

  taskLogger.info("child message");
  await flushLogger(taskLogger);

  const [entry] = await readLogEntries(logFile);

  expect(entry?.runId).toBe(rootRunId);
  expect(entry?.taskId).toBe("task-123");
  expect(entry?.msg).toBe("child message");
});

test("createRunId returns a UUID v7", () => {
  const runId = createRunId();

  expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(runId[14]).toBe("7");
});
