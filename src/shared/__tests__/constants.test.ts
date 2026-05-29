import { describe, expect, test } from "bun:test";

import {
  GITHUB_MCP_URL,
  MAX_THINKING_BUDGET_DEFERRED,
  SUPPORTED_MODELS,
  TOOL_NAMES,
} from "../constants";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type _SupportedModelsIsReadonlyTuple = Expect<
  Equal<typeof SUPPORTED_MODELS, readonly ["claude-opus-4-7", "claude-sonnet-4-6"]>
>;

describe("TOOL_NAMES", () => {
  test("contains the expected tool names", () => {
    expect(TOOL_NAMES).toEqual({
      CREATE_FINAL_PR: "create_final_pr",
      CREATE_SUB_ISSUE: "create_sub_issue",
    });
  });
});

describe("SUPPORTED_MODELS", () => {
  test("contains the supported model allowlist", () => {
    expect(SUPPORTED_MODELS).toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
  });
});

describe("GITHUB_MCP_URL", () => {
  test("exports the exact GitHub MCP URL", () => {
    expect(GITHUB_MCP_URL).toBe("https://api.githubcopilot.com/mcp/");
  });
});

describe("MAX_THINKING_BUDGET_DEFERRED", () => {
  test("exports the deferred thinking sentinel", () => {
    expect(MAX_THINKING_BUDGET_DEFERRED).toEqual({
      todo: expect.stringMatching(/TODO\(sdk-thinking\)/),
      reason: "@anthropic-ai/sdk@0.95.1 AgentCreateParams has no thinking field",
    });
  });
});
