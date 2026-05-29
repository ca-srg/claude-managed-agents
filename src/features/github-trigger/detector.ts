import type { GithubTriggerCandidate } from "@/features/github-trigger/schemas";

/**
 * Minimal shape of an issue comment payload returned by Octokit.
 *
 * GitHub's `/repos/{owner}/{repo}/issues/comments` endpoint returns comments
 * for both Issues and Pull Requests. We discriminate using `html_url` so the
 * detector can run as a pure function over plain JSON without extra API calls.
 */
export type IssueCommentLike = {
  body?: string | null;
  html_url?: string | null;
  id: number | string;
  issue_url?: string | null;
};

/**
 * Minimal shape of a repository issue event payload returned by Octokit.
 *
 * `event === "labeled"` events carry the freshly applied label and an `issue`
 * object. PRs are surfaced through the same endpoint but include
 * `issue.pull_request`, which we use to filter them out.
 */
export type IssueEventLike = {
  created_at?: string | null;
  event?: string | null;
  id: number | string;
  issue?: {
    number?: number | null;
    pull_request?: unknown;
  } | null;
  label?: { name?: string | null } | null;
};

const REPO_FROM_URL_PATTERN = /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)(?:$|[/?#])/;
const PR_HTML_URL_PATTERN = /\/pull\//;

function extractRepoAndIssueFromIssueUrl(
  url: string | null | undefined,
): { issueNumber: number; repo: string } | null {
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }

  const match = REPO_FROM_URL_PATTERN.exec(url);
  if (match === null) {
    return null;
  }

  const repo = match[1];
  const issueNumberRaw = match[2];
  if (repo === undefined || issueNumberRaw === undefined) {
    return null;
  }

  const issueNumber = Number.parseInt(issueNumberRaw, 10);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return null;
  }

  return { issueNumber, repo };
}

function isPullRequestComment(comment: IssueCommentLike): boolean {
  if (typeof comment.html_url === "string" && PR_HTML_URL_PATTERN.test(comment.html_url)) {
    return true;
  }

  return false;
}

function firstNonBlankLine(body: string): string | null {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length > 0) {
      return line;
    }
  }

  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildBotRunPattern(botMention: string): RegExp {
  return new RegExp(`^@${escapeRegExp(botMention)}\\s+run\\b`, "i");
}

/**
 * Detects whether an issue comment should trigger a run.
 *
 * Trigger condition: the first non-blank line of the comment body must match
 * `^@<botMention>\s+run\b` (case-insensitive). Comments on Pull Requests are
 * ignored so the trigger only applies to Issues.
 */
export function detectCommentTrigger(
  comment: IssueCommentLike,
  config: { botMention: string },
): GithubTriggerCandidate | null {
  if (isPullRequestComment(comment)) {
    return null;
  }

  if (typeof comment.body !== "string") {
    return null;
  }

  const location = extractRepoAndIssueFromIssueUrl(comment.issue_url);
  if (location === null) {
    return null;
  }

  const firstLine = firstNonBlankLine(comment.body);
  if (firstLine === null) {
    return null;
  }

  if (!buildBotRunPattern(config.botMention).test(firstLine)) {
    return null;
  }

  return {
    issueNumber: location.issueNumber,
    reason: `comment mentions @${config.botMention} run`,
    repo: location.repo,
    source: "comment",
    sourceId: String(comment.id),
  };
}

/**
 * Detects whether a repository issue event represents the label trigger.
 *
 * Trigger condition: `event === "labeled"`, `label.name === triggerLabel`,
 * and the underlying issue is not a Pull Request. The repo slug is supplied
 * by the caller because the event payload itself does not carry it.
 */
export function detectLabelTrigger(
  event: IssueEventLike,
  config: { triggerLabel: string },
  repo: string,
): GithubTriggerCandidate | null {
  if (event.event !== "labeled") {
    return null;
  }

  const labelName = event.label?.name;
  if (typeof labelName !== "string" || labelName !== config.triggerLabel) {
    return null;
  }

  const issue = event.issue;
  if (issue == null) {
    return null;
  }

  if (issue.pull_request !== undefined && issue.pull_request !== null) {
    return null;
  }

  const issueNumber = issue.number;
  if (typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    return null;
  }

  return {
    issueNumber,
    reason: `label "${config.triggerLabel}" added`,
    repo,
    source: "label",
    sourceId: String(event.id),
  };
}
