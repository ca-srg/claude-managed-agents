import { createHash } from "node:crypto";
import { toFile } from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSkillParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { SkillCreateParams } from "@anthropic-ai/sdk/resources/beta/skills/skills";

export const GITHUB_OPERATIONS_SKILL_KEY = "github_operations";

export const GITHUB_OPERATIONS_SKILL_DISPLAY_TITLE = "GitHub App GitHub Operations";

const GITHUB_OPERATIONS_SKILL_FILE_NAME = "SKILL.md";

export const GITHUB_OPERATIONS_SKILL_MARKDOWN = `---
name: github-app-github-operations
description: Use when a Claude Managed Agents session needs to read GitHub issues, inspect a GitHub repository, edit files, commit, push, or open pull requests using the repository GitHub App authorization.
---

# GitHub App GitHub Operations

This Managed Agents session receives repository access through the GitHub App-backed \`github_repository\` resource and the GitHub MCP/API credentials prepared by the host service. Treat those credentials as the only supported GitHub identity for the run.

## Authentication model

- Do not ask for, create, or assume a personal access token, SSH key, deploy key, or user-scoped credential.
- Do not try to repair local commit-signing infrastructure. In hosted sessions the signer may depend on a local helper such as \`/tmp/code-sign\`, \`/usr/local/bin/environment-manager\`, a loopback MCP port, or \`/home/claude/.ssh/commit_signing_key.pub\`; those may be unavailable or intentionally empty.
- GitHub API/MCP commits are expected to use the GitHub App token identity. Do not try to spoof \`claude-agent[bot]\` as the API author/committer when the API token identity is different.
- Keep all writes on the run's working branch. Never push directly to the base branch.

## Repository workflow

1. Work inside the mounted repository path provided in the session resource, usually \`/workspace/<repo>\`.
2. Use git for read-only inspection, checkout, diff, status, and tests whenever it works with the provided remote.
3. Before changing files, sync the assigned branch from origin or create it from the base branch exactly as instructed by the orchestrator.
4. After edits, run the repository's required checks before committing when available. At minimum, run the explicit checks requested by the task or prompt.
5. Inspect the final diff and include only intended files.

## Commit and push decision

- Prefer a normal local \`git commit\` and \`git push\` only when they succeed without changing authentication or signing setup.
- If local commit or push fails because signing, SSH, credential helpers, or a loopback MCP helper are unavailable, stop retrying that path. Do not disable signing globally, create new keys, or modify credential configuration.
- In that failure mode, create the commit on the target branch through the GitHub MCP/API file commit operation (for example, a \`push_files\`-style tool when available) using the final file snapshot from the workspace.
- When using a GitHub API/MCP file commit, preserve the same branch, commit message style, and file contents that would have been committed locally. Report the commit SHA returned by the API/tool.

## GitHub issue and pull request operations

- Use GitHub MCP/API tools for GitHub issue reads, comments, branch/file commits, and PR metadata when those operations are needed.
- The coordinator must use the host-provided custom tools for creating sub-issues and the final pull request when those tools are available in the prompt.
- If both a custom tool and a GitHub MCP/API tool could perform the same orchestration action, prefer the custom tool named by the host prompt because it preserves the service's run bookkeeping.
`;

export type GitHubOperationsSkillRef = {
  skillId: string;
  skillVersion: string;
};

export function hashGitHubOperationsSkill(): string {
  return createHash("sha256")
    .update(GITHUB_OPERATIONS_SKILL_FILE_NAME)
    .update("\0")
    .update(GITHUB_OPERATIONS_SKILL_MARKDOWN)
    .digest("hex");
}

export async function buildGitHubOperationsSkillFiles(): Promise<
  NonNullable<SkillCreateParams["files"]>
> {
  return [
    await toFile(
      new Blob([GITHUB_OPERATIONS_SKILL_MARKDOWN], { type: "text/markdown" }),
      GITHUB_OPERATIONS_SKILL_FILE_NAME,
    ),
  ];
}

export function toGitHubOperationsSkillParams(
  ref: GitHubOperationsSkillRef,
): BetaManagedAgentsSkillParams {
  return {
    skill_id: ref.skillId,
    type: "custom",
    version: ref.skillVersion,
  };
}
