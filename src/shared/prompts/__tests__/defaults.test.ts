import { describe, expect, it } from "bun:test";
import {
  CHILD_RUNTIME_TEMPLATE_SOURCE,
  CHILD_SYSTEM_BLOCKER_RETRY_RULES,
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
        "Use the attached GitHub App GitHub Operations skill for repository, issue, commit, push, and PR behavior.",
        "Use only the provided custom tools for delegation and final PR creation.",
        "Do not edit files directly.",
        "Language policy:",
        "- MUST write GitHub sub-issue bodies, Linear child/sub-issue bodies, pull request bodies, delegated task specs, acceptance criteria, and final user-visible summaries in Japanese.",
        "- MUST write PR titles, commit messages, and GitHub/Linear issue titles in English using Conventional Commits format (`type(scope): subject`; omit scope when not useful).",
        "- Use English for terms that are commonly written in English in developer workflows, such as code identifiers, file paths, branch names, commit types/scopes, tool names, JSON keys, URLs, log snippets, error names, quoted source text, and GitHub closing keywords such as `Closes #...`.",
      ].join("\n"),
    );
  });

  it("child system prompt is the implementer brief", () => {
    expect(GENERIC_CHILD_AGENT_PROMPT).toBe(
      [
        "You are a task-implementer.",
        "Wait for the user message containing the delegated task, branch, repository, and acceptance criteria.",
        "Use the attached GitHub App GitHub Operations skill for repository, commit, and push behavior.",
        "Work only on the assigned task and return structured JSON.",
        "Commit messages must be written in English using Conventional Commits format (`type(scope): subject`; omit scope when not useful).",
        "Write human-readable JSON string values in Japanese. Use English for JSON keys, code identifiers, file paths, logs, quoted source text, and other terms that are commonly written in English in developer workflows.",
        "",
        CHILD_SYSTEM_BLOCKER_RETRY_RULES,
      ].join("\n"),
    );
  });

  it("child system prompt includes blocker schema and auth retry guidance", () => {
    expect(GENERIC_CHILD_AGENT_PROMPT).toContain("MCP/API authentication failures:");
    expect(GENERIC_CHILD_AGENT_PROMPT).toContain(
      "wait about 60 seconds (e.g. `sleep 60`) and retry the failing call, up to two spaced retries",
    );
    expect(GENERIC_CHILD_AGENT_PROMPT).toContain('"status": "blocked"');
    expect(GENERIC_CHILD_AGENT_PROMPT).toContain("`error.type` set to `unresolvable_instructions`");
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
