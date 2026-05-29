import type { BetaManagedAgentsCustomToolParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";

import { CREATE_SUB_ISSUE_TOOL_DEFINITION } from "@/features/decomposition/tool-definition";
import { CREATE_FINAL_PR_TOOL_DEFINITION } from "@/features/finalize-pr/tool-definition";
import { toCustomToolParams } from "@/shared/agents/parent";

/**
 * Custom tools exposed to the parent (coordinator) agent.
 *
 * MCP toolsets are no longer included here: they are derived from the DB
 * (`mcp_servers` table) at agent-definition build time and concatenated
 * with these custom tools by `buildParentDefinition`. Operators add or
 * remove MCP servers via the WebUI, not via code changes to this list.
 *
 * Sub-agent invocation is also not a custom tool: the parent's
 * `multiagent.coordinator` topology delegates to the implementer agent
 * server-side. The remaining custom tools cover GitHub side-effects the
 * coordinator must perform itself (decomposition + final PR).
 */
export const PARENT_CUSTOM_TOOLS: ReadonlyArray<BetaManagedAgentsCustomToolParams> = [
  toCustomToolParams(CREATE_FINAL_PR_TOOL_DEFINITION),
  toCustomToolParams(CREATE_SUB_ISSUE_TOOL_DEFINITION),
] as const;
