import type {
  AgentCreateParams,
  BetaManagedAgentsAgentToolset20260401Params,
  BetaManagedAgentsCustomToolInputSchema,
  BetaManagedAgentsCustomToolParams,
  BetaManagedAgentsSkillParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

import { toEnabledMcpServerParams, toEnabledMcpToolsetParams } from "@/shared/agents/mcp";
import type { Config } from "@/shared/config";
import {
  AGENT_TOOLSET_VERSION,
  MAX_THINKING_BUDGET_DEFERRED,
  PARENT_AGENT_NAME,
} from "@/shared/constants";
import type { McpServer } from "@/shared/persistence/db";
import type { CustomToolDefinition } from "@/shared/tool-schema-core";

// Runtime guard: ensures the deferral sentinel is preserved (prevents tree-shaking + keeps grep-ability at import site).
void MAX_THINKING_BUDGET_DEFERRED;

const PARENT_METADATA = {
  app: "github-issue-agent",
  role: "parent",
  thinking_deferred: "sdk-thinking",
} as const;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entryValue) => typeof entryValue === "string");
}

function toCustomToolInputSchema(
  inputSchema: Record<string, unknown> & { type?: string | string[] },
): BetaManagedAgentsCustomToolInputSchema {
  const { properties, required, type } = inputSchema;

  if (typeof type !== "undefined" && type !== "object") {
    throw new Error("Custom tool input_schema.type must be 'object'");
  }

  if (typeof properties !== "undefined" && properties !== null && !isObjectRecord(properties)) {
    throw new Error("Custom tool input_schema.properties must be an object when present");
  }

  if (typeof required !== "undefined" && !isStringArray(required)) {
    throw new Error("Custom tool input_schema.required must be a string array when present");
  }

  return {
    type: "object",
    ...(typeof properties === "undefined" ? {} : { properties }),
    ...(typeof required === "undefined" ? {} : { required }),
  };
}

export function toCustomToolParams(
  toolDefinition: CustomToolDefinition,
): BetaManagedAgentsCustomToolParams {
  return {
    ...toolDefinition,
    input_schema: toCustomToolInputSchema(toolDefinition.input_schema),
  };
}

export type ParentMultiagentRoster = NonNullable<AgentCreateParams["multiagent"]>;

/** Tool entries that appear on the parent regardless of MCP configuration. */
export type ParentCustomTools = ReadonlyArray<BetaManagedAgentsCustomToolParams>;

const PARENT_AGENT_TOOLSET: BetaManagedAgentsAgentToolset20260401Params = {
  type: AGENT_TOOLSET_VERSION,
  // Skills require the built-in read tool at session creation. Bash is enabled because the
  // parent prompt mandates git/gh inspection and CI polling; glob/grep support read-only
  // repository inspection when decomposing issues. Edit/write stay disabled so the
  // coordinator cannot modify files directly (implementation is delegated to the child).
  default_config: {
    enabled: false,
    permission_policy: { type: "always_allow" },
  },
  configs: [
    {
      name: "read",
      enabled: true,
      permission_policy: { type: "always_allow" },
    },
    {
      name: "bash",
      enabled: true,
      permission_policy: { type: "always_allow" },
    },
    {
      name: "glob",
      enabled: true,
      permission_policy: { type: "always_allow" },
    },
    {
      name: "grep",
      enabled: true,
      permission_policy: { type: "always_allow" },
    },
  ],
};

/**
 * Build the parent (coordinator) agent definition.
 *
 * The parent uses Managed Agents' official multi-agent coordinator topology:
 * its `multiagent` field references the child implementer agent so the API
 * itself manages spawning child threads.
 *
 * MCP servers are sourced from the DB (`mcp_servers` table) so operators can
 * add/remove servers from the WebUI without code changes. Each enabled row
 * contributes both an entry in `mcp_servers` and a matching `mcp_toolset`
 * entry in `tools`. Authentication for each server is supplied separately
 * via Vault credentials at session-create time; the agent definition itself
 * carries only `{ name, type, url }`.
 *
 * `multiagent` MUST be a coordinator entry referencing already-created child
 * agents; callers (the agent registry) ensure children exist first and then
 * pass their resolved `{type, id, version}` references in.
 */
export function buildParentDefinition(
  cfg: Config,
  prompts: { parent: string },
  customTools: ParentCustomTools,
  mcpServers: ReadonlyArray<McpServer>,
  systemSkills: ReadonlyArray<BetaManagedAgentsSkillParams>,
  multiagent: ParentMultiagentRoster,
): AgentCreateParams {
  const mcpServerParams = toEnabledMcpServerParams(mcpServers);
  const mcpToolsetParams = toEnabledMcpToolsetParams(mcpServers);

  return {
    name: PARENT_AGENT_NAME,
    description:
      "Coordinator that decomposes a GitHub issue, delegates implementation to sub-agents, and finalizes the resulting PR.",
    model: cfg.models.parent,
    system: prompts.parent,
    skills: [...systemSkills],
    mcp_servers: mcpServerParams,
    tools: [PARENT_AGENT_TOOLSET, ...mcpToolsetParams, ...customTools],
    metadata: PARENT_METADATA,
    multiagent,
  };
}
