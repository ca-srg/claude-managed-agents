import { describe, expect, test } from "bun:test";
import type { BetaManagedAgentsSkillParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";

import { PARENT_CUSTOM_TOOLS } from "@/parent-tools";
import { buildChildDefinition } from "@/shared/agents/child";
import { hashDefinition } from "@/shared/agents/hash";
import { buildParentDefinition } from "@/shared/agents/parent";
import type { Config } from "@/shared/config";
import { BUILTIN_GITHUB_MCP_TOKEN_ENV, TOOL_NAMES } from "@/shared/constants";
import type { McpServer } from "@/shared/persistence/db";
import { GENERIC_CHILD_AGENT_PROMPT, GENERIC_PARENT_AGENT_PROMPT } from "@/shared/prompts/defaults";

const TEST_CONFIG: Config = {
  models: { parent: "claude-fable-5", child: "claude-sonnet-4-6" },
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

// Mirrors the builtin GitHub MCP row created by the DB seed. Hash-stability
// tests rely on this remaining byte-identical to the seed values in
// `seedBuiltinMcpServersIfMissing` (db.ts) so the golden hashes stay valid.
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

const SYSTEM_SKILLS: BetaManagedAgentsSkillParams[] = [
  { skill_id: "skill_github_ops", type: "custom", version: "1700000000000000" },
];

async function loadGolden(): Promise<{ parent: string; child: string }> {
  return {
    child: "3d7846b7734d484dfe1ee7b8b4a4b0b3dc8f806780a5e23448aeaffa9e8e609b",
    parent: "90815d5d75b90307cbf047414150cde49f58fdc570ac2599012302dfd047ea6a",
  };
}

describe("parent tools composition", () => {
  test("PARENT_CUSTOM_TOOLS has exactly 2 custom tool entries", () => {
    // MCP toolsets are no longer part of the static `PARENT_CUSTOM_TOOLS`
    // export — they are derived per-run from the `mcp_servers` table.
    expect(PARENT_CUSTOM_TOOLS).toHaveLength(2);
  });

  test("PARENT_CUSTOM_TOOLS[0] is create_final_pr", () => {
    const tool = PARENT_CUSTOM_TOOLS[0];
    expect(tool?.name).toBe("create_final_pr");
  });

  test("PARENT_CUSTOM_TOOLS[1] is create_sub_issue", () => {
    const tool = PARENT_CUSTOM_TOOLS[1];
    expect(tool?.name).toBe("create_sub_issue");
  });

  test("custom tool entries match TOOL_NAMES in declaration order", () => {
    expect(PARENT_CUSTOM_TOOLS.map((tool) => tool.name)).toEqual([
      TOOL_NAMES.CREATE_FINAL_PR,
      TOOL_NAMES.CREATE_SUB_ISSUE,
    ]);
  });

  test("every custom tool has type=custom and object input_schema", () => {
    expect(PARENT_CUSTOM_TOOLS).toHaveLength(2);
    for (const tool of PARENT_CUSTOM_TOOLS) {
      expect(tool.type).toBe("custom");
      expect(tool.input_schema.type).toBe("object");
    }
  });
});

describe("hash-stability", () => {
  test("parent agent definition hash matches golden", async () => {
    const golden = await loadGolden();
    const parentDef = buildParentDefinition(
      TEST_CONFIG,
      { parent: GENERIC_PARENT_AGENT_PROMPT },
      PARENT_CUSTOM_TOOLS,
      [GITHUB_MCP_SERVER],
      SYSTEM_SKILLS,
      {
        agents: [{ id: "agt-child", type: "agent", version: 1 }],
        type: "coordinator",
      },
    );

    expect(hashDefinition(parentDef)).toBe(golden.parent);
  });

  test("child agent definition hash matches golden", async () => {
    const golden = await loadGolden();
    const childDef = buildChildDefinition(
      TEST_CONFIG,
      { child: GENERIC_CHILD_AGENT_PROMPT },
      [GITHUB_MCP_SERVER],
      SYSTEM_SKILLS,
    );

    expect(hashDefinition(childDef)).toBe(golden.child);
  });
});
