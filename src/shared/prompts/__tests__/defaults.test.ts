import { describe, expect, it } from "bun:test";
import {
  CHILD_RUNTIME_TEMPLATE_SOURCE,
  GENERIC_CHILD_AGENT_PROMPT,
  GENERIC_PARENT_AGENT_PROMPT,
  getDefaultPrompt,
  PARENT_RUNTIME_TEMPLATE_SOURCE,
} from "@/shared/prompts/defaults";

describe("default prompt constants (byte-equal canonical source)", () => {
  it("parent system prompt is the orchestrator brief", () => {
    expect(GENERIC_PARENT_AGENT_PROMPT).toBe(
      [
        "You are the ORCHESTRATOR.",
        "Wait for the user message containing the repository, branch, issue number, and execution policy for this run.",
        "Use GitHub MCP for repository and issue reads.",
        "Use only the provided custom tools for delegation and final PR creation.",
        "Do not edit files directly.",
      ].join("\n"),
    );
  });

  it("child system prompt is the implementer brief", () => {
    expect(GENERIC_CHILD_AGENT_PROMPT).toBe(
      [
        "You are a task-implementer.",
        "Wait for the user message containing the delegated task, branch, repository, and acceptance criteria.",
        "Work only on the assigned task and return structured JSON.",
      ].join("\n"),
    );
  });

  it("getDefaultPrompt returns canonical sources for editable keys", () => {
    expect(getDefaultPrompt("parent.system")).toBe(GENERIC_PARENT_AGENT_PROMPT);
    expect(getDefaultPrompt("child.system")).toBe(GENERIC_CHILD_AGENT_PROMPT);
  });

  it("runtime template sources are non-empty function bodies", () => {
    expect(PARENT_RUNTIME_TEMPLATE_SOURCE.length > 0).toBe(true);
    expect(CHILD_RUNTIME_TEMPLATE_SOURCE.length > 0).toBe(true);
    expect(getDefaultPrompt("parent.runtime")).toBe(PARENT_RUNTIME_TEMPLATE_SOURCE);
    expect(getDefaultPrompt("child.runtime")).toBe(CHILD_RUNTIME_TEMPLATE_SOURCE);
  });
});
