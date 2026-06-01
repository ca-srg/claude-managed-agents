import { describe, expect, test } from "bun:test";

import { createDbModule } from "@/shared/persistence/db";
import type { AgentState } from "@/shared/types";
import { buildEnvironmentDefinition, hashEnvironmentDefinition } from "../environment";
import { migrateLegacyAgentStateToDb } from "../state-migration";

type LegacyPersistedAgentState = AgentState & {
  childDefinitionHash?: string;
  parentDefinitionHash?: string;
};

function createLegacyState(
  overrides: Partial<LegacyPersistedAgentState> = {},
): LegacyPersistedAgentState {
  return {
    parentAgentId: "agt_parent_legacy",
    parentAgentVersion: 1,
    childAgentId: "agt_child_legacy",
    childAgentVersion: 2,
    environmentId: "env_legacy",
    definitionHash: "combined-hash",
    parentDefinitionHash: "parent-hash",
    childDefinitionHash: "child-hash",
    createdAt: "2026-04-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("migrateLegacyAgentStateToDb", () => {
  test("imports legacy file-backed agent registry and default environment state when SQLite is empty", async () => {
    const db = createDbModule(":memory:");
    db.initDb();
    const defaultEnvironmentHash = hashEnvironmentDefinition(buildEnvironmentDefinition());

    try {
      const result = await migrateLegacyAgentStateToDb({
        db,
        readAgentState: async () => createLegacyState(),
      });

      expect(result).toEqual({ migrated: true });
      expect(db.getAgentRegistryState()).toMatchObject({
        parentAgentId: "agt_parent_legacy",
        parentAgentVersion: 1,
        childAgentId: "agt_child_legacy",
        childAgentVersion: 2,
        definitionHash: "combined-hash",
        parentDefinitionHash: "parent-hash",
        childDefinitionHash: "child-hash",
        createdAt: "2026-04-23T00:00:00.000Z",
      });
      expect(db.getDefaultEnvironmentState()).toMatchObject({
        definitionHash: defaultEnvironmentHash,
        environmentId: "env_legacy",
      });
    } finally {
      db.close();
    }
  });

  test("does not overwrite existing SQLite registry state", async () => {
    const db = createDbModule(":memory:");
    db.initDb();

    try {
      db.setAgentRegistryState({
        parentAgentId: "agt_parent_db",
        parentAgentVersion: 3,
        childAgentId: "agt_child_db",
        childAgentVersion: 4,
        definitionHash: "db-combined-hash",
        parentDefinitionHash: "db-parent-hash",
        childDefinitionHash: "db-child-hash",
        createdAt: "2026-04-24T00:00:00.000Z",
      });
      db.setDefaultEnvironmentState({
        definitionHash: "db-env-hash",
        environmentId: "env_db",
      });

      const result = await migrateLegacyAgentStateToDb({
        db,
        readAgentState: async () => createLegacyState(),
      });

      expect(result).toEqual({ migrated: false });
      expect(db.getAgentRegistryState()).toMatchObject({
        parentAgentId: "agt_parent_db",
        childAgentId: "agt_child_db",
        definitionHash: "db-combined-hash",
      });
      expect(db.getDefaultEnvironmentState()).toMatchObject({
        definitionHash: "db-env-hash",
        environmentId: "env_db",
      });
    } finally {
      db.close();
    }
  });
});
