import type {
  AgentCreateParams,
  BetaManagedAgentsAgentToolset20260401Params,
  BetaManagedAgentsSkillParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

import { toEnabledMcpServerParams, toEnabledMcpToolsetParams } from "@/shared/agents/mcp";
import type { Config } from "@/shared/config";
import { AGENT_TOOLSET_VERSION, MAX_THINKING_BUDGET_DEFERRED } from "@/shared/constants";
import type { McpServer } from "@/shared/persistence/db";

// Runtime guard: ensures the deferral sentinel is preserved (prevents tree-shaking + keeps grep-ability at import site).
void MAX_THINKING_BUDGET_DEFERRED;

const AGENT_TOOLSET: BetaManagedAgentsAgentToolset20260401Params = {
  type: AGENT_TOOLSET_VERSION,
  // Custom/system skills are validated against the built-in read tool; keep it explicit.
  configs: [
    {
      name: "read",
      enabled: true,
      permission_policy: { type: "always_allow" },
    },
  ],
};

const CHILD_METADATA = {
  app: "github-issue-agent",
  role: "child",
  thinking_deferred: "sdk-v0.91",
} as const;

/**
 * Build the child (implementer) agent definition.
 *
 * MCP servers are sourced from the DB so the child inherits the same set as
 * the parent (the WebUI lets operators configure a single global list; both
 * agents read from it). Authentication is supplied via Vault credentials at
 * session-create time, not on the agent definition itself.
 */
export function buildChildDefinition(
  cfg: Config,
  prompts: { child: string },
  mcpServers: ReadonlyArray<McpServer>,
  systemSkills: ReadonlyArray<BetaManagedAgentsSkillParams>,
): AgentCreateParams {
  /**
   * TODO(sdk-v0.91): re-enable thinking at MAX budget
   * @anthropic-ai/sdk@0.90.0 AgentCreateParams has no 'thinking' field — see docs/spike-notes.md
   * When SDK v0.91 ships: add `thinking: { type: "enabled", budget_tokens: MAX_THINKING_BUDGET[cfg.models.child] }` to the returned object and hydrate MAX_THINKING_BUDGET_DEFERRED in constants.ts
   */
  const mcpServerParams = toEnabledMcpServerParams(mcpServers);
  const mcpToolsetParams = toEnabledMcpToolsetParams(mcpServers);

  return {
    name: "github-issue-implementer",
    description: "Implements one delegated GitHub issue task and validates the branch.",
    model: cfg.models.child,
    system: prompts.child,
    skills: [...systemSkills],
    mcp_servers: mcpServerParams,
    tools: [AGENT_TOOLSET, ...mcpToolsetParams],
    metadata: CHILD_METADATA,
  };
}
