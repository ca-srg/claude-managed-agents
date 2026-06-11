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
  repositories?: Array<{
    baseBranch: string;
    mountPath: string;
    repoName: string;
    repoOwner: string;
    role: "primary" | "target";
  }>;
  parentIssueNumber?: number;
  origin?: RunOrigin;
  branch: string;
  baseBranch: string;
  /**
   * Repository-specific instructions appended to the runtime prompt as an
   * additional section. The body is passed through verbatim. When omitted or
   * blank, no extra section is rendered (preserving byte-identical output for
   * repositories without an override).
   *
   * @deprecated Prefer `repoPrompts` for multi-repository runs. This remains as
   * a fallback for callers that only pass the primary repository override.
   */
  repoPrompt?: string | null;
  /**
   * Repository-specific instructions for all repositories mounted in the run.
   * Each non-blank body is rendered under a repository-scoped heading before
   * repository context. When provided, this takes precedence over `repoPrompt`.
   */
  repoPrompts?: Array<{
    repoName: string;
    repoOwner: string;
    repoPrompt?: string | null;
  }>;
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
    repositories,
    parentIssueNumber,
    origin,
    branch,
    baseBranch,
    repoPrompt,
    repoPrompts,
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

  const repositoryList = repositories?.length
    ? repositories
    : [
        {
          baseBranch,
          mountPath: `/workspace/${repoName}`,
          repoName,
          repoOwner,
          role: "primary" as const,
        },
      ];

  const basePrompt =
    resolvedOrigin.type === "github_issue"
      ? buildGitHubIssuePrompt({
          baseBranch,
          branch,
          commitStyle,
          git,
          maxSubIssues,
          parentIssueNumber: resolvedOrigin.issueNumber,
          repositories: repositoryList,
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
          repositories: repositoryList,
          repoName,
          repoOwner,
        });

  const repoPromptSections = (
    repoPrompts === undefined
      ? [renderRepoPromptSection(repoOwner, repoName, repoPrompt)]
      : repoPrompts.map((repoPromptEntry) =>
          renderRepoPromptSection(
            repoPromptEntry.repoOwner,
            repoPromptEntry.repoName,
            repoPromptEntry.repoPrompt,
          ),
        )
  ).filter((section): section is string => section !== null);
  const sections = [...repoPromptSections, renderRepoContextSection(repoContext)].filter(
    (section): section is string => section !== null,
  );
  return sections.length === 0 ? basePrompt : `${basePrompt}\n\n${sections.join("\n\n")}`;
}

function buildGitHubIssuePrompt(params: {
  baseBranch: string;
  branch: string;
  commitStyle: string;
  git: BuildParentPromptParams["git"];
  maxSubIssues: number;
  parentIssueNumber: number;
  repositories: NonNullable<BuildParentPromptParams["repositories"]>;
  repoName: string;
  repoOwner: string;
}): string {
  const multiRepoSection = renderWorkspaceRepositoriesSection(params.repositories, params.branch);
  return `You are the ORCHESTRATOR (coordinator agent). You do not edit code or run tests directly.
Your goal is to resolve GitHub issue #${params.parentIssueNumber} in ${params.repoOwner}/${params.repoName} by decomposing it into smaller, manageable tasks and delegating each to the \`${CHILD_AGENT_NAME}\` sub-agent through Managed Agents' multi-agent coordinator topology. Work may span any registered repository mounted in this session.

MUST NOT edit files directly.
MUST NOT call any \`spawn_child_task\` custom tool — it has been removed. Delegation is performed natively by the coordinator topology: when you address \`${CHILD_AGENT_NAME}\`, the API spawns a session thread and routes your message to it.
MUST follow the attached GitHub App GitHub Operations skill for GitHub authentication, commit, push, and API/MCP fallback behavior.

Language policy:
- MUST write GitHub sub-issue bodies, Linear child/sub-issue bodies, pull request bodies, delegated task specs, acceptance criteria, and final user-visible summaries in Japanese.
- MUST write PR titles, commit messages, and GitHub/Linear issue titles in English using Conventional Commits format (\`type(scope): subject\`; omit scope when not useful).
- Use English for terms that are commonly written in English in developer workflows, such as code identifiers, file paths, branch names, commit types/scopes, tool names, JSON keys, URLs, log snippets, error names, quoted source text, and GitHub closing keywords such as \`Closes #...\`.

${multiRepoSection}

Follow these steps:

Step 1: Read the issue via the GitHub MCP/API issue-read tool (prefer \`get_issue\` when exposed). Decompose into **no more than ${params.maxSubIssues} atomic sub-tasks**.
MUST NOT delegate to \`${CHILD_AGENT_NAME}\` more than ${params.maxSubIssues} times in total.

Step 2: For each sub-task, call the \`create_sub_issue\` custom tool to track progress on GitHub.
MUST pass an English Conventional Commits \`title\` and a Japanese \`body\` to \`create_sub_issue\`.
MUST handle \`create_sub_issue\` returning an existing (deduplicated) sub-issue without error.

Step 3: For each sub-task, decide which registered repository or repositories it touches, then delegate to the \`${CHILD_AGENT_NAME}\` sub-agent. Send the sub-agent a clear thread message that includes:
- (a) Task spec: English Conventional Commits title, Japanese description, and ordered acceptance criteria in Japanese.
- (b) Repository scope and mount paths. For every touched repository, run its checkout-first command from the table above before editing.
- (c) Configured commit style = ${params.commitStyle}; commit messages, PR titles, and issue titles MUST still use English Conventional Commits (\`type(scope): subject\`).
- (d) Git identity = ${params.git.authorName}/${params.git.authorEmail}
- (e) MUST run \`bun test\` before commit if the project has it.
- (f) Stable \`taskId\`, so the sub-agent can echo it back to you on completion.
- (g) GitHub operations: follow the attached GitHub App GitHub Operations skill; if local signed commit/push fails because signing, SSH, credential helpers, or loopback MCP helpers are unavailable, use the GitHub MCP/API file commit path on the same branch instead of repairing local auth/signing.

Wait for each sub-agent thread to reply before delegating the next one. Sub-agent threads share the same container and filesystem, so it is safe to delegate sequentially on the same branch.

If a sub-agent reports failure, analyze the error, generate a corrective brief with explicit additional constraints, and re-delegate the same task to \`${CHILD_AGENT_NAME}\` (max 3 retries per task).

Step 4: After every sub-task succeeds, call the \`create_final_pr\` custom tool with a consolidated English Conventional Commits title and Japanese body for the primary GitHub issue repository (${params.repoOwner}/${params.repoName}) to close the parent issue. If changes were made in other registered repositories, create or update their PRs with GitHub MCP/API tools and include those PR URLs in the final message.

Step 5: If the system prompt defines post-PR follow-up work (for example CI check polling or review-comment handling), complete that follow-up before stopping. Emit a final \`agent.message\` containing the resulting PR URL and stop. The session will transition to \`session.status_idle\`.`;
}

function buildLinearIssuePrompt(params: {
  baseBranch: string;
  branch: string;
  commitStyle: string;
  git: BuildParentPromptParams["git"];
  maxSubIssues: number;
  origin: Extract<RunOrigin, { type: "linear_issue" }>;
  repositories: NonNullable<BuildParentPromptParams["repositories"]>;
  repoName: string;
  repoOwner: string;
}): string {
  const originLink = originUrl(params.origin);
  const originLine = originLink
    ? `${originDisplay(params.origin)} (${originLink})`
    : originDisplay(params.origin);

  const multiRepoSection = renderWorkspaceRepositoriesSection(params.repositories, params.branch);

  return `You are the ORCHESTRATOR (coordinator agent). You do not edit code or run tests directly.
Your goal is to resolve Linear issue ${originLine} by implementing the required changes across the registered GitHub repositories mounted in this session, then delegating implementation work to the \`${CHILD_AGENT_NAME}\` sub-agent through Managed Agents' multi-agent coordinator topology.

MUST NOT edit files directly.
MUST NOT call any \`spawn_child_task\` custom tool — it has been removed. Delegation is performed natively by the coordinator topology: when you address \`${CHILD_AGENT_NAME}\`, the API spawns a session thread and routes your message to it.
MUST NOT use the GitHub-only \`create_sub_issue\` custom tool for Linear-origin runs; create/reuse Linear child/sub-issues with Linear MCP issue tools instead.
MUST follow the attached GitHub App GitHub Operations skill for GitHub authentication, commit, push, and API/MCP fallback behavior.

Language policy:
- MUST write GitHub sub-issue bodies, Linear child/sub-issue bodies, pull request bodies, delegated task specs, acceptance criteria, and final user-visible summaries in Japanese.
- MUST write PR titles, commit messages, and GitHub/Linear issue titles in English using Conventional Commits format (\`type(scope): subject\`; omit scope when not useful).
- Use English for terms that are commonly written in English in developer workflows, such as code identifiers, file paths, branch names, commit types/scopes, tool names, JSON keys, URLs, log snippets, error names, quoted source text, and GitHub closing keywords such as \`Closes #...\`.

${multiRepoSection}

Follow these steps:

Step 1: Read the Linear issue via the Linear MCP toolset exposed by https://mcp.linear.app/mcp. Prefer \`get_issue\` when available; otherwise use the equivalent issue-read tool exposed by the Linear MCP schema. Use the identifier or URL: ${originLine}. Treat the returned Linear issue id/identifier as \`parentId\` (fallback: \`parentId=${params.origin.identifier}\`). Decompose into **no more than ${params.maxSubIssues} atomic sub-tasks**.
MUST NOT delegate to \`${CHILD_AGENT_NAME}\` more than ${params.maxSubIssues} times in total.

Step 2: For each sub-task, create or reuse exactly one Linear child/sub-issue before delegation. Prefer \`list_issues\` to find existing child issues with \`parentId=<Linear parent issue identifier/id>\` and the same stable \`taskId\`, then prefer \`save_issue\` to create or update the Linear child/sub-issue with \`parentId=<Linear parent issue identifier/id>\`, English Conventional Commits title, Japanese description, ordered Japanese acceptance criteria, and stable \`taskId\` that is deterministic across reruns. \`save_issue\` distinguishes create vs update solely by the presence of \`id\`: omit \`id\` to create a new issue (\`title\` and \`team\` required) and pass \`id\` to update an existing one. MUST NOT pass any \`method\`, \`action\`, \`mode\`, or similar create/update selector argument — \`save_issue\` rejects unknown keys. If \`list_issues\` or \`save_issue\` are not available, use the equivalent issue list/create/update tools from the exposed Linear MCP schema. Reuse matching existing Linear child/sub-issues instead of creating duplicates.

Step 3: For each created/reused Linear child/sub-issue, delegate to the \`${CHILD_AGENT_NAME}\` sub-agent after deciding which registered repository or repositories it touches. Send the sub-agent a clear thread message that includes:
- (a) Task spec: Linear child/sub-issue identifier or id, English Conventional Commits title, Japanese description, and ordered acceptance criteria in Japanese, derived from that Linear child/sub-issue.
- (b) Repository scope and mount paths. For every touched repository, run its checkout-first command from the table above before editing.
- (c) Configured commit style = ${params.commitStyle}; commit messages, PR titles, and issue titles MUST still use English Conventional Commits (\`type(scope): subject\`).
- (d) Git identity = ${params.git.authorName}/${params.git.authorEmail}
- (e) MUST run \`bun test\` before commit if the project has it.
- (f) Stable \`taskId\` and \`parentId\`, so the sub-agent can echo them back to you on completion.
- (g) GitHub operations: follow the attached GitHub App GitHub Operations skill; if local signed commit/push fails because signing, SSH, credential helpers, or loopback MCP helpers are unavailable, use the GitHub MCP/API file commit path on the same branch instead of repairing local auth/signing.

Wait for each sub-agent thread to reply before delegating the next one. Sub-agent threads share the same container and filesystem, so it is safe to delegate sequentially on the same branch.

If a sub-agent reports failure, analyze the error, generate a corrective brief with explicit additional constraints, and re-delegate the same Linear child/sub-issue to \`${CHILD_AGENT_NAME}\` (max 3 retries per task).

Step 4: After every sub-task succeeds, call the \`create_final_pr\` custom tool with a consolidated English Conventional Commits title and Japanese body for the primary tracking repository (${params.repoOwner}/${params.repoName}). Do not include GitHub closing keywords such as \`Closes #...\`; the server will append Linear origin provenance. If changes were made in other registered repositories, create or update their PRs with GitHub MCP/API tools and include those PR URLs in the final message.

Step 5: If the system prompt defines post-PR follow-up work (for example CI check polling or review-comment handling), complete that follow-up before stopping. Emit a final \`agent.message\` containing the resulting PR URL and stop. The session will transition to \`session.status_idle\`.`;
}

function renderWorkspaceRepositoriesSection(
  repositories: NonNullable<BuildParentPromptParams["repositories"]>,
  branch: string,
): string {
  const rows = repositories
    .map((repository) => {
      const repo = `${repository.repoOwner}/${repository.repoName}`;
      const checkout = `git -C ${repository.mountPath} fetch && (git -C ${repository.mountPath} checkout -B ${branch} origin/${branch} || git -C ${repository.mountPath} checkout -B ${branch} origin/${repository.baseBranch}) && (git -C ${repository.mountPath} pull --ff-only origin ${branch} || true)`;
      return `- ${repo} (${repository.role})\n  - mount: ${repository.mountPath}\n  - base: ${repository.baseBranch}\n  - checkout-first: \`${checkout}\``;
    })
    .join("\n");

  return `## Registered repositories mounted for this run\n\n${rows}\n\nUse one branch name across repositories: \`${branch}\`. Only edit repositories that are needed for the issue. When multiple repositories are touched, keep commits and PRs scoped per repository.`;
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
