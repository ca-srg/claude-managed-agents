import type {
  BetaManagedAgentsMCPToolsetParams,
  BetaManagedAgentsURLMCPServerParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

import type { McpServer } from "@/shared/persistence/db";

/**
 * Translate a DB-backed MCP server row into the SDK's `mcp_servers[]`
 * shape. Only enabled rows should be passed here; callers filter ahead of
 * time. The mapping is intentionally narrow — the SDK accepts only
 * `{ name, type, url }` for URL-based MCP servers, with no inline token /
 * header fields. Authentication is supplied separately via Vault credentials.
 */
export function toMcpServerParams(server: McpServer): BetaManagedAgentsURLMCPServerParams {
  return {
    name: server.name,
    type: "url",
    url: server.url,
  };
}

/**
 * Translate a DB-backed MCP server row into the agent's `tools[]` entry
 * that activates the toolset. The toolset references the server by name
 * and carries the per-server `permission_policy`. Confirmation-based policies
 * are rejected until the session loop can answer tool confirmation requests.
 */
export function toMcpToolsetParams(server: McpServer): BetaManagedAgentsMCPToolsetParams {
  if (server.permissionPolicy === "always_ask") {
    throw new Error(
      `MCP server "${server.name}" uses permission policy "always_ask", but tool confirmations are not implemented`,
    );
  }

  return {
    type: "mcp_toolset",
    mcp_server_name: server.name,
    default_config: {
      permission_policy: { type: server.permissionPolicy },
    },
  };
}

/**
 * Filter an MCP server list down to the entries enabled by the operator,
 * then map each to its SDK `mcp_servers[]` representation.
 */
export function toEnabledMcpServerParams(
  servers: ReadonlyArray<McpServer>,
): BetaManagedAgentsURLMCPServerParams[] {
  return servers.filter((server) => server.enabled).map((server) => toMcpServerParams(server));
}

/**
 * Filter an MCP server list down to enabled entries and translate each
 * into the `mcp_toolset` tools entry expected on the agent definition.
 */
export function toEnabledMcpToolsetParams(
  servers: ReadonlyArray<McpServer>,
): BetaManagedAgentsMCPToolsetParams[] {
  return servers.filter((server) => server.enabled).map((server) => toMcpToolsetParams(server));
}
