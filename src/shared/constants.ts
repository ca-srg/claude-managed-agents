export const AGENT_TOOLSET_VERSION = "agent_toolset_20260401";

export const GITHUB_API_VERSION = "2026-03-10";

export const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

export const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

/**
 * Builtin MCP server name used by the DB seed and the agent definitions.
 * The DB row is created with `is_builtin = 1`; the WebUI permits editing
 * `token_env_name` for legacy/custom compatibility and `permission_policy`,
 * but locks `name`, `url`, and enabled state so agent definitions can rely on
 * the GitHub MCP toolset being present. At runtime this builtin server uses
 * the GitHub App installation token resolved for the target repository.
 */
export const BUILTIN_GITHUB_MCP_NAME = "github";

/**
 * Legacy placeholder stored on the builtin row at seed time. The builtin
 * GitHub MCP server no longer reads an environment-backed bearer token; the
 * actual token is minted through the configured GitHub App per repository.
 */
export const BUILTIN_GITHUB_MCP_TOKEN_ENV = "GITHUB_APP_INSTALLATION_TOKEN";

export const SUPPORTED_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
] as const;

/**
 * Base URL of the Claude Console. Managed Agents session detail pages live
 * under `/workspaces/{workspace}/sessions/{sessionId}`, so the dashboard can
 * deep-link each recorded session straight to its Console trace view.
 */
export const CLAUDE_CONSOLE_BASE_URL = "https://platform.claude.com";

/**
 * Default Console workspace slug used to build session deep-links. Personal
 * accounts and single-workspace orgs use `default`; multi-workspace orgs can
 * override it via the `CONSOLE_WORKSPACE` env var (see {@link applyEnvOverrides}).
 */
export const DEFAULT_CONSOLE_WORKSPACE = "default";

/**
 * Build the Claude Console deep-link for a Managed Agents session.
 */
export function sessionConsoleUrl(
  sessionId: string,
  workspace: string = DEFAULT_CONSOLE_WORKSPACE,
): string {
  return `${CLAUDE_CONSOLE_BASE_URL}/workspaces/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(sessionId)}`;
}

/**
 * Sentinel marking the intentionally deferred `thinking` configuration in
 * agent definitions. `@anthropic-ai/sdk@0.104.1` contains the model IDs we use,
 * but this app still does not opt Managed Agents into thinking budgets. If that
 * changes, replace this with a real MAX_THINKING_BUDGET map and wire it into
 * parent/child definitions.
 */
export const MAX_THINKING_BUDGET_DEFERRED = Object.freeze({
  todo: "TODO(sdk-thinking): keep thinking disabled until explicitly enabled",
  reason: "thinking remains intentionally disabled for Managed Agents on @anthropic-ai/sdk@0.104.1",
} as const);

/**
 * Names of custom tools provided by the orchestrator (parent / coordinator) agent.
 * Sub-agent invocation is no longer a custom tool — it is performed via the
 * Managed Agents official multiagent coordinator topology.
 */
export const TOOL_NAMES = {
  CREATE_FINAL_PR: "create_final_pr",
  CREATE_SUB_ISSUE: "create_sub_issue",
} as const;

export const STATE_FILE = ".maestro/state.json";

export const RUN_LOCK = ".maestro/run.lock";

/**
 * Public name of the implementer (sub-agent) registered with the Managed
 * Agents API. The coordinator delegates to this agent by name in its
 * thread messages — we keep the name centrally so prompt template, agent
 * registration, and event filtering stay in lockstep.
 */
export const CHILD_AGENT_NAME = "maestro-implementer";

/**
 * Public name of the coordinator (parent) agent. Used both for registration
 * and for filtering thread events that originate from the primary thread.
 */
export const PARENT_AGENT_NAME = "maestro-orchestrator";
