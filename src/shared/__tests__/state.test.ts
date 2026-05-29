import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  acquireRunLock,
  createStateModule,
  readAgentState,
  readRunState,
  releaseRunLock,
  writeAgentState,
  writeRunState,
} from "../state";
import type { AgentState, RunState } from "../types";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ghi-state-"));
}

function cleanupTempDir(directoryPath: string): void {
  rmSync(directoryPath, { force: true, recursive: true });
}

async function withWorkingDirectory<T>(directoryPath: string, run: () => Promise<T>): Promise<T> {
  const previousWorkingDirectory = process.cwd();
  process.chdir(directoryPath);

  try {
    return await run();
  } finally {
    process.chdir(previousWorkingDirectory);
  }
}

function createAgentState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    parentAgentId: "parent-agent",
    parentAgentVersion: 1,
    childAgentId: "child-agent",
    childAgentVersion: 2,
    environmentId: "env_123",
    definitionHash: "hash-1",
    createdAt: "2026-04-23T00:00:00.000Z",
    ...overrides,
  };
}

function createRunState(runId = "run-123", overrides: Partial<RunState> = {}): RunState {
  return {
    runId,
    issueNumber: 42,
    repo: "rluisr/claude-managed-agents",
    branch: "task/state-lock",
    startedAt: "2026-04-23T00:00:00.000Z",
    subIssues: [
      {
        taskId: "task-1",
        issueId: 1001,
        issueNumber: 77,
      },
    ],
    sessionIds: ["ses_123"],
    ...overrides,
  };
}

function stateFilePath(directoryPath: string): string {
  return join(directoryPath, ".github-issue-agent", "state.json");
}

function runStateFilePath(directoryPath: string, runId: string): string {
  return join(directoryPath, ".github-issue-agent", `run-${runId}.json`);
}

function lockDirectoryPath(directoryPath: string): string {
  return join(directoryPath, ".github-issue-agent", "run.lock.lock");
}

describe("state module", () => {
  test("readAgentState returns null when the state file is absent", async () => {
    const directoryPath = createTempDir();

    try {
      await withWorkingDirectory(directoryPath, async () => {
        const state = await readAgentState();

        expect(state).toBeNull();
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("writeAgentState persists and round-trips through readAgentState", async () => {
    const directoryPath = createTempDir();
    const expectedState = createAgentState({ definitionHash: "hash-round-trip" });

    try {
      await withWorkingDirectory(directoryPath, async () => {
        await writeAgentState(expectedState);

        await expect(readAgentState()).resolves.toEqual(expectedState);
        expect(readFileSync(stateFilePath(directoryPath), "utf8")).toBe(
          `${JSON.stringify(expectedState, null, 2)}\n`,
        );
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("writeRunState persists and round-trips through readRunState", async () => {
    const directoryPath = createTempDir();
    const runId = "run-456";
    const expectedState = createRunState(runId, { prUrl: "https://example.com/pr/1" });

    try {
      await withWorkingDirectory(directoryPath, async () => {
        await writeRunState(runId, expectedState);

        await expect(readRunState(runId)).resolves.toEqual(expectedState);
        expect(readFileSync(runStateFilePath(directoryPath, runId), "utf8")).toBe(
          `${JSON.stringify(expectedState, null, 2)}\n`,
        );
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("writeRunState round-trips the optional pid field", async () => {
    const directoryPath = createTempDir();
    const runId = "run-pid";
    const expectedState = createRunState(runId, { pid: 67_890 });

    try {
      await withWorkingDirectory(directoryPath, async () => {
        await writeRunState(runId, expectedState);

        await expect(readRunState(runId)).resolves.toEqual(expectedState);
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("readRunState rejects state files with an invalid pid value", async () => {
    const directoryPath = createTempDir();
    const runId = "run-bad-pid";

    try {
      await withWorkingDirectory(directoryPath, async () => {
        const filePath = runStateFilePath(directoryPath, runId);
        mkdirSync(dirname(filePath), { recursive: true });
        const invalid = {
          ...createRunState(runId),
          pid: -1,
        };
        writeFileSync(filePath, `${JSON.stringify(invalid, null, 2)}\n`);

        await expect(readRunState(runId)).rejects.toThrow(/Invalid run state/);
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("writeAgentState leaves the previous content intact when the atomic writer fails", async () => {
    const directoryPath = createTempDir();
    const initialState = createAgentState({ definitionHash: "hash-before-crash" });
    const nextState = createAgentState({ definitionHash: "hash-after-crash" });

    try {
      await withWorkingDirectory(directoryPath, async () => {
        await writeAgentState(initialState);

        const failingStateModule = createStateModule({
          writeFileAtomic: async (filePath, fileContents) => {
            const partialWritePath = `${filePath}.partial`;
            mkdirSync(dirname(filePath), { recursive: true });
            writeFileSync(partialWritePath, String(fileContents).slice(0, 24));
            throw new Error("simulated crash before rename");
          },
        });

        await expect(failingStateModule.writeAgentState(nextState)).rejects.toThrow(
          "simulated crash before rename",
        );
        await expect(readAgentState()).resolves.toEqual(initialState);
        expect(readFileSync(stateFilePath(directoryPath), "utf8")).toContain(
          '"definitionHash": "hash-before-crash"',
        );
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("acquireRunLock succeeds once and a second acquire on the same path throws", async () => {
    const directoryPath = createTempDir();

    try {
      await withWorkingDirectory(directoryPath, async () => {
        await expect(acquireRunLock()).resolves.toBeUndefined();
        expect(existsSync(lockDirectoryPath(directoryPath))).toBe(true);

        await expect(acquireRunLock()).rejects.toMatchObject({ code: "ELOCKED" });

        await releaseRunLock();
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("releaseRunLock allows a later re-acquire", async () => {
    const directoryPath = createTempDir();

    try {
      await withWorkingDirectory(directoryPath, async () => {
        await acquireRunLock();
        await releaseRunLock();
        expect(existsSync(lockDirectoryPath(directoryPath))).toBe(false);

        await expect(acquireRunLock()).resolves.toBeUndefined();
        await releaseRunLock();
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("acquireRunLock reclaims a stale lock", async () => {
    const directoryPath = createTempDir();
    const firstStateModule = createStateModule();
    const secondStateModule = createStateModule();

    try {
      await withWorkingDirectory(directoryPath, async () => {
        await firstStateModule.acquireRunLock({ onCompromised: () => {} });

        const staleTimestamp = new Date(Date.now() - 60_000);
        utimesSync(lockDirectoryPath(directoryPath), staleTimestamp, staleTimestamp);

        await expect(
          secondStateModule.acquireRunLock({ onCompromised: () => {}, stale: 1 }),
        ).resolves.toBeUndefined();

        await secondStateModule.releaseRunLock();
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });
});
