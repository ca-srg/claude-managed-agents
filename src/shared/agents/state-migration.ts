import type { createDbModule } from "@/shared/persistence/db";
import type { AgentState } from "@/shared/types";
import { buildEnvironmentDefinition, hashEnvironmentDefinition } from "./environment";

type AgentRegistryMigrationDb = Pick<
  ReturnType<typeof createDbModule>,
  "getAgentRegistryState" | "setAgentRegistryState" | "setDefaultEnvironmentState"
>;

type LegacyPersistedAgentState = AgentState & {
  childDefinitionHash?: string;
  parentDefinitionHash?: string;
};

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function migrateLegacyAgentStateToDb(options: {
  db: AgentRegistryMigrationDb;
  readAgentState: () => Promise<AgentState | null>;
}): Promise<{ migrated: boolean }> {
  if (options.db.getAgentRegistryState() !== null) {
    return { migrated: false };
  }

  const legacyState = (await options.readAgentState()) as LegacyPersistedAgentState | null;

  if (legacyState === null) {
    return { migrated: false };
  }

  options.db.setAgentRegistryState({
    parentAgentId: legacyState.parentAgentId,
    parentAgentVersion: legacyState.parentAgentVersion,
    childAgentId: legacyState.childAgentId,
    childAgentVersion: legacyState.childAgentVersion,
    definitionHash: legacyState.definitionHash,
    parentDefinitionHash: optionalString(legacyState.parentDefinitionHash),
    childDefinitionHash: optionalString(legacyState.childDefinitionHash),
    createdAt: legacyState.createdAt,
  });
  options.db.setDefaultEnvironmentState({
    definitionHash: hashEnvironmentDefinition(buildEnvironmentDefinition()),
    environmentId: legacyState.environmentId,
  });

  return { migrated: true };
}
