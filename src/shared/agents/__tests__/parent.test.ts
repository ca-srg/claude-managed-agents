import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AgentCreateParams,
  BetaManagedAgentsCustomToolParams,
  BetaManagedAgentsSkillParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { Config } from "@/shared/config";
import { BUILTIN_GITHUB_MCP_TOKEN_ENV } from "@/shared/constants";
import type { McpServer } from "@/shared/persistence/db";
import { buildParentDefinition, type ParentMultiagentRoster } from "../parent";

const TEST_CONFIG: Config = {
  models: {
    parent: "claude-fable-5",
    child: "claude-sonnet-4-6",
  },
  maxSubIssues: 10,
  maxRunMinutes: 120,
  maxChildMinutes: 30,
  pr: { draft: true },
  commitStyle: "conventional",
  git: {
    authorName: "claude-agent[bot]",
    authorEmail: "claude-agent@users.noreply.github.com",
  },
};

// Matches the builtin GitHub MCP row produced by the DB seed.
const GITHUB_MCP_SERVER: McpServer = {
  id: 1,
  name: "github",
  url: "https://api.githubcopilot.com/mcp/",
  tokenEnvName: BUILTIN_GITHUB_MCP_TOKEN_ENV,
  permissionPolicy: "always_allow",
  enabled: true,
  isBuiltin: true,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
};

const TEST_CUSTOM_TOOLS: BetaManagedAgentsCustomToolParams[] = [
  {
    description: "First test custom tool used to validate parent agent wiring.",
    input_schema: { type: "object" },
    name: "test_tool_alpha",
    type: "custom",
  },
  {
    description: "Second test custom tool used to validate parent agent wiring.",
    input_schema: { type: "object" },
    name: "test_tool_beta",
    type: "custom",
  },
];

const TEST_MULTIAGENT: ParentMultiagentRoster = {
  agents: [{ id: "agt-child", type: "agent", version: 1 }],
  type: "coordinator",
};

const TEST_SYSTEM_SKILLS: BetaManagedAgentsSkillParams[] = [
  { skill_id: "skill_github_ops", type: "custom", version: "1700000000000000" },
];

function assertAgentCreateParams(definition: AgentCreateParams): AgentCreateParams {
  return definition;
}

describe("buildParentDefinition", () => {
  test("returns AgentCreateParams without a thinking field and with metadata tags", () => {
    const parentDefinition = assertAgentCreateParams(
      buildParentDefinition(
        TEST_CONFIG,
        { parent: "x" },
        TEST_CUSTOM_TOOLS,
        [GITHUB_MCP_SERVER],
        TEST_SYSTEM_SKILLS,
        TEST_MULTIAGENT,
      ),
    );

    expect("thinking" in parentDefinition).toBe(false);
    expect(parentDefinition.model).toBe(TEST_CONFIG.models.parent);
    expect(parentDefinition.metadata).toEqual({
      app: "github-issue-agent",
      role: "parent",
      thinking_deferred: "sdk-thinking",
    });
  });

  test("forwards custom tools and includes the github MCP and read-only inspection toolsets", () => {
    const parentDefinition: AgentCreateParams = buildParentDefinition(
      TEST_CONFIG,
      { parent: "x" },
      TEST_CUSTOM_TOOLS,
      [GITHUB_MCP_SERVER],
      TEST_SYSTEM_SKILLS,
      TEST_MULTIAGENT,
    );
    const parentTools = parentDefinition.tools ?? [];
    const customTools = parentTools.filter((toolEntry) => toolEntry.type === "custom");
    const githubMcpTools = parentTools.filter(
      (toolEntry) => toolEntry.type === "mcp_toolset" && toolEntry.mcp_server_name === "github",
    );
    const agentToolsets = parentTools.filter(
      (toolEntry) => toolEntry.type === "agent_toolset_20260401",
    );
    const customToolNames = new Set(customTools.map((toolEntry) => toolEntry.name));

    expect(agentToolsets).toEqual([
      {
        configs: [
          {
            enabled: true,
            name: "read",
            permission_policy: { type: "always_allow" },
          },
          {
            enabled: true,
            name: "bash",
            permission_policy: { type: "always_allow" },
          },
          {
            enabled: true,
            name: "glob",
            permission_policy: { type: "always_allow" },
          },
          {
            enabled: true,
            name: "grep",
            permission_policy: { type: "always_allow" },
          },
        ],
        default_config: {
          enabled: false,
          permission_policy: { type: "always_allow" },
        },
        type: "agent_toolset_20260401",
      },
    ]);
    expect(customTools).toHaveLength(TEST_CUSTOM_TOOLS.length);
    expect(customToolNames.size).toBe(TEST_CUSTOM_TOOLS.length);
    for (const expectedTool of TEST_CUSTOM_TOOLS) {
      expect(customToolNames.has(expectedTool.name)).toBe(true);
    }
    expect(githubMcpTools).toHaveLength(1);
  });

  test("attaches system-managed skills to the parent definition", () => {
    const parentDefinition = buildParentDefinition(
      TEST_CONFIG,
      { parent: "x" },
      TEST_CUSTOM_TOOLS,
      [GITHUB_MCP_SERVER],
      TEST_SYSTEM_SKILLS,
      TEST_MULTIAGENT,
    );

    expect(parentDefinition.skills).toEqual(TEST_SYSTEM_SKILLS);
  });

  test("defines exactly one github MCP server with the expected URL", () => {
    const parentDefinition = buildParentDefinition(
      TEST_CONFIG,
      { parent: "x" },
      TEST_CUSTOM_TOOLS,
      [GITHUB_MCP_SERVER],
      TEST_SYSTEM_SKILLS,
      TEST_MULTIAGENT,
    );
    const githubServers = (parentDefinition.mcp_servers ?? []).filter(
      (serverEntry) => serverEntry.name === "github",
    );

    expect(githubServers).toEqual([
      {
        name: "github",
        type: "url",
        url: "https://api.githubcopilot.com/mcp/",
      },
    ]);
  });

  test("rejects confirmation-based MCP permission policy until confirmations are implemented", () => {
    expect(() =>
      buildParentDefinition(
        TEST_CONFIG,
        { parent: "x" },
        TEST_CUSTOM_TOOLS,
        [{ ...GITHUB_MCP_SERVER, permissionPolicy: "always_ask" }],
        TEST_SYSTEM_SKILLS,
        TEST_MULTIAGENT,
      ),
    ).toThrow(/tool confirmations are not implemented/);
  });

  test("disabled MCP servers are filtered out of both mcp_servers and tools", () => {
    const parentDefinition = buildParentDefinition(
      TEST_CONFIG,
      { parent: "x" },
      TEST_CUSTOM_TOOLS,
      [{ ...GITHUB_MCP_SERVER, enabled: false }],
      TEST_SYSTEM_SKILLS,
      TEST_MULTIAGENT,
    );

    expect(parentDefinition.mcp_servers ?? []).toHaveLength(0);
    const mcpToolsets = (parentDefinition.tools ?? []).filter(
      (toolEntry) => toolEntry.type === "mcp_toolset",
    );
    expect(mcpToolsets).toHaveLength(0);
  });

  test("keeps the deferred thinking sentinel in source", () => {
    const parentSourcePath = fileURLToPath(new URL("../parent.ts", import.meta.url));
    const parentSourceText = readFileSync(parentSourcePath, "utf8");

    expect(parentSourceText).toContain("MAX_THINKING_BUDGET_DEFERRED");
  });
});
