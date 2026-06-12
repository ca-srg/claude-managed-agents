import { describe, expect, it } from "bun:test";
import { buildChildPrompt } from "../child";

describe("buildChildPrompt", () => {
  const mockGit = {
    authorName: "claude-agent[bot]",
    authorEmail: "claude-agent@users.noreply.github.com",
  };

  const defaultArgs = {
    repoOwner: "owner",
    repoName: "repo",
    branch: "feature/x",
    baseBranch: "main",
    git: mockGit,
    commitStyle: "conventional" as const,
  };

  it("should contain the branch-first checkout protocol verbatim", () => {
    const prompt = buildChildPrompt(defaultArgs);

    expect(prompt).toContain('git config user.name "claude-agent[bot]"');
    expect(prompt).toContain('git config user.email "claude-agent@users.noreply.github.com"');
    expect(prompt).toContain("git fetch origin");
    expect(prompt).toContain(
      "git checkout -B feature/x origin/feature/x || git checkout -B feature/x origin/main",
    );
    expect(prompt).toContain("git pull --ff-only origin feature/x || true");
  });

  it("should contain the MUST NOT spawn/delegate guardrail", () => {
    const prompt = buildChildPrompt(defaultArgs);

    expect(prompt).toMatch(/MUST NOT spawn or delegate.*sub-agent/);
    expect(prompt).toContain("MUST NOT spawn or delegate to any other sub-agent");
  });

  it("should render commit style correctly (conventional)", () => {
    const prompt = buildChildPrompt({ ...defaultArgs, commitStyle: "conventional" });
    expect(prompt).toContain("Configured commit style = conventional");
    expect(prompt).toContain("Commit messages MUST still use English Conventional Commits");
  });

  it("should render commit style correctly (plain)", () => {
    const prompt = buildChildPrompt({ ...defaultArgs, commitStyle: "plain" });
    expect(prompt).toContain("Configured commit style = plain");
    expect(prompt).toContain("Commit messages MUST still use English Conventional Commits");
  });

  it("should include coordinator topology role guidance", () => {
    const prompt = buildChildPrompt(defaultArgs);

    expect(prompt).toContain("a task-implementer sub-agent");
    expect(prompt).toContain("Managed Agents' multi-agent coordinator topology");
    expect(prompt).toContain("For every task you receive from the parent thread");
  });

  it("should include GitHub App operations skill fallback guidance", () => {
    const prompt = buildChildPrompt(defaultArgs);

    expect(prompt).toContain("GitHub App GitHub Operations skill");
    expect(prompt).toContain(
      "Do not repair local signing, SSH, or credential-helper infrastructure",
    );
    expect(prompt).toContain("use the GitHub MCP/API file commit path");
  });

  it("should include return JSON format", () => {
    const prompt = buildChildPrompt(defaultArgs);
    expect(prompt).toContain("Reply to the parent thread with a JSON code block");
    expect(prompt).toContain("taskId");
    expect(prompt).toContain("success");
    expect(prompt).toContain("commitSha");
    expect(prompt).toContain("filesChanged");
    expect(prompt).toContain("testOutput");
  });

  it("should include the blocked JSON format and forbid silent exits", () => {
    const prompt = buildChildPrompt(defaultArgs);
    expect(prompt).toContain('"status": "blocked"');
    expect(prompt).toContain('"reason": "<one-sentence Japanese explanation of the blocker>"');
    expect(prompt).toContain("MUST NOT end a task thread silently or with prose only");
    expect(prompt).toContain(
      "every reply to the parent MUST end with exactly one of these JSON blocks (success, failure, or blocked)",
    );
  });

  it("should wait for host credential re-mint before declaring MCP auth failures permanent", () => {
    const prompt = buildChildPrompt(defaultArgs);
    expect(prompt).toContain("it re-mints the expired credential automatically");
    expect(prompt).toContain(
      "wait about 60 seconds (e.g. `sleep 60`) and retry the failing call, up to two spaced retries",
    );
    expect(prompt).toContain("treat the failure as permanent");
    expect(prompt).toContain(
      "MUST NOT search the sandbox for credentials, probe ports or proxies, or attempt alternative authentication paths",
    );
  });

  it("should require Japanese human-readable output", () => {
    const prompt = buildChildPrompt(defaultArgs);

    expect(prompt).toContain("Language policy:");
    expect(prompt).toContain("MUST write GitHub sub-issue bodies");
    expect(prompt).toContain(
      "MUST write PR titles, commit messages, and GitHub/Linear issue titles in English using Conventional Commits format",
    );
    expect(prompt).toContain(
      "Use English for terms that are commonly written in English in developer workflows",
    );
    expect(prompt).toContain("<short Japanese summary or last lines of bun test>");
    expect(prompt).toContain("<one-sentence Japanese explanation>");
  });

  it("should not include any repository-specific section when no override is provided", () => {
    const prompt = buildChildPrompt(defaultArgs);
    expect(prompt).not.toContain("Repository-specific instructions");
  });

  it("should append repo-specific instructions verbatim when an override is provided", () => {
    const repoPrompt = "Always update CHANGELOG.md when changing public API.";
    const prompt = buildChildPrompt({ ...defaultArgs, repoPrompt });

    expect(prompt).toContain(
      `## Repository-specific instructions for ${defaultArgs.repoOwner}/${defaultArgs.repoName}`,
    );
    expect(prompt).toContain(repoPrompt);
    expect(prompt).toContain("These instructions take precedence over generic guidance");
  });

  it("treats blank or whitespace-only override as absent", () => {
    expect(buildChildPrompt({ ...defaultArgs, repoPrompt: "" })).toBe(
      buildChildPrompt(defaultArgs),
    );
    expect(buildChildPrompt({ ...defaultArgs, repoPrompt: null })).toBe(
      buildChildPrompt(defaultArgs),
    );
  });
});
