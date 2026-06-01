import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type {
  AgentCreateParams,
  AgentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type {
  SkillCreateParams,
  SkillCreateResponse,
  SkillListParams,
  SkillListResponse,
} from "@anthropic-ai/sdk/resources/beta/skills/skills";
import type {
  VersionCreateParams,
  VersionCreateResponse,
} from "@anthropic-ai/sdk/resources/beta/skills/versions";
import type { Config } from "@/shared/config";
import { RUN_LOCK } from "@/shared/constants";
import type { McpServer } from "@/shared/persistence/db";
import { createStateModule } from "@/shared/state";
import type {
  AgentRegistryState,
  PersistedAgentRegistryState,
  PersistedSystemSkillState,
  SystemSkillKey,
  SystemSkillState,
} from "@/shared/types";
import { buildChildDefinition } from "./child";
import {
  buildGitHubOperationsSkillFiles,
  GITHUB_OPERATIONS_SKILL_DISPLAY_TITLE,
  GITHUB_OPERATIONS_SKILL_KEY,
  hashGitHubOperationsSkill,
  toGitHubOperationsSkillParams,
} from "./github-operations-skill";
import { hashDefinition } from "./hash";
import {
  buildParentDefinition,
  type ParentCustomTools,
  type ParentMultiagentRoster,
} from "./parent";

const LOCK_RETRY_OPTIONS = {
  retries: 40,
  factor: 1,
  minTimeout: 25,
  maxTimeout: 25,
  randomize: false,
} as const;

type AgentRole = "parent" | "child";

export type AgentRegistryStateStore = {
  readAgentRegistryState(): AgentRegistryState | null | Promise<AgentRegistryState | null>;
  writeAgentRegistryState(state: PersistedAgentRegistryState): void | Promise<void>;
  readSystemSkillState(
    key: SystemSkillKey,
  ): SystemSkillState | null | Promise<SystemSkillState | null>;
  writeSystemSkillState(state: PersistedSystemSkillState): void | Promise<void>;
};

export type RegistryAnthropicClient = {
  beta: {
    agents: {
      create(params: AgentCreateParams): PromiseLike<{ id: string; version: number }>;
      update(
        agentId: string,
        params: AgentUpdateParams,
      ): PromiseLike<{ id: string; version: number }>;
    };
    skills: {
      create(params: SkillCreateParams): PromiseLike<SkillCreateResponse>;
      list(params?: SkillListParams | null | undefined): AsyncIterable<SkillListResponse>;
      versions: {
        create(skillId: string, params: VersionCreateParams): PromiseLike<VersionCreateResponse>;
      };
    };
  };
};

export type EnsureAgentsOptions = {
  cfg: Config;
  parentPrompt: string;
  childPrompt: string;
  /**
   * Custom (non-MCP) tools attached to the parent. MCP toolsets are built
   * from `mcpServers` server-side; do not include `mcp_toolset` entries
   * here — they would duplicate the dynamically-derived toolsets.
   */
  parentCustomTools: ParentCustomTools;
  /**
   * MCP servers enabled for both parent and child. Disabled rows can be
   * passed in; the agent builders filter them out before sending to the
   * Anthropic API. Authentication for each server is supplied separately
   * via Vault credentials at session-create time.
   */
  mcpServers: ReadonlyArray<McpServer>;
  forceRecreate?: boolean;
};

export type EnsureAgentsResult = {
  parentAgentId: string;
  parentAgentVersion: number;
  childAgentId: string;
  childAgentVersion: number;
  definitionHash: string;
};

export type EnsureAgents = (
  client: RegistryAnthropicClient,
  options: EnsureAgentsOptions,
) => Promise<EnsureAgentsResult>;

type RegistryDeps = {
  buildParent: typeof buildParentDefinition;
  buildChild: typeof buildChildDefinition;
  hash: typeof hashDefinition;
  agentStateStore: AgentRegistryStateStore;
  stateModule: ReturnType<typeof createStateModule>;
};

type CreateRegistryDeps = Pick<RegistryDeps, "agentStateStore"> &
  Partial<Omit<RegistryDeps, "agentStateStore">>;

export function createDatabaseAgentRegistryStateStore(db: {
  getAgentRegistryState(): AgentRegistryState | null;
  setAgentRegistryState(state: AgentRegistryState): void;
  getSystemSkillState(key: SystemSkillKey): SystemSkillState | null;
  setSystemSkillState(state: PersistedSystemSkillState): void;
}): AgentRegistryStateStore {
  return {
    readAgentRegistryState: () => db.getAgentRegistryState(),
    readSystemSkillState: (key) => db.getSystemSkillState(key),
    writeAgentRegistryState: (state) => db.setAgentRegistryState(state),
    writeSystemSkillState: (state) => db.setSystemSkillState(state),
  };
}

function hashCombinedDefinitions(
  parentDefinitionHash: string,
  childDefinitionHash: string,
): string {
  return createHash("sha256")
    .update(`${parentDefinitionHash}:${childDefinitionHash}`)
    .digest("hex");
}

function toEnsureAgentsResult(state: AgentRegistryState): EnsureAgentsResult {
  return {
    parentAgentId: state.parentAgentId,
    parentAgentVersion: state.parentAgentVersion,
    childAgentId: state.childAgentId,
    childAgentVersion: state.childAgentVersion,
    definitionHash: state.definitionHash,
  };
}

function toUpdateParams(definition: AgentCreateParams, version: number): AgentUpdateParams {
  return {
    version,
    ...(typeof definition.description === "undefined"
      ? {}
      : { description: definition.description }),
    ...(typeof definition.mcp_servers === "undefined"
      ? {}
      : { mcp_servers: definition.mcp_servers }),
    ...(typeof definition.metadata === "undefined" ? {} : { metadata: definition.metadata }),
    ...(typeof definition.model === "undefined" ? {} : { model: definition.model }),
    ...(typeof definition.multiagent === "undefined" ? {} : { multiagent: definition.multiagent }),
    ...(typeof definition.name === "undefined" ? {} : { name: definition.name }),
    ...(typeof definition.skills === "undefined" ? {} : { skills: definition.skills }),
    ...(typeof definition.system === "undefined" ? {} : { system: definition.system }),
    ...(typeof definition.tools === "undefined" ? {} : { tools: definition.tools }),
  };
}

function readStoredDefinitionHash(state: AgentRegistryState, role: AgentRole): string | undefined {
  const key = role === "parent" ? "parentDefinitionHash" : "childDefinitionHash";
  const storedValue = (state as Record<string, unknown>)[key];

  return typeof storedValue === "string" ? storedValue : undefined;
}

function buildPersistedState(options: {
  createdAt: string;
  parentAgentId: string;
  parentAgentVersion: number;
  childAgentId: string;
  childAgentVersion: number;
  definitionHash: string;
  parentDefinitionHash: string;
  childDefinitionHash: string;
}): PersistedAgentRegistryState {
  return {
    parentAgentId: options.parentAgentId,
    parentAgentVersion: options.parentAgentVersion,
    childAgentId: options.childAgentId,
    childAgentVersion: options.childAgentVersion,
    definitionHash: options.definitionHash,
    createdAt: options.createdAt,
    parentDefinitionHash: options.parentDefinitionHash,
    childDefinitionHash: options.childDefinitionHash,
  };
}

function createLockError(lockFilePath: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  return new Error(`Failed to acquire run lock at ${lockFilePath}: ${message}`);
}

function buildCoordinatorRoster(
  childAgentId: string,
  childAgentVersion: number,
): ParentMultiagentRoster {
  return {
    type: "coordinator",
    agents: [{ type: "agent", id: childAgentId, version: childAgentVersion }],
  };
}

type ExistingGitHubOperationsSkill = Pick<
  SkillListResponse,
  "display_title" | "id" | "latest_version"
>;

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return String(error);
}

function isDuplicateDisplayTitleError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();

  return (
    message.includes("display_title") &&
    (message.includes("reuse") || message.includes("duplicate") || message.includes("already"))
  );
}

async function findGitHubOperationsSystemSkill(
  client: RegistryAnthropicClient,
): Promise<ExistingGitHubOperationsSkill | null> {
  for await (const skill of client.beta.skills.list({ source: "custom", limit: 100 })) {
    if (skill.display_title === GITHUB_OPERATIONS_SKILL_DISPLAY_TITLE) {
      return skill;
    }
  }

  return null;
}

async function createGitHubOperationsSkillVersion(
  client: RegistryAnthropicClient,
  skillId: string,
  files: NonNullable<SkillCreateParams["files"]>,
): Promise<string> {
  const createdVersion = await client.beta.skills.versions.create(skillId, {
    files,
  });

  if (typeof createdVersion.version !== "string" || createdVersion.version.length === 0) {
    throw new Error("GitHub operations skill version was created without a version");
  }

  return createdVersion.version;
}

function readCreatedSkillVersion(createdSkill: SkillCreateResponse): string {
  if (typeof createdSkill.latest_version !== "string" || createdSkill.latest_version.length === 0) {
    throw new Error("GitHub operations skill was created without a latest version");
  }

  return createdSkill.latest_version;
}

async function ensureGitHubOperationsSystemSkill(
  client: RegistryAnthropicClient,
  store: AgentRegistryStateStore,
): Promise<{ skillId: string; skillVersion: string }> {
  const contentHash = hashGitHubOperationsSkill();
  const existingState = await store.readSystemSkillState(GITHUB_OPERATIONS_SKILL_KEY);

  if (existingState !== null && existingState.contentHash === contentHash) {
    return {
      skillId: existingState.skillId,
      skillVersion: existingState.skillVersion,
    };
  }

  const files = await buildGitHubOperationsSkillFiles();
  const createdAt = existingState?.createdAt ?? new Date().toISOString();
  let skillId: string;
  let skillVersion: string;

  if (existingState === null) {
    const existingSkill = await findGitHubOperationsSystemSkill(client);

    if (existingSkill !== null) {
      skillId = existingSkill.id;
      skillVersion = await createGitHubOperationsSkillVersion(client, skillId, files);
    } else {
      try {
        const createdSkill = await client.beta.skills.create({
          display_title: GITHUB_OPERATIONS_SKILL_DISPLAY_TITLE,
          files,
        });
        skillId = createdSkill.id;
        skillVersion = readCreatedSkillVersion(createdSkill);
      } catch (error) {
        if (!isDuplicateDisplayTitleError(error)) {
          throw error;
        }

        const racedSkill = await findGitHubOperationsSystemSkill(client);
        if (racedSkill === null) {
          throw error;
        }

        skillId = racedSkill.id;
        skillVersion = await createGitHubOperationsSkillVersion(client, skillId, files);
      }
    }
  } else {
    skillId = existingState.skillId;
    skillVersion = await createGitHubOperationsSkillVersion(client, skillId, files);
  }

  await store.writeSystemSkillState({
    contentHash,
    createdAt,
    key: GITHUB_OPERATIONS_SKILL_KEY,
    skillId,
    skillVersion,
  });

  return { skillId, skillVersion };
}

export function createRegistry(deps: CreateRegistryDeps) {
  const stateModule = deps.stateModule ?? createStateModule();
  const registryDeps: RegistryDeps = {
    buildParent: deps.buildParent ?? buildParentDefinition,
    buildChild: deps.buildChild ?? buildChildDefinition,
    hash: deps.hash ?? hashDefinition,
    agentStateStore: deps.agentStateStore,
    stateModule,
  };

  /**
   * Ensure parent (coordinator) and child agents exist on the Managed Agents
   * API, creating or updating them only when their definitions change.
   *
   * Order matters: the parent's `multiagent.coordinator` roster must reference
   * a concrete child agent id+version, so the child is created/updated first,
   * its resolved reference is folded into the parent definition, and only then
   * is the parent created/updated. The combined hash bound to local state
   * therefore covers both definitions plus the coordinator topology.
   */
  async function ensureAgents(
    client: RegistryAnthropicClient,
    options: EnsureAgentsOptions,
  ): Promise<EnsureAgentsResult> {
    const lockFilePath = resolve(process.cwd(), `${RUN_LOCK}.lock`);
    let lockAcquired = false;

    try {
      try {
        await registryDeps.stateModule.acquireRunLock({ retries: LOCK_RETRY_OPTIONS });
        lockAcquired = true;
      } catch (error) {
        throw createLockError(lockFilePath, error);
      }

      const existingState = await registryDeps.agentStateStore.readAgentRegistryState();
      const githubOperationsSkill = await ensureGitHubOperationsSystemSkill(
        client,
        registryDeps.agentStateStore,
      );
      const systemSkills = [toGitHubOperationsSkillParams(githubOperationsSkill)];
      const childDefinition = registryDeps.buildChild(
        options.cfg,
        { child: options.childPrompt },
        options.mcpServers,
        systemSkills,
      );
      const childDefinitionHash = registryDeps.hash(childDefinition);

      if (options.forceRecreate === true || existingState === null) {
        const createdChild = await client.beta.agents.create(childDefinition);
        const parentDefinition = registryDeps.buildParent(
          options.cfg,
          { parent: options.parentPrompt },
          options.parentCustomTools,
          options.mcpServers,
          systemSkills,
          buildCoordinatorRoster(createdChild.id, createdChild.version),
        );
        const parentDefinitionHash = registryDeps.hash(parentDefinition);
        const combinedDefinitionHash = hashCombinedDefinitions(
          parentDefinitionHash,
          childDefinitionHash,
        );
        const createdParent = await client.beta.agents.create(parentDefinition);
        const nextState = buildPersistedState({
          createdAt: new Date().toISOString(),
          parentAgentId: createdParent.id,
          parentAgentVersion: createdParent.version,
          childAgentId: createdChild.id,
          childAgentVersion: createdChild.version,
          definitionHash: combinedDefinitionHash,
          parentDefinitionHash,
          childDefinitionHash,
        });

        await registryDeps.agentStateStore.writeAgentRegistryState(nextState);

        return toEnsureAgentsResult(nextState);
      }

      const storedChildDefinitionHash = readStoredDefinitionHash(existingState, "child");
      const childNeedsUpdate =
        typeof storedChildDefinitionHash === "string"
          ? storedChildDefinitionHash !== childDefinitionHash
          : true;

      const updatedChild = childNeedsUpdate
        ? await client.beta.agents.update(
            existingState.childAgentId,
            toUpdateParams(childDefinition, existingState.childAgentVersion),
          )
        : {
            id: existingState.childAgentId,
            version: existingState.childAgentVersion,
          };

      // Build the parent definition only after the child reference is known so
      // the coordinator roster always points at a real, resolved child version.
      const parentDefinition = registryDeps.buildParent(
        options.cfg,
        { parent: options.parentPrompt },
        options.parentCustomTools,
        options.mcpServers,
        systemSkills,
        buildCoordinatorRoster(updatedChild.id, updatedChild.version),
      );
      const parentDefinitionHash = registryDeps.hash(parentDefinition);
      const combinedDefinitionHash = hashCombinedDefinitions(
        parentDefinitionHash,
        childDefinitionHash,
      );

      if (existingState.definitionHash === combinedDefinitionHash && !childNeedsUpdate) {
        return toEnsureAgentsResult(existingState);
      }

      const storedParentDefinitionHash = readStoredDefinitionHash(existingState, "parent");
      const parentNeedsUpdate =
        typeof storedParentDefinitionHash === "string"
          ? storedParentDefinitionHash !== parentDefinitionHash
          : true;

      const updatedParent = parentNeedsUpdate
        ? await client.beta.agents.update(
            existingState.parentAgentId,
            toUpdateParams(parentDefinition, existingState.parentAgentVersion),
          )
        : {
            id: existingState.parentAgentId,
            version: existingState.parentAgentVersion,
          };

      const nextState = buildPersistedState({
        createdAt: existingState.createdAt,
        parentAgentId: updatedParent.id,
        parentAgentVersion: updatedParent.version,
        childAgentId: updatedChild.id,
        childAgentVersion: updatedChild.version,
        definitionHash: combinedDefinitionHash,
        parentDefinitionHash,
        childDefinitionHash,
      });

      await registryDeps.agentStateStore.writeAgentRegistryState(nextState);

      return toEnsureAgentsResult(nextState);
    } finally {
      if (lockAcquired) {
        await registryDeps.stateModule.releaseRunLock();
      }
    }
  }

  return { ensureAgents };
}
