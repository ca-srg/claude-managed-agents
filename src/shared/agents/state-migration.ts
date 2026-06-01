import type { createDbModule } from "@/shared/persistence/db";
import type { AgentState } from "@/shared/types";

type AgentRegistryMigrationDb = Pick<
  ReturnType<typeof createDbModule>,
  "getAgentRegistryState" | "setAgentRegistryState"
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

  // NOTE: default 環境状態 (default_environment_state) は意図的に移行しない。
  // legacy state.json の environmentId は repo override 環境 ID を含み得る上、
  // 旧実装は default 環境の definition hash を保存していないため、ここで現行
  // ハッシュを記録すると ensureEnvironment が誤ってキャッシュヒットし、stale/別repo
  // のカスタム環境を使い続けるリスクがある。次回 run で現行定義の fresh default
  // 環境を作らせる方が安全（orphan は一度きりで軽微）。
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

  return { migrated: true };
}
