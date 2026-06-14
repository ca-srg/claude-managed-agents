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

export type RegistryAnthropicClient = {
  post<Response>(
    path: string,
    options: { body: FormData; headers: Record<string, string> },
  ): PromiseLike<Response>;
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

export type FakeClientCalls = {
  creates: Array<{ params: AgentCreateParams; role: "parent" | "child" }>;
  skillCreates: Array<{ params: SkillCreateParams }>;
  skillLists: Array<{ params: SkillListParams | null | undefined }>;
  skillVersionCreates: Array<{
    headers?: Record<string, string>;
    params: VersionCreateParams;
    path?: string;
    skillId: string;
  }>;
  updates: Array<{
    agentId: string;
    params: AgentUpdateParams;
    role: "parent" | "child";
  }>;
};

type CreateOverride = {
  createResponse?: (role: "parent" | "child") => { id: string; version: number };
  updateResponse?: (
    agentId: string,
    params: AgentUpdateParams,
    role: "parent" | "child",
  ) => { id: string; version: number };
  skillCreateResponse?: (params: SkillCreateParams) => SkillCreateResponse;
  skillListResponse?: (
    params: SkillListParams | null | undefined,
  ) => Iterable<SkillListResponse> | AsyncIterable<SkillListResponse>;
  skillVersionCreateResponse?: (skillId: string, params: VersionCreateParams) => VersionCreateResponse;
};

const DEFAULT_AGENT_NAMES = {
  parent: "maestro-orchestrator",
  child: "maestro-implementer",
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

function toAsyncIterable<T>(items: Iterable<T> | AsyncIterable<T>): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const item of items) {
        yield item;
      }
    },
  };
}

function versionCreateParamsFromBody(body: FormData): VersionCreateParams {
  return {
    files: body.getAll("files[]").filter((value): value is File => value instanceof File),
  };
}

function createSkillVersionResponse(
  skillId: string,
  params: VersionCreateParams,
  count: number,
  overrides: CreateOverride,
): VersionCreateResponse {
  return (
    overrides.skillVersionCreateResponse?.(skillId, params) ??
    ({
      created_at: "2026-06-01T00:00:00.000Z",
      description: "GitHub App GitHub Operations",
      directory: "github-app-github-operations",
      id: `skillver_github_ops_${count}`,
      name: "github-app-github-operations",
      skill_id: skillId,
      type: "skill_version",
      version: `170000000000001${count}`,
    } satisfies VersionCreateResponse)
  );
}

export function createFakeAnthropic(overrides: CreateOverride = {}): {
  client: RegistryAnthropicClient;
  calls: FakeClientCalls;
} {
  const calls: FakeClientCalls = {
    creates: [],
    skillCreates: [],
    skillLists: [],
    skillVersionCreates: [],
    updates: [],
  };
  const createCounts = {
    parent: 0,
    child: 0,
  };
  const versionsByAgentId = new Map<string, number>();
  const rolesByAgentId = new Map<string, "parent" | "child">();
  let skillCreateCount = 0;
  let skillVersionCreateCount = 0;

  const client: RegistryAnthropicClient = {
    async post<Response>(
      path: string,
      options: { body: FormData; headers: Record<string, string> },
    ) {
      const match = path.match(/^\/v1\/skills\/([^/]+)\/versions\?beta=true$/);

      if (match === null) {
        throw new Error(`Unexpected POST path: ${path}`);
      }

      const skillId = decodeURIComponent(match[1] ?? "");
      const params = versionCreateParamsFromBody(options.body);
      calls.skillVersionCreates.push({ headers: options.headers, params, path, skillId });
      skillVersionCreateCount += 1;

      return createSkillVersionResponse(
        skillId,
        params,
        skillVersionCreateCount,
        overrides,
      ) as Response;
    },
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

          if (overrides.updateResponse) {
            return overrides.updateResponse(agentId, params, role);
          }

          const currentVersion = versionsByAgentId.get(agentId) ?? params.version;
          const nextVersion = currentVersion + 1;
          versionsByAgentId.set(agentId, nextVersion);

          return {
            id: agentId,
            version: nextVersion,
          };
        },
      },
      skills: {
        async create(params) {
          calls.skillCreates.push({ params });
          skillCreateCount += 1;

          return (
            overrides.skillCreateResponse?.(params) ??
            ({
              created_at: "2026-06-01T00:00:00.000Z",
              display_title: params.display_title ?? null,
              id: `skill_github_ops_${skillCreateCount}`,
              latest_version: `170000000000000${skillCreateCount}`,
              source: "custom",
              type: "skill",
              updated_at: "2026-06-01T00:00:00.000Z",
            } satisfies SkillCreateResponse)
          );
        },
        list(params) {
          calls.skillLists.push({ params });

          return toAsyncIterable(overrides.skillListResponse?.(params) ?? []);
        },
        versions: {
          async create(skillId, params) {
            calls.skillVersionCreates.push({ params, skillId });
            skillVersionCreateCount += 1;

            return createSkillVersionResponse(skillId, params, skillVersionCreateCount, overrides);
          },
        },
      },
    },
  };

  return { client, calls };
}
