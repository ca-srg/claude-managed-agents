import type { GitHubIssue, GitHubIssueClient } from "@/shared/github/types";

export type { GitHubIssue, GitHubIssueClient } from "@/shared/github/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGitHubIssue(value: unknown): value is GitHubIssue {
  if (!isRecord(value)) {
    return false;
  }

  const issueBody = value.body;
  const pullRequestValue = value.pull_request;

  return (
    typeof value.id === "number" &&
    typeof value.number === "number" &&
    typeof value.state === "string" &&
    typeof value.title === "string" &&
    (typeof issueBody === "undefined" || typeof issueBody === "string" || issueBody === null) &&
    (typeof pullRequestValue === "undefined" || isRecord(pullRequestValue))
  );
}

function assertGitHubIssue(value: unknown, context: string): GitHubIssue {
  if (!isGitHubIssue(value)) {
    throw new Error(`Invalid GitHub issue payload for ${context}`);
  }

  return value;
}

function assertGitHubIssueArray(value: unknown, context: string): GitHubIssue[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid GitHub issue array payload for ${context}`);
  }

  return value.map((entry, index) => assertGitHubIssue(entry, `${context}[${index}]`));
}

function hasPullRequestKey(issue: GitHubIssue): boolean {
  return Object.hasOwn(issue, "pull_request");
}

export async function listSubIssues(
  octokit: GitHubIssueClient,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubIssue[]> {
  const subIssuePage = await octokit.paginate(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues",
    {
      issue_number: issueNumber,
      owner,
      per_page: 100,
      repo,
    },
  );

  return assertGitHubIssueArray(subIssuePage, `sub-issues for #${issueNumber}`);
}

export async function readIssue(
  octokit: GitHubIssueClient,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ issue: GitHubIssue; subIssues: GitHubIssue[] }> {
  const issueResponse = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
    issue_number: issueNumber,
    owner,
    repo,
  });
  const issue = assertGitHubIssue(issueResponse.data, `issue #${issueNumber}`);

  if (hasPullRequestKey(issue)) {
    throw new Error(`Issue #${issueNumber} is a pull request`);
  }

  if (issue.state !== "open") {
    throw new Error(`Issue #${issueNumber} is closed`);
  }

  return {
    issue,
    subIssues: await listSubIssues(octokit, owner, repo, issueNumber),
  };
}
