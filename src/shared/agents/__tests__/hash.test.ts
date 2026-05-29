import { describe, expect, test } from "bun:test";
import type { AgentCreateParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";

import { hashDefinition } from "../hash";

function createAgentDefinition(overrides: Partial<AgentCreateParams> = {}): AgentCreateParams {
  return {
    name: "github-issue-orchestrator",
    description: "Coordinates GitHub issue decomposition and delivery.",
    model: "claude-opus-4-7",
    system: "Parent prompt",
    mcp_servers: [
      {
        name: "github",
        type: "url",
        url: "https://api.githubcopilot.com/mcp/",
      },
    ],
    tools: [
      {
        type: "mcp_toolset",
        mcp_server_name: "github",
        default_config: { permission_policy: { type: "always_allow" } },
      },
      {
        type: "custom",
        name: "create_sub_issue",
        description: "Create or reuse a linked sub-issue.",
        input_schema: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
          required: ["title"],
        },
      },
    ],
    metadata: {
      app: "github-issue-agent",
      role: "parent",
      thinking_deferred: "sdk-v0.91",
    },
    ...overrides,
  };
}

describe("hashDefinition", () => {
  test("returns a 64-character lowercase hex digest", () => {
    const digest = hashDefinition(createAgentDefinition());

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("is stable across object key reordering", () => {
    const canonicalDefinition = createAgentDefinition();
    const reorderedDefinition: AgentCreateParams = {
      metadata: {
        thinking_deferred: "sdk-v0.91",
        role: "parent",
        app: "github-issue-agent",
      },
      tools: [
        {
          default_config: { permission_policy: { type: "always_allow" } },
          mcp_server_name: "github",
          type: "mcp_toolset",
        },
        {
          input_schema: {
            required: ["title"],
            properties: {
              title: { type: "string" },
            },
            type: "object",
          },
          description: "Create or reuse a linked sub-issue.",
          name: "create_sub_issue",
          type: "custom",
        },
      ],
      mcp_servers: [
        {
          url: "https://api.githubcopilot.com/mcp/",
          type: "url",
          name: "github",
        },
      ],
      system: "Parent prompt",
      model: "claude-opus-4-7",
      description: "Coordinates GitHub issue decomposition and delivery.",
      name: "github-issue-orchestrator",
    };

    expect(hashDefinition(canonicalDefinition)).toBe(hashDefinition(reorderedDefinition));
  });

  test("changes when the model changes", () => {
    const firstDigest = hashDefinition(createAgentDefinition());
    const secondDigest = hashDefinition(createAgentDefinition({ model: "claude-sonnet-4-6" }));

    expect(firstDigest).not.toBe(secondDigest);
  });

  test("changes when the system prompt changes", () => {
    const firstDigest = hashDefinition(createAgentDefinition());
    const secondDigest = hashDefinition(createAgentDefinition({ system: "Child prompt" }));

    expect(firstDigest).not.toBe(secondDigest);
  });

  test("changes when tool contents or ordering change", () => {
    const baseDefinition = createAgentDefinition();
    const appendedToolDefinition = createAgentDefinition({
      tools: [
        ...(baseDefinition.tools ?? []),
        {
          type: "custom",
          name: "create_final_pr",
          description: "Create the final pull request.",
          input_schema: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
            required: ["title"],
          },
        },
      ],
    });
    const reversedToolDefinition = createAgentDefinition({
      tools: [...(baseDefinition.tools ?? [])].reverse(),
    });

    expect(hashDefinition(baseDefinition)).not.toBe(hashDefinition(appendedToolDefinition));
    expect(hashDefinition(baseDefinition)).not.toBe(hashDefinition(reversedToolDefinition));
  });

  test("changes when metadata changes", () => {
    const firstDigest = hashDefinition(createAgentDefinition());
    const secondDigest = hashDefinition(
      createAgentDefinition({
        metadata: {
          app: "github-issue-agent",
          role: "child",
          thinking_deferred: "sdk-v0.91",
        },
      }),
    );

    expect(firstDigest).not.toBe(secondDigest);
  });
});
