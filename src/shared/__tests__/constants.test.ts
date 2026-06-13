import { describe, expect, test } from "bun:test";

import {
  CLAUDE_CONSOLE_BASE_URL,
  DEFAULT_CONSOLE_WORKSPACE,
  GITHUB_MCP_URL,
  MAX_THINKING_BUDGET_DEFERRED,
  SUPPORTED_MODELS,
  sessionConsoleUrl,
  TOOL_NAMES,
} from "../constants";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<T extends true> = T;

type _SupportedModelsIsReadonlyTuple = Expect<
  Equal<
    typeof SUPPORTED_MODELS,
    readonly ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6"]
  >
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
  test("contains the default parent, legacy parent, and child model allowlist", () => {
    expect(SUPPORTED_MODELS).toEqual(["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6"]);
  });
});

describe("GITHUB_MCP_URL", () => {
  test("exports the exact GitHub MCP URL", () => {
    expect(GITHUB_MCP_URL).toBe("https://api.githubcopilot.com/mcp/");
  });
});

describe("sessionConsoleUrl", () => {
  test("builds a Claude Console deep-link for the default workspace", () => {
    expect(sessionConsoleUrl("sesn_01UV5hUcBt3CcgYKxH1V3uUf")).toBe(
      `${CLAUDE_CONSOLE_BASE_URL}/workspaces/${DEFAULT_CONSOLE_WORKSPACE}/sessions/sesn_01UV5hUcBt3CcgYKxH1V3uUf`,
    );
  });

  test("uses the provided workspace slug", () => {
    expect(sessionConsoleUrl("sesn_abc", "acme")).toBe(
      `${CLAUDE_CONSOLE_BASE_URL}/workspaces/acme/sessions/sesn_abc`,
    );
  });

  test("url-encodes the workspace and session identifiers", () => {
    expect(sessionConsoleUrl("sesn /1", "team space")).toBe(
      `${CLAUDE_CONSOLE_BASE_URL}/workspaces/team%20space/sessions/sesn%20%2F1`,
    );
  });
});

describe("MAX_THINKING_BUDGET_DEFERRED", () => {
  test("exports the deferred thinking sentinel", () => {
    expect(MAX_THINKING_BUDGET_DEFERRED).toEqual({
      todo: expect.stringMatching(/TODO\(sdk-thinking\)/),
      reason:
        "thinking remains intentionally disabled for Managed Agents on @anthropic-ai/sdk@0.104.1",
    });
  });
});
