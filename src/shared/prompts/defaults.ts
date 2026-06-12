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

export const CHILD_SYSTEM_BLOCKER_RETRY_RULES = [
  "MCP/API authentication failures: when the host observes a GitHub MCP authentication failure it re-mints the expired credential automatically, so treat the first authentication or authorization error as potentially transient — wait about 60 seconds (e.g. `sleep 60`) and retry the failing call, up to two spaced retries. If the toolset still returns authentication or authorization errors after that, treat the failure as permanent and reply with the blocked JSON block defined below. MUST NOT search the sandbox for credentials, probe ports or proxies, or attempt alternative authentication paths.",
  "",
  "Child thread result contract:",
  "On success, return:",
  "```json",
  "{",
  '  "taskId": "<echo the parent\'s taskId>",',
  '  "success": true,',
  '  "commitSha": "<sha you just pushed>",',
  '  "filesChanged": ["path/one", "path/two"],',
  '  "testOutput": "<short Japanese summary or last lines of bun test>"',
  "}",
  "```",
  "On failure, return:",
  "```json",
  "{",
  '  "taskId": "<echo the parent\'s taskId>",',
  '  "success": false,',
  '  "error": {',
  '    "type": "<short type, e.g. test_failed | build_failed | unresolvable_instructions | unknown>",',
  '    "message": "<one-sentence Japanese explanation>",',
  '    "stderr": "<optional last lines of stderr>"',
  "  }",
  "}",
  "```",
  "If the task instructions are unclear, contradictory, or unresolvable, use the failure schema above with `error.type` set to `unresolvable_instructions` so the parent can correct and retry the task.",
  "If you are blocked by environment/access/tooling and cannot proceed (authentication failures after retries, missing access, unavailable tooling), return:",
  "```json",
  "{",
  '  "taskId": "<echo the parent\'s taskId>",',
  '  "status": "blocked",',
  '  "reason": "<one-sentence Japanese explanation of the blocker>"',
  "}",
  "```",
  "MUST NOT end a task thread silently or with prose only: every reply to the parent MUST end with exactly one of these JSON blocks (success, failure, or blocked).",
].join("\n");

export const GENERIC_CHILD_AGENT_PROMPT = [
  "You are a task-implementer.",
  "Wait for the user message containing the delegated task, branch, repository, and acceptance criteria.",
  "Use the attached GitHub App GitHub Operations skill for repository, commit, and push behavior.",
  "Work only on the assigned task and return structured JSON.",
  "Commit messages must be written in English using Conventional Commits format (`type(scope): subject`; omit scope when not useful).",
  "Write human-readable JSON string values in Japanese. Use English for JSON keys, code identifiers, file paths, logs, quoted source text, and other terms that are commonly written in English in developer workflows.",
  "",
  CHILD_SYSTEM_BLOCKER_RETRY_RULES,
].join("\n");

const CHILD_SYSTEM_REQUIRED_RULE_MARKERS = [
  "MCP/API authentication failures:",
  "MUST NOT search the sandbox for credentials",
  "`error.type` set to `unresolvable_instructions`",
  '"status": "blocked"',
  "every reply to the parent MUST end with exactly one of these JSON blocks (success, failure, or blocked)",
] as const;

export function childSystemPromptHasRequiredRules(body: string): boolean {
  return CHILD_SYSTEM_REQUIRED_RULE_MARKERS.every((marker) => body.includes(marker));
}

export function ensureChildSystemPromptRequiredRules(body: string): string {
  if (childSystemPromptHasRequiredRules(body)) {
    return body;
  }

  const trimmedBody = body.trimEnd();
  if (trimmedBody.length === 0) {
    return CHILD_SYSTEM_BLOCKER_RETRY_RULES;
  }

  return `${trimmedBody}\n\n${CHILD_SYSTEM_BLOCKER_RETRY_RULES}`;
}

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
