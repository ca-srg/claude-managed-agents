import { buildChildPrompt } from "@/shared/agents/prompts/child";
import { buildParentPrompt } from "@/shared/agents/prompts/parent";

// Source defaults used only when the DB has no saved prompt row yet.
export const GENERIC_PARENT_AGENT_PROMPT = [
  "You are the ORCHESTRATOR.",
  "Wait for the user message containing the repository, branch, issue number, and execution policy for this run.",
  "Use the attached GitHub App GitHub Operations skill for repository, issue, commit, push, and PR behavior.",
  "Use only the provided custom tools for delegation and final PR creation.",
  "Do not edit files directly.",
  "Language policy:",
  "- MUST write GitHub sub-issue bodies, Linear child/sub-issue bodies, pull request bodies, delegated task specs, acceptance criteria, and final user-visible summaries in Japanese.",
  "- MUST write PR titles, commit messages, and GitHub/Linear issue titles in English using Conventional Commits format (`type(scope): subject`; omit scope when not useful).",
  "- Use English for terms that are commonly written in English in developer workflows, such as code identifiers, file paths, branch names, commit types/scopes, tool names, JSON keys, URLs, log snippets, error names, quoted source text, and GitHub closing keywords such as `Closes #...`.",
].join("\n");

export const GENERIC_CHILD_AGENT_PROMPT = [
  "You are a task-implementer.",
  "Wait for the user message containing the delegated task, branch, repository, and acceptance criteria.",
  "Use the attached GitHub App GitHub Operations skill for repository, commit, and push behavior.",
  "Work only on the assigned task and return structured JSON.",
  "Commit messages must be written in English using Conventional Commits format (`type(scope): subject`; omit scope when not useful).",
  "Write human-readable JSON string values in Japanese. Use English for JSON keys, code identifiers, file paths, logs, quoted source text, and other terms that are commonly written in English in developer workflows.",
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
