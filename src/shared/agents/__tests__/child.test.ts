import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  AgentCreateParams,
  BetaManagedAgentsSkillParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";

import type { Config } from "@/shared/config";
import { BUILTIN_GITHUB_MCP_TOKEN_ENV } from "@/shared/constants";
import type { McpServer } from "@/shared/persistence/db";
import { buildChildDefinition } from "../child";

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

const TEST_SYSTEM_SKILLS: BetaManagedAgentsSkillParams[] = [
  { skill_id: "skill_github_ops", type: "custom", version: "1700000000000000" },
];

function assertAgentCreateParams(definition: AgentCreateParams): AgentCreateParams {
  return definition;
}

describe("buildChildDefinition", () => {
  test("returns AgentCreateParams without a thinking field and with metadata tags", () => {
    const childDefinition = assertAgentCreateParams(
      buildChildDefinition(TEST_CONFIG, { child: "x" }, [GITHUB_MCP_SERVER], TEST_SYSTEM_SKILLS),
    );

    expect("thinking" in childDefinition).toBe(false);
    expect(childDefinition.model).toBe(TEST_CONFIG.models.child);
    expect(childDefinition.metadata).toEqual({
      app: "github-issue-agent",
      role: "child",
      thinking_deferred: "sdk-v0.91",
    });
  });

  test("includes exactly one built-in agent toolset, one github MCP toolset, and no custom tools", () => {
    const childDefinition: AgentCreateParams = buildChildDefinition(
      TEST_CONFIG,
      { child: "x" },
      [GITHUB_MCP_SERVER],
      TEST_SYSTEM_SKILLS,
    );
    const childTools = childDefinition.tools ?? [];
    const agentToolsets = childTools.filter(
      (toolEntry) => toolEntry.type === "agent_toolset_20260401",
    );
    const githubMcpTools = childTools.filter(
      (toolEntry) => toolEntry.type === "mcp_toolset" && toolEntry.mcp_server_name === "github",
    );
    const customTools = childTools.filter((toolEntry) => toolEntry.type === "custom");

    expect(agentToolsets).toHaveLength(1);
    expect(agentToolsets[0]).toMatchObject({
      configs: [
        {
          enabled: true,
          name: "read",
          permission_policy: { type: "always_allow" },
        },
      ],
    });
    expect(githubMcpTools).toHaveLength(1);
    expect(customTools).toHaveLength(0);
  });

  test("attaches system-managed skills to the child definition", () => {
    const childDefinition = buildChildDefinition(
      TEST_CONFIG,
      { child: "x" },
      [GITHUB_MCP_SERVER],
      TEST_SYSTEM_SKILLS,
    );

    expect(childDefinition.skills).toEqual(TEST_SYSTEM_SKILLS);
  });

  test("defines exactly one github MCP server with the expected URL", () => {
    const childDefinition = buildChildDefinition(
      TEST_CONFIG,
      { child: "x" },
      [GITHUB_MCP_SERVER],
      TEST_SYSTEM_SKILLS,
    );
    const githubServers = (childDefinition.mcp_servers ?? []).filter(
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

  test("disabled MCP servers are filtered out of mcp_servers and tools", () => {
    const childDefinition = buildChildDefinition(
      TEST_CONFIG,
      { child: "x" },
      [{ ...GITHUB_MCP_SERVER, enabled: false }],
      TEST_SYSTEM_SKILLS,
    );

    expect(childDefinition.mcp_servers ?? []).toHaveLength(0);
    const mcpToolsets = (childDefinition.tools ?? []).filter(
      (toolEntry) => toolEntry.type === "mcp_toolset",
    );
    expect(mcpToolsets).toHaveLength(0);
  });

  test("keeps the sdk-v0.91 TODO anchor in source", () => {
    const childSourcePath = fileURLToPath(new URL("../child.ts", import.meta.url));
    const childSourceText = readFileSync(childSourcePath, "utf8");

    expect(childSourceText).toContain("TODO(sdk-v0.91): re-enable thinking at MAX budget");
  });
});
