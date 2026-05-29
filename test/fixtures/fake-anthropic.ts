import type {
  AgentCreateParams,
  AgentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

export type RegistryAnthropicClient = {
  beta: {
    agents: {
      create(params: AgentCreateParams): PromiseLike<{ id: string; version: number }>;
      update(
        agentId: string,
        params: AgentUpdateParams,
      ): PromiseLike<{ id: string; version: number }>;
    };
  };
};

export type FakeClientCalls = {
  creates: Array<{ params: AgentCreateParams; role: "parent" | "child" }>;
  updates: Array<{
    agentId: string;
    params: AgentUpdateParams;
    role: "parent" | "child";
  }>;
};

type CreateOverride = {
  createResponse?: (role: "parent" | "child") => { id: string; version: number };
};

const DEFAULT_AGENT_NAMES = {
  parent: "github-issue-orchestrator",
  child: "github-issue-implementer",
} as const;

function roleFromName(agentName: string): "parent" | "child" {
  if (agentName === DEFAULT_AGENT_NAMES.parent) {
    return "parent";
  }

  if (agentName === DEFAULT_AGENT_NAMES.child) {
    return "child";
  }

  throw new Error(`Unknown agent name: ${agentName}`);
}

function inferRoleFromAgentId(
  agentId: string,
  rolesByAgentId: ReadonlyMap<string, "parent" | "child">,
): "parent" | "child" {
  const rememberedRole = rolesByAgentId.get(agentId);

  if (rememberedRole) {
    return rememberedRole;
  }

  if (agentId.includes("parent")) {
    return "parent";
  }

  if (agentId.includes("child")) {
    return "child";
  }

  throw new Error(`Unknown agent id: ${agentId}`);
}

export function createFakeAnthropic(overrides: CreateOverride = {}): {
  client: RegistryAnthropicClient;
  calls: FakeClientCalls;
} {
  const calls: FakeClientCalls = {
    creates: [],
    updates: [],
  };
  const createCounts = {
    parent: 0,
    child: 0,
  };
  const versionsByAgentId = new Map<string, number>();
  const rolesByAgentId = new Map<string, "parent" | "child">();

  const client: RegistryAnthropicClient = {
    beta: {
      agents: {
        async create(params) {
          const role = roleFromName(params.name);
          calls.creates.push({ params, role });
          createCounts[role] += 1;

          const createdAgent =
            overrides.createResponse?.(role) ??
            ({
              id: `agt_${role}_v${createCounts[role]}`,
              version: 1,
            } satisfies { id: string; version: number });

          rolesByAgentId.set(createdAgent.id, role);
          versionsByAgentId.set(createdAgent.id, createdAgent.version);

          return createdAgent;
        },
        async update(agentId, params) {
          const role = inferRoleFromAgentId(agentId, rolesByAgentId);
          calls.updates.push({ agentId, params, role });

          const currentVersion = versionsByAgentId.get(agentId) ?? params.version;
          const nextVersion = currentVersion + 1;
          versionsByAgentId.set(agentId, nextVersion);

          return {
            id: agentId,
            version: nextVersion,
          };
        },
      },
    },
  };

  return { client, calls };
}
