import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "@/shared/config";
import { createDbModule } from "@/shared/persistence/db";
import { createFakeAnthropic } from "../../../../test/fixtures/fake-anthropic";
import {
  createDatabaseAgentRegistryStateStore,
  createRegistry,
  type EnsureAgentsOptions,
} from "../registry";

const TEST_CONFIG: Config = {
  models: {
    parent: "claude-opus-4-7",
    child: "claude-sonnet-4-6",
  },
  maxSubIssues: 10,
  maxRunMinutes: 120,
  maxChildMinutes: 30,
  pr: { draft: true },
  commitStyle: "conventional",
  git: {
    authorName: "claude-agent[bot]",
    authorEmail: "claude-agent@users.noreply.github.com",
  },
};

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ghi-registry-"));
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

function createEnsureAgentsOptions(
  overrides: Partial<EnsureAgentsOptions> = {},
): EnsureAgentsOptions {
  return {
    cfg: TEST_CONFIG,
    parentPrompt: "Parent prompt v1",
    childPrompt: "Child prompt v1",
    parentCustomTools: [],
    mcpServers: [],
    ...overrides,
  };
}

type TestDbModule = ReturnType<typeof createDbModule>;

function createRegistryHarness(): {
  close(): void;
  db: TestDbModule;
  ensureAgents: ReturnType<typeof createRegistry>["ensureAgents"];
} {
  const db = createDbModule(":memory:");
  db.initDb();
  const { ensureAgents } = createRegistry({
    agentStateStore: createDatabaseAgentRegistryStateStore(db),
  });

  return {
    close: () => db.close(),
    db,
    ensureAgents,
  };
}

function stateFilePath(directoryPath: string): string {
  return join(directoryPath, ".github-issue-agent", "state.json");
}

function readPersistedState(db: TestDbModule) {
  const state = db.getAgentRegistryState();

  if (state === null) {
    throw new Error("Expected agent registry state to be persisted");
  }

  return state;
}

function announceScenario(title: string): void {
  process.stdout.write(`${title}\n`);
}

describe("agent registry", () => {
  test("reuse: first call creates parent + child via agents.create", async () => {
    announceScenario("reuse: first call creates parent + child via agents.create");
    const directoryPath = createTempDir();

    try {
      await withWorkingDirectory(directoryPath, async () => {
        const { client, calls } = createFakeAnthropic();
        const harness = createRegistryHarness();

        try {
          const createdAgents = await harness.ensureAgents(client, createEnsureAgentsOptions());

          expect(calls.creates).toHaveLength(2);
          expect(calls.updates).toHaveLength(0);
          // Child first, then parent (parent's coordinator roster references the resolved child id+version).
          expect(calls.creates.map((callEntry) => callEntry.role)).toEqual(["child", "parent"]);
          expect(createdAgents).toMatchObject({
            parentAgentId: "agt_parent_v1",
            parentAgentVersion: 1,
            childAgentId: "agt_child_v1",
            childAgentVersion: 1,
          });
          expect(createdAgents.definitionHash).toMatch(/^[a-f0-9]{64}$/);

          expect(readPersistedState(harness.db)).toMatchObject({
            parentAgentId: "agt_parent_v1",
            parentAgentVersion: 1,
            childAgentId: "agt_child_v1",
            childAgentVersion: 1,
            definitionHash: createdAgents.definitionHash,
          });
          expect(existsSync(stateFilePath(directoryPath))).toBe(false);
        } finally {
          harness.close();
        }
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("reuse: second call with same definitions reuses IDs", async () => {
    announceScenario("reuse: second call with same definitions reuses IDs");
    const directoryPath = createTempDir();

    try {
      await withWorkingDirectory(directoryPath, async () => {
        const { client, calls } = createFakeAnthropic();
        const harness = createRegistryHarness();
        const options = createEnsureAgentsOptions();

        try {
          const firstResult = await harness.ensureAgents(client, options);
          const secondResult = await harness.ensureAgents(client, options);

          expect(firstResult).toEqual(secondResult);
          expect(calls.creates).toHaveLength(2);
          expect(calls.updates).toHaveLength(0);
          expect(readPersistedState(harness.db)).toMatchObject({
            parentAgentId: firstResult.parentAgentId,
            childAgentId: firstResult.childAgentId,
            definitionHash: firstResult.definitionHash,
          });
        } finally {
          harness.close();
        }
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("migration: missing per-agent hashes update existing IDs instead of recreating", async () => {
    const directoryPath = createTempDir();

    try {
      await withWorkingDirectory(directoryPath, async () => {
        const { client, calls } = createFakeAnthropic();
        const harness = createRegistryHarness();

        try {
          harness.db.setAgentRegistryState({
            parentAgentId: "agt_parent_legacy",
            parentAgentVersion: 3,
            childAgentId: "agt_child_legacy",
            childAgentVersion: 4,
            definitionHash: "legacy-combined-hash",
            parentDefinitionHash: null,
            childDefinitionHash: null,
            createdAt: "2026-04-23T00:00:00.000Z",
          });

          const result = await harness.ensureAgents(client, createEnsureAgentsOptions());

          expect(calls.creates).toHaveLength(0);
          expect(calls.updates.map((callEntry) => callEntry.role)).toEqual(["child", "parent"]);
          expect(result).toMatchObject({
            parentAgentId: "agt_parent_legacy",
            childAgentId: "agt_child_legacy",
          });
          expect(readPersistedState(harness.db)).toMatchObject({
            parentAgentId: "agt_parent_legacy",
            childAgentId: "agt_child_legacy",
            parentDefinitionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            childDefinitionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            definitionHash: result.definitionHash,
          });
        } finally {
          harness.close();
        }
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("update: definition change triggers agents.update and bumps version in state", async () => {
    announceScenario("update: definition change triggers agents.update and bumps version in state");
    const directoryPath = createTempDir();

    try {
      await withWorkingDirectory(directoryPath, async () => {
        const { client, calls } = createFakeAnthropic();
        const harness = createRegistryHarness();

        try {
          const firstResult = await harness.ensureAgents(client, createEnsureAgentsOptions());
          const updatedResult = await harness.ensureAgents(
            client,
            createEnsureAgentsOptions({ parentPrompt: "Parent prompt v2" }),
          );

          expect(calls.creates).toHaveLength(2);
          expect(calls.updates).toHaveLength(1);
          expect(calls.updates[0]).toMatchObject({
            agentId: firstResult.parentAgentId,
            role: "parent",
            params: {
              version: 1,
            },
          });
          expect(updatedResult).toMatchObject({
            parentAgentId: firstResult.parentAgentId,
            parentAgentVersion: 2,
            childAgentId: firstResult.childAgentId,
            childAgentVersion: firstResult.childAgentVersion,
          });
          expect(updatedResult.definitionHash).not.toBe(firstResult.definitionHash);

          expect(readPersistedState(harness.db)).toMatchObject({
            parentAgentId: firstResult.parentAgentId,
            parentAgentVersion: 2,
            childAgentId: firstResult.childAgentId,
            childAgentVersion: 1,
            definitionHash: updatedResult.definitionHash,
          });
        } finally {
          harness.close();
        }
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("force-recreate creates fresh agents and overwrites state", async () => {
    announceScenario("force-recreate creates fresh agents and overwrites state");
    const directoryPath = createTempDir();

    try {
      await withWorkingDirectory(directoryPath, async () => {
        const createCounts = {
          parent: 0,
          child: 0,
        };
        const { client, calls } = createFakeAnthropic({
          createResponse(role) {
            createCounts[role] += 1;

            return {
              id: `agt_${role}_fresh_${createCounts[role]}`,
              version: 1,
            };
          },
        });
        const harness = createRegistryHarness();
        const baseOptions = createEnsureAgentsOptions();

        try {
          const firstResult = await harness.ensureAgents(client, baseOptions);
          const recreatedResult = await harness.ensureAgents(client, {
            ...baseOptions,
            forceRecreate: true,
          });

          expect(calls.creates).toHaveLength(4);
          expect(calls.updates).toHaveLength(0);
          expect(recreatedResult.parentAgentId).not.toBe(firstResult.parentAgentId);
          expect(recreatedResult.childAgentId).not.toBe(firstResult.childAgentId);
          expect(readPersistedState(harness.db)).toMatchObject({
            parentAgentId: recreatedResult.parentAgentId,
            childAgentId: recreatedResult.childAgentId,
            definitionHash: recreatedResult.definitionHash,
          });
        } finally {
          harness.close();
        }
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  test("concurrent: atomic state write under concurrent calls", async () => {
    announceScenario("concurrent: atomic state write under concurrent calls");
    const directoryPath = createTempDir();

    try {
      await withWorkingDirectory(directoryPath, async () => {
        const { client, calls } = createFakeAnthropic();
        const harness = createRegistryHarness();
        const sharedOptions = createEnsureAgentsOptions();

        try {
          const concurrentResults = await Promise.all([
            harness.ensureAgents(client, sharedOptions),
            harness.ensureAgents(client, sharedOptions),
            harness.ensureAgents(client, sharedOptions),
          ]);

          expect(calls.creates.filter((callEntry) => callEntry.role === "parent")).toHaveLength(1);
          expect(calls.creates.filter((callEntry) => callEntry.role === "child")).toHaveLength(1);
          expect(calls.updates).toHaveLength(0);

          const persistedState = readPersistedState(harness.db);
          const firstResult = concurrentResults[0];

          if (!firstResult) {
            throw new Error("Expected at least one concurrent result");
          }

          expect(concurrentResults).toEqual([firstResult, firstResult, firstResult]);
          expect(persistedState).toMatchObject({
            parentAgentId: firstResult.parentAgentId,
            parentAgentVersion: firstResult.parentAgentVersion,
            childAgentId: firstResult.childAgentId,
            childAgentVersion: firstResult.childAgentVersion,
            definitionHash: firstResult.definitionHash,
          });
        } finally {
          harness.close();
        }
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });
});
