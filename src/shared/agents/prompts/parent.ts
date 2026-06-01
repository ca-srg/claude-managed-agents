import { CHILD_AGENT_NAME } from "@/shared/constants";
import { originDisplay, originUrl, type RunOrigin } from "@/shared/run-origin";

export type BuildParentPromptParams = {
  maxSubIssues: number;
  commitStyle: string;
  git: {
    authorName: string;
    authorEmail: string;
  };
  repoOwner: string;
  repoName: string;
  parentIssueNumber?: number;
  origin?: RunOrigin;
  branch: string;
  baseBranch: string;
  /**
   * Repository-specific instructions appended to the runtime prompt as an
   * additional section. The body is passed through verbatim. When omitted or
   * blank, no extra section is rendered (preserving byte-identical output for
   * repositories without an override).
   */
  repoPrompt?: string | null;
  /**
   * Repository-level context loaded from files in the target repository before
   * session start. The preformatted body is appended after any DB-backed repo
   * prompt. When omitted or blank, no extra section is rendered.
   */
  repoContext?: string | null;
};

export function buildParentPrompt(params: BuildParentPromptParams): string {
  if (!params.baseBranch) {
    throw new Error("baseBranch is required");
  }

  const {
    maxSubIssues,
    commitStyle,
    git,
    repoOwner,
    repoName,
    parentIssueNumber,
    origin,
    branch,
    baseBranch,
    repoPrompt,
    repoContext,
  } = params;

  const resolvedOrigin =
    origin ??
    (parentIssueNumber === undefined
      ? null
      : ({
          issueNumber: parentIssueNumber,
          repo: `${repoOwner}/${repoName}`,
          type: "github_issue" as const,
          url: `https://github.com/${repoOwner}/${repoName}/issues/${parentIssueNumber}`,
        } satisfies RunOrigin));

  if (resolvedOrigin === null) {
    throw new Error("origin or parentIssueNumber is required");
  }

  const basePrompt =
    resolvedOrigin.type === "github_issue"
      ? buildGitHubIssuePrompt({
          baseBranch,
          branch,
          commitStyle,
          git,
          maxSubIssues,
          parentIssueNumber: resolvedOrigin.issueNumber,
          repoName,
          repoOwner,
        })
      : buildLinearIssuePrompt({
          baseBranch,
          branch,
          commitStyle,
          git,
          maxSubIssues,
          origin: resolvedOrigin,
          repoName,
          repoOwner,
        });

  const sections = [
    renderRepoPromptSection(repoOwner, repoName, repoPrompt),
    renderRepoContextSection(repoContext),
  ].filter((section): section is string => section !== null);
  return sections.length === 0 ? basePrompt : `${basePrompt}\n\n${sections.join("\n\n")}`;
}

function buildGitHubIssuePrompt(params: {
  baseBranch: string;
  branch: string;
  commitStyle: string;
  git: BuildParentPromptParams["git"];
  maxSubIssues: number;
  parentIssueNumber: number;
  repoName: string;
  repoOwner: string;
}): string {
  return `You are the ORCHESTRATOR (coordinator agent). You do not edit code or run tests directly.
Your goal is to resolve GitHub issue #${params.parentIssueNumber} in ${params.repoOwner}/${params.repoName} by decomposing it into smaller, manageable tasks and delegating each to the \`${CHILD_AGENT_NAME}\` sub-agent through Managed Agents' multi-agent coordinator topology.

MUST NOT edit files directly.
MUST NOT call any \`spawn_child_task\` custom tool — it has been removed. Delegation is performed natively by the coordinator topology: when you address \`${CHILD_AGENT_NAME}\`, the API spawns a session thread and routes your message to it.
MUST follow the attached GitHub App GitHub Operations skill for GitHub authentication, commit, push, and API/MCP fallback behavior.

Follow these steps:

Step 1: Read the issue via the GitHub MCP/API issue-read tool (prefer \`get_issue\` when exposed). Decompose into **no more than ${params.maxSubIssues} atomic sub-tasks**.
MUST NOT delegate to \`${CHILD_AGENT_NAME}\` more than ${params.maxSubIssues} times in total.

Step 2: For each sub-task, call the \`create_sub_issue\` custom tool to track progress on GitHub.
MUST handle \`create_sub_issue\` returning an existing (deduplicated) sub-issue without error.

Step 3: For each sub-task, delegate to the \`${CHILD_AGENT_NAME}\` sub-agent. Send the sub-agent a clear thread message that includes:
- (a) Task spec: title, description, and ordered acceptance criteria.
- (b) Branch checkout-first: \`git fetch && git checkout -B ${params.branch} origin/${params.branch} || git checkout -B ${params.branch} origin/${params.baseBranch}\` then \`git pull --ff-only origin ${params.branch} || true\`
- (c) Commit style = ${params.commitStyle}
- (d) Git identity = ${params.git.authorName}/${params.git.authorEmail}
- (e) MUST run \`bun test\` before commit if the project has it.
- (f) Stable \`taskId\`, so the sub-agent can echo it back to you on completion.
- (g) GitHub operations: follow the attached GitHub App GitHub Operations skill; if local signed commit/push fails because signing, SSH, credential helpers, or loopback MCP helpers are unavailable, use the GitHub MCP/API file commit path on the same branch instead of repairing local auth/signing.

Wait for each sub-agent thread to reply before delegating the next one. Sub-agent threads share the same container and filesystem, so it is safe to delegate sequentially on the same branch.

If a sub-agent reports failure, analyze the error, generate a corrective brief with explicit additional constraints, and re-delegate the same task to \`${CHILD_AGENT_NAME}\` (max 3 retries per task).

Step 4: After every sub-task succeeds, call the \`create_final_pr\` custom tool with a consolidated title and body to close the parent issue.

Step 5: Emit a final \`agent.message\` containing the resulting PR URL and stop. The session will transition to \`session.status_idle\`.`;
}

function buildLinearIssuePrompt(params: {
  baseBranch: string;
  branch: string;
  commitStyle: string;
  git: BuildParentPromptParams["git"];
  maxSubIssues: number;
  origin: Extract<RunOrigin, { type: "linear_issue" }>;
  repoName: string;
  repoOwner: string;
}): string {
  const originLink = originUrl(params.origin);
  const originLine = originLink
    ? `${originDisplay(params.origin)} (${originLink})`
    : originDisplay(params.origin);

  return `You are the ORCHESTRATOR (coordinator agent). You do not edit code or run tests directly.
Your goal is to resolve Linear issue ${originLine} by implementing the required changes in GitHub repository ${params.repoOwner}/${params.repoName}, then delegating implementation work to the \`${CHILD_AGENT_NAME}\` sub-agent through Managed Agents' multi-agent coordinator topology.

MUST NOT edit files directly.
MUST NOT call any \`spawn_child_task\` custom tool — it has been removed. Delegation is performed natively by the coordinator topology: when you address \`${CHILD_AGENT_NAME}\`, the API spawns a session thread and routes your message to it.
MUST NOT use the GitHub-only \`create_sub_issue\` custom tool for Linear-origin runs; create/reuse Linear child/sub-issues with Linear MCP issue tools instead.
MUST follow the attached GitHub App GitHub Operations skill for GitHub authentication, commit, push, and API/MCP fallback behavior.

Follow these steps:

Step 1: Read the Linear issue via the Linear MCP toolset exposed by https://mcp.linear.app/mcp. Prefer \`get_issue\` when available; otherwise use the equivalent issue-read tool exposed by the Linear MCP schema. Use the identifier or URL: ${originLine}. Treat the returned Linear issue id/identifier as \`parentId\` (fallback: \`parentId=${params.origin.identifier}\`). Decompose into **no more than ${params.maxSubIssues} atomic sub-tasks**.
MUST NOT delegate to \`${CHILD_AGENT_NAME}\` more than ${params.maxSubIssues} times in total.

Step 2: For each sub-task, create or reuse exactly one Linear child/sub-issue before delegation. Prefer \`list_issues\` to find existing child issues with \`parentId=<Linear parent issue identifier/id>\` and the same stable \`taskId\`, then prefer \`save_issue\` to create or update the Linear child/sub-issue with \`parentId=<Linear parent issue identifier/id>\`, title, description, ordered acceptance criteria, and stable \`taskId\` that is deterministic across reruns. If \`list_issues\` or \`save_issue\` are not available, use the equivalent issue list/create/update tools from the exposed Linear MCP schema. Reuse matching existing Linear child/sub-issues instead of creating duplicates.

Step 3: For each created/reused Linear child/sub-issue, delegate to the \`${CHILD_AGENT_NAME}\` sub-agent. Send the sub-agent a clear thread message that includes:
- (a) Task spec: Linear child/sub-issue identifier or id, title, description, and ordered acceptance criteria derived from that Linear child/sub-issue.
- (b) Branch checkout-first: \`git fetch && git checkout -B ${params.branch} origin/${params.branch} || git checkout -B ${params.branch} origin/${params.baseBranch}\` then \`git pull --ff-only origin ${params.branch} || true\`
- (c) Commit style = ${params.commitStyle}
- (d) Git identity = ${params.git.authorName}/${params.git.authorEmail}
- (e) MUST run \`bun test\` before commit if the project has it.
- (f) Stable \`taskId\` and \`parentId\`, so the sub-agent can echo them back to you on completion.
- (g) GitHub operations: follow the attached GitHub App GitHub Operations skill; if local signed commit/push fails because signing, SSH, credential helpers, or loopback MCP helpers are unavailable, use the GitHub MCP/API file commit path on the same branch instead of repairing local auth/signing.

Wait for each sub-agent thread to reply before delegating the next one. Sub-agent threads share the same container and filesystem, so it is safe to delegate sequentially on the same branch.

If a sub-agent reports failure, analyze the error, generate a corrective brief with explicit additional constraints, and re-delegate the same Linear child/sub-issue to \`${CHILD_AGENT_NAME}\` (max 3 retries per task).

Step 4: After every sub-task succeeds, call the \`create_final_pr\` custom tool with a consolidated title and body. Do not include GitHub closing keywords such as \`Closes #...\`; the server will append Linear origin provenance.

Step 5: Emit a final \`agent.message\` containing the resulting PR URL and stop. The session will transition to \`session.status_idle\`.`;
}

function renderRepoPromptSection(
  repoOwner: string,
  repoName: string,
  repoPrompt: string | null | undefined,
): string | null {
  if (typeof repoPrompt !== "string") {
    return null;
  }

  const trimmed = repoPrompt.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return `## Repository-specific instructions for ${repoOwner}/${repoName}\n\n${trimmed}\n\nThese instructions take precedence over generic guidance when they conflict, but you MUST still respect the global guardrails above (no direct file edits, sub-task limits, etc.).`;
}

function renderRepoContextSection(repoContext: string | null | undefined): string | null {
  if (typeof repoContext !== "string") {
    return null;
  }

  const trimmed = repoContext.trim();
  return trimmed.length === 0 ? null : trimmed;
}
