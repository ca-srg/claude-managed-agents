import type {
  AgentCreateParams,
  BetaManagedAgentsAgentToolset20260401Params,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

import { toEnabledMcpServerParams, toEnabledMcpToolsetParams } from "@/shared/agents/mcp";
import type { Config } from "@/shared/config";
import { AGENT_TOOLSET_VERSION, MAX_THINKING_BUDGET_DEFERRED } from "@/shared/constants";
import type { McpServer } from "@/shared/persistence/db";

void MAX_THINKING_BUDGET_DEFERRED;

export const REPO_CHAT_AGENT_NAME = "maestro-repository-chat";

const AGENT_TOOLSET: BetaManagedAgentsAgentToolset20260401Params = {
  type: AGENT_TOOLSET_VERSION,
};

const REPO_CHAT_METADATA = {
  app: "maestro",
  role: "repo-chat",
  thinking_deferred: "sdk-thinking",
} as const;

const REPO_CHAT_SYSTEM = `You are a read-only repository inspection assistant inside maestro's Web UI.

Purpose:
- Answer operator questions about one configured repository before they start a GitHub Issue agent run.
- Focus on repository settings, MCP availability, environment packages, recent run context, and repository contents.

Strict safety rules:
- Read-only only. Never modify files, create branches, commit, push, open issues, open PRs, or change repository/dashboard/MCP settings.
- Use shell or repository tools only for inspection commands such as pwd, ls, find, git status, git log, git show, grep, and file reads.
- If a user asks for a mutating action, explain that this chat is inspection-only and point them to the appropriate dashboard action instead.
- Never reveal secrets or token values. You may mention environment variable names and whether the dashboard reports them as present or missing.

Answering style:
- Reply in the user's language.
- Be concise but specific.
- Cite concrete file paths, commands, MCP server names, or dashboard sections when they informed the answer.
- If repository contents are not available or a tool fails, say what failed and answer from the dashboard context you do have.`;

export function buildRepoChatAgentDefinition(
  cfg: Config,
  mcpServers: ReadonlyArray<McpServer>,
): AgentCreateParams {
  const mcpServerParams = toEnabledMcpServerParams(mcpServers);
  const mcpToolsetParams = toEnabledMcpToolsetParams(mcpServers);

  return {
    name: REPO_CHAT_AGENT_NAME,
    description:
      "Read-only Web UI chat assistant for inspecting repository settings, MCP availability, and repository contents.",
    model: cfg.models.child,
    system: REPO_CHAT_SYSTEM,
    mcp_servers: mcpServerParams,
    tools: [AGENT_TOOLSET, ...mcpToolsetParams],
    metadata: REPO_CHAT_METADATA,
  };
}
