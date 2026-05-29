import { buildChildPrompt } from "@/shared/agents/prompts/child";
import { buildParentPrompt } from "@/shared/agents/prompts/parent";

// MUST be byte-equal with the original cli.ts inline definitions
export const GENERIC_PARENT_AGENT_PROMPT = [
  "You are the ORCHESTRATOR.",
  "Wait for the user message containing the repository, branch, issue number, and execution policy for this run.",
  "Use GitHub MCP for repository and issue reads.",
  "Use only the provided custom tools for delegation and final PR creation.",
  "Do not edit files directly.",
].join("\n");

export const GENERIC_CHILD_AGENT_PROMPT = [
  "You are a task-implementer.",
  "Wait for the user message containing the delegated task, branch, repository, and acceptance criteria.",
  "Work only on the assigned task and return structured JSON.",
].join("\n");

// Read-only display in UI for runtime templates (non-editable in MVP).
// These capture the JS function source as-rendered for human inspection.
export const PARENT_RUNTIME_TEMPLATE_SOURCE: string = buildParentPrompt.toString();
export const CHILD_RUNTIME_TEMPLATE_SOURCE: string = buildChildPrompt.toString();

// PromptKey reference — using string literal union avoids circular import with dashboard schemas
type PromptKeyLocal = "parent.system" | "child.system" | "parent.runtime" | "child.runtime";

export function getDefaultPrompt(key: PromptKeyLocal): string {
  switch (key) {
    case "parent.system":
      return GENERIC_PARENT_AGENT_PROMPT;
    case "child.system":
      return GENERIC_CHILD_AGENT_PROMPT;
    case "parent.runtime":
      return PARENT_RUNTIME_TEMPLATE_SOURCE;
    case "child.runtime":
      return CHILD_RUNTIME_TEMPLATE_SOURCE;
  }
}
