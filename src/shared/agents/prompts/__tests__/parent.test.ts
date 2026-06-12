import { describe, expect, it } from "bun:test";
import { buildParentPrompt } from "../parent";

describe("buildParentPrompt", () => {
  const defaultParams = {
    maxSubIssues: 10,
    commitStyle: "conventional",
    git: {
      authorName: "claude-agent[bot]",
      authorEmail: "claude-agent@users.noreply.github.com",
    },
    repoOwner: "rluisr",
    repoName: "claude-managed-agents",
    parentIssueNumber: 123,
    branch: "agent/issue-123/fix-bug",
    baseBranch: "main",
  };

  it("should contain all mandatory phrases", () => {
    const prompt = buildParentPrompt(defaultParams);

    expect(prompt).toContain(
      "You are the ORCHESTRATOR (coordinator agent). You do not edit code or run tests directly.",
    );
    expect(prompt).toContain("GitHub issue #123 in rluisr/claude-managed-agents");
    expect(prompt).toContain("no more than 10 atomic sub-tasks");
    expect(prompt).toContain("call the `create_sub_issue` custom tool");
    expect(prompt).toContain("delegate to the `github-issue-implementer` sub-agent");
    expect(prompt).toContain(
      "MUST NOT call any `spawn_child_task` custom tool — it has been removed",
    );
    expect(prompt).toContain("GitHub App GitHub Operations skill");
    expect(prompt).toContain("GitHub MCP/API issue-read tool");
    expect(prompt).toContain(
      "git -C /workspace/claude-managed-agents fetch && (git -C /workspace/claude-managed-agents checkout -B agent/issue-123/fix-bug origin/agent/issue-123/fix-bug || git -C /workspace/claude-managed-agents checkout -B agent/issue-123/fix-bug origin/main)",
    );
    expect(prompt).toContain(
      "(git -C /workspace/claude-managed-agents pull --ff-only origin agent/issue-123/fix-bug || true)",
    );
    expect(prompt).toContain("Configured commit style = conventional");
    expect(prompt).toContain(
      "Git identity = claude-agent[bot]/claude-agent@users.noreply.github.com",
    );
    expect(prompt).toContain("MUST run `bun test` before commit if the project has it");
    expect(prompt).toContain("use the GitHub MCP/API file commit path on the same branch");
    expect(prompt).toContain(
      "call the `create_final_pr` custom tool with a consolidated English Conventional Commits title and Japanese body",
    );
    expect(prompt).toContain("Language policy:");
    expect(prompt).toContain(
      "MUST write GitHub sub-issue bodies, Linear child/sub-issue bodies, pull request bodies",
    );
    expect(prompt).toContain(
      "MUST write PR titles, commit messages, and GitHub/Linear issue titles in English using Conventional Commits format",
    );
    expect(prompt).toContain(
      "Use English for terms that are commonly written in English in developer workflows",
    );
    expect(prompt).toContain(
      "MUST pass an English Conventional Commits `title` and a Japanese `body` to `create_sub_issue`",
    );
    expect(prompt).toContain(
      "English Conventional Commits title, Japanese description, and ordered acceptance criteria in Japanese",
    );
    expect(prompt).toContain(
      "If the system prompt defines post-PR follow-up work (for example CI check polling or review-comment handling), complete that follow-up before stopping",
    );
    expect(prompt).toContain("it re-mints the expired credential automatically");
    expect(prompt).toContain(
      "wait about 60 seconds (e.g. `sleep 60`) and retry the failing call, up to two spaced retries",
    );
    expect(prompt).toContain(
      "MUST NOT search the sandbox for credentials, probe ports or proxies, or attempt alternative authentication paths",
    );
    expect(prompt).toContain(
      'If a sub-agent replies with `"status": "blocked"`, treat environmental blockers (authentication failures, missing access, unavailable tooling) as permanent',
    );
    expect(prompt).toContain(
      "do NOT treat the missing data as a pass — report the blocker in your final `agent.message` and stop instead of approving",
    );
    expect(prompt).toContain(
      "Emit a final `agent.message` containing the resulting PR URL and stop",
    );
    expect(prompt).toContain("MUST NOT edit files directly");
    expect(prompt).toContain("MUST NOT delegate to `github-issue-implementer` more than 10 times");
    expect(prompt).toContain(
      "MUST handle `create_sub_issue` returning an existing (deduplicated) sub-issue without error",
    );
    expect(prompt).toContain(
      "If a sub-agent reports failure, analyze the error, generate a corrective brief",
    );
    expect(prompt).toContain("(max 3 retries per task)");
  });

  it("should interpolate configuration values correctly", () => {
    const params = {
      ...defaultParams,
      maxSubIssues: 5,
      commitStyle: "gitmoji",
      git: {
        authorName: "custom-bot",
        authorEmail: "custom@example.com",
      },
      baseBranch: "develop",
    };
    const prompt = buildParentPrompt(params);

    expect(prompt).toContain("no more than 5 atomic sub-tasks");
    expect(prompt).toContain("MUST NOT delegate to `github-issue-implementer` more than 5 times");
    expect(prompt).toContain("Configured commit style = gitmoji");
    expect(prompt).toContain("Git identity = custom-bot/custom@example.com");
    expect(prompt).toContain("origin/develop");

    expect(prompt).not.toContain("{maxSubIssues}");
    expect(prompt).not.toContain("{commitStyle}");
    expect(prompt).not.toContain("{authorName}");
    expect(prompt).not.toContain("{authorEmail}");
    expect(prompt).not.toContain("{baseBranch}");
  });

  it("scopes checkout-first failure tolerance to pull only", () => {
    const prompt = buildParentPrompt(defaultParams);
    const checkoutCommand = prompt.match(/checkout-first: `([^`]+)`/)?.[1];

    expect(checkoutCommand).toBeDefined();
    expect(checkoutCommand).toContain("git -C /workspace/claude-managed-agents fetch &&");
    expect(checkoutCommand).toContain(
      "(git -C /workspace/claude-managed-agents pull --ff-only origin agent/issue-123/fix-bug || true)",
    );
    expect(checkoutCommand).not.toContain(
      "origin/main) && git -C /workspace/claude-managed-agents pull --ff-only origin agent/issue-123/fix-bug || true",
    );
    expect(checkoutCommand?.endsWith("|| true)")).toBe(true);
  });

  it("instructs Linear-origin runs to create or reuse Linear sub-issues before delegation", () => {
    const prompt = buildParentPrompt({
      ...defaultParams,
      origin: {
        identifier: "ENG-123",
        title: "Fix Linear-origin orchestration",
        type: "linear_issue",
        url: "https://linear.app/acme/issue/ENG-123/fix-linear-origin-orchestration",
      },
      parentIssueNumber: undefined,
    });

    expect(prompt).toContain("Linear issue ENG-123");
    expect(prompt).toContain("Read the Linear issue via the Linear MCP toolset");
    expect(prompt).toContain("Prefer `get_issue` when available");
    expect(prompt).toContain(
      "create or reuse exactly one Linear child/sub-issue before delegation",
    );
    expect(prompt).toContain("Prefer `list_issues`");
    expect(prompt).toContain("prefer `save_issue`");
    expect(prompt).toContain("parentId=<Linear parent issue identifier/id>");
    expect(prompt).toContain("fallback: `parentId=ENG-123`");
    expect(prompt).toContain("same stable `taskId`");
    expect(prompt).toContain("English Conventional Commits title, Japanese description");
    expect(prompt).toContain("ordered Japanese acceptance criteria");
    expect(prompt).toContain("Reuse matching existing Linear child/sub-issues");
    expect(prompt).toContain(
      "MUST NOT use the GitHub-only `create_sub_issue` custom tool for Linear-origin runs",
    );
    expect(prompt).toContain("stable `taskId` that is deterministic across reruns");
    expect(prompt).toContain(
      "MUST NOT pass any `method`, `action`, `mode`, or similar create/update selector argument",
    );
    expect(prompt).toContain(
      "For each created/reused Linear child/sub-issue, delegate to the `github-issue-implementer` sub-agent",
    );
    expect(prompt).toContain("Linear child/sub-issue identifier or id");
    expect(prompt).toContain("Stable `taskId` and `parentId`");
    expect(prompt).toContain(
      "Wait for each sub-agent thread to reply before delegating the next one",
    );
    expect(prompt).toContain("re-delegate the same Linear child/sub-issue");
    expect(prompt).toContain("(max 3 retries per task)");
    expect(prompt).toContain(
      "call the `create_final_pr` custom tool with a consolidated English Conventional Commits title and Japanese body",
    );
    expect(prompt).not.toContain("MUST NOT call the `create_sub_issue` custom tool for this run");
    expect(prompt).not.toContain("There is no parent GitHub issue for Linear-origin runs");
  });

  it("should throw an error if baseBranch is an empty string at runtime", () => {
    expect(() => buildParentPrompt({ ...defaultParams, baseBranch: "" })).toThrow(
      "baseBranch is required",
    );
  });

  it("should be within the token limit (approx 8192 tokens / 32000 bytes)", () => {
    const prompt = buildParentPrompt(defaultParams);
    expect(prompt.length < 32000).toBe(true);
  });

  it("should not include any repository-specific section when no override is provided", () => {
    const prompt = buildParentPrompt(defaultParams);
    expect(prompt).not.toContain("Repository-specific instructions");
  });

  it("should append repo-specific instructions verbatim when an override is provided", () => {
    const repoPrompt = "Always run `bun run lint` after sub-task implementation.";
    const prompt = buildParentPrompt({ ...defaultParams, repoPrompt });

    expect(prompt).toContain(
      `## Repository-specific instructions for ${defaultParams.repoOwner}/${defaultParams.repoName}`,
    );
    expect(prompt).toContain(repoPrompt);
    expect(prompt).toContain("These instructions take precedence over generic guidance");
  });

  it("appends repository context after DB-backed repo-specific instructions", () => {
    const repoPrompt = "Always run `bun run lint` after sub-task implementation.";
    const repoContext = "## Repository-level context\n\n### CLAUDE.md\n\nUse Bun.";
    const prompt = buildParentPrompt({ ...defaultParams, repoContext, repoPrompt });

    expect(prompt).toContain(repoPrompt);
    expect(prompt).toContain(repoContext);
    expect(prompt.indexOf(repoPrompt) < prompt.indexOf(repoContext)).toBe(true);
  });

  it("renders multi-repo prompt overrides before repository context and skips blank entries", () => {
    const primaryPrompt = "Primary repo rule.";
    const targetPrompt = "Target repo rule.";
    const repoContext = "## Context for owner/name\n\nUse Bun.";
    const prompt = buildParentPrompt({
      ...defaultParams,
      repoContext,
      repoPrompts: [
        {
          repoName: "name",
          repoOwner: "owner",
          repoPrompt: primaryPrompt,
        },
        {
          repoName: "api",
          repoOwner: "owner",
          repoPrompt: targetPrompt,
        },
        {
          repoName: "empty",
          repoOwner: "owner",
          repoPrompt: "   ",
        },
        {
          repoName: "null-body",
          repoOwner: "owner",
          repoPrompt: null,
        },
      ],
    });

    expect(prompt).toContain("## Repository-specific instructions for owner/name");
    expect(prompt).toContain(primaryPrompt);
    expect(prompt).toContain("## Repository-specific instructions for owner/api");
    expect(prompt).toContain(targetPrompt);
    expect(prompt).not.toContain("owner/empty");
    expect(prompt).not.toContain("owner/null-body");
    expect(prompt.indexOf(primaryPrompt) < prompt.indexOf(repoContext)).toBe(true);
    expect(prompt.indexOf(targetPrompt) < prompt.indexOf(repoContext)).toBe(true);
  });

  it("treats blank or whitespace-only override as absent", () => {
    expect(buildParentPrompt({ ...defaultParams, repoPrompt: "" })).toBe(
      buildParentPrompt(defaultParams),
    );
    expect(buildParentPrompt({ ...defaultParams, repoPrompt: "   \n\t" })).toBe(
      buildParentPrompt(defaultParams),
    );
    expect(buildParentPrompt({ ...defaultParams, repoPrompt: null })).toBe(
      buildParentPrompt(defaultParams),
    );
  });
});
