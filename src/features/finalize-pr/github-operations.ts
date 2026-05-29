import type { GitHubRequestClient } from "@/shared/github/types";

export type { GitHubRequestClient } from "@/shared/github/types";

const BODY_SIZE_CAP_BYTES = 60 * 1024;
const TRUNCATION_MARKER = "...[truncated; see sub-issues for details]";
const GITHUB_CLOSING_KEYWORDS_PATTERN =
  "close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved";
const GITHUB_REPOSITORY_REFERENCE_PATTERN = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";

export type PR = {
  body: string | null;
  draft?: boolean;
  html_url: string;
  number: number;
  title: string;
};

export type SubIssueSummary = {
  title: string;
  url: string;
};

export type CreateOrUpdatePROptions = {
  base?: string;
  body: string;
  draft?: boolean;
  head: string;
  owner: string;
  repo: string;
  signal?: AbortSignal;
  title: string;
};

export type CreateOrUpdatePRResult = {
  prNumber: number;
  prUrl: string;
  updated: boolean;
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizeHeadFilter(owner: string, head: string): string {
  return head.includes(":") ? head : `${owner}:${head}`;
}

function buildSubIssuesSection(subIssuesSummary: readonly SubIssueSummary[]): string {
  if (subIssuesSummary.length === 0) {
    return "";
  }

  const summaryLines = subIssuesSummary.map((subIssue) => `- [${subIssue.title}](${subIssue.url})`);
  return ["## Sub-issues", ...summaryLines].join("\n");
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildGitHubClosingReferencePattern(issueNumberPattern: string): string {
  const issueNumberWithBoundary = `${issueNumberPattern}(?!\\d)`;
  const shorthandReference = [
    `(?:${GITHUB_REPOSITORY_REFERENCE_PATTERN}\\s*)?`,
    `#\\s*${issueNumberWithBoundary}`,
  ].join("");
  const urlReference = [
    "https://github\\.com/",
    GITHUB_REPOSITORY_REFERENCE_PATTERN,
    `/issues/${issueNumberWithBoundary}`,
    "(?:[/?#][^\\s)]*)?",
  ].join("");

  return [
    `\\b(?:${GITHUB_CLOSING_KEYWORDS_PATTERN})\\b\\s*:?\\s*`,
    `(?:${shorthandReference}|${urlReference})`,
  ].join("");
}

function removeExistingClosingReferences(
  userBody: string,
  parentIssueNumber: number | null,
): string {
  const issueNumberPattern =
    parentIssueNumber === null ? "\\d+" : escapeForRegExp(String(parentIssueNumber));
  const closingReferencePattern = buildGitHubClosingReferencePattern(issueNumberPattern);
  const closingLinePattern = new RegExp(
    `(^|\\n)\\s*(?:[-*+]\\s*)?${closingReferencePattern}\\s*[.,;:]?\\s*(?=\\n|$)`,
    "gi",
  );
  const closingReferenceRegExp = new RegExp(closingReferencePattern, "gi");

  return userBody.replace(closingLinePattern, "$1").replace(closingReferenceRegExp, "").trim();
}

function joinBodySections(sections: readonly string[]): string {
  const populatedSections = sections.filter((section) => section.trim().length > 0);
  return `${populatedSections.join("\n\n")}\n`;
}

function truncateToByteLength(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  let currentBytes = 0;
  let truncatedValue = "";

  for (const character of value) {
    const characterBytes = byteLength(character);
    if (currentBytes + characterBytes > maxBytes) {
      break;
    }

    truncatedValue += character;
    currentBytes += characterBytes;
  }

  return truncatedValue;
}

function removeLastCharacter(value: string): string {
  return Array.from(value).slice(0, -1).join("");
}

function formatPRResponse(pr: PR, updated: boolean): CreateOrUpdatePRResult {
  return {
    prNumber: pr.number,
    prUrl: pr.html_url,
    updated,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("create_final_pr aborted");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function extractErrorMessage(thrownValue: unknown): string | null {
  if (!isRecord(thrownValue)) {
    return null;
  }

  const responseValue = thrownValue.response;
  if (isRecord(responseValue)) {
    const responsePayload = responseValue.data;
    if (isRecord(responsePayload)) {
      const apiMessage = responsePayload.message;
      if (typeof apiMessage === "string") {
        return apiMessage;
      }
    }
  }

  const directMessage = thrownValue.message;
  return typeof directMessage === "string" ? directMessage : null;
}

function isPullRequestAlreadyExistsError(thrownValue: unknown): boolean {
  if (!isRecord(thrownValue)) {
    return false;
  }

  const statusValue = thrownValue.status;
  if (statusValue !== 422) {
    return false;
  }

  const message = extractErrorMessage(thrownValue)?.toLowerCase();
  return message?.includes("pull request already exists") ?? false;
}

export async function resolveDefaultBranch(
  octokit: GitHubRequestClient,
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const response = await octokit.request<{ default_branch?: string }>("GET /repos/{owner}/{repo}", {
    owner,
    ...(signal ? { request: { signal } } : {}),
    repo,
  });
  throwIfAborted(signal);
  const defaultBranch = response.data.default_branch;

  if (!defaultBranch) {
    throw new Error(`Repository ${owner}/${repo} is missing a default branch`);
  }

  return defaultBranch;
}

export async function findPRByHead(
  octokit: GitHubRequestClient,
  owner: string,
  repo: string,
  head: string,
  signal?: AbortSignal,
): Promise<PR | null> {
  throwIfAborted(signal);
  const response = await octokit.request<PR[]>("GET /repos/{owner}/{repo}/pulls", {
    head: normalizeHeadFilter(owner, head),
    owner,
    per_page: 1,
    ...(signal ? { request: { signal } } : {}),
    repo,
    state: "open",
  });
  throwIfAborted(signal);

  return response.data[0] ?? null;
}

export function buildPRBody(
  userBody: string,
  parentIssueNumber: number | null,
  subIssuesSummary: readonly SubIssueSummary[],
  originSection = "",
): string {
  const closingLine = parentIssueNumber === null ? "" : `Closes #${parentIssueNumber}`;
  const normalizedUserBody = removeExistingClosingReferences(userBody, parentIssueNumber);
  const subIssuesSection = buildSubIssuesSection(subIssuesSummary);
  const tailSections = [subIssuesSection, originSection, closingLine];
  const completeBody = joinBodySections([normalizedUserBody, ...tailSections]);

  if (byteLength(completeBody) <= BODY_SIZE_CAP_BYTES) {
    return completeBody;
  }

  const preservedTail = joinBodySections(tailSections);
  const preservedTailWithMarker = joinBodySections([TRUNCATION_MARKER, ...tailSections]);
  const availableUserBodyBytes = BODY_SIZE_CAP_BYTES - byteLength(preservedTailWithMarker);

  if (availableUserBodyBytes > 0) {
    let truncatedUserBody = truncateToByteLength(
      normalizedUserBody,
      availableUserBodyBytes,
    ).trimEnd();
    let truncatedBody = joinBodySections([truncatedUserBody, TRUNCATION_MARKER, ...tailSections]);

    while (byteLength(truncatedBody) > BODY_SIZE_CAP_BYTES && truncatedUserBody.length > 0) {
      truncatedUserBody = removeLastCharacter(truncatedUserBody).trimEnd();
      truncatedBody = joinBodySections([truncatedUserBody, TRUNCATION_MARKER, ...tailSections]);
    }

    return truncatedBody;
  }

  const minimalTail = joinBodySections([TRUNCATION_MARKER, originSection, closingLine]);
  const availableSummaryBytes = BODY_SIZE_CAP_BYTES - byteLength(minimalTail);

  if (availableSummaryBytes <= 0 || preservedTail.length === 0) {
    return minimalTail;
  }

  let truncatedSummary = truncateToByteLength(subIssuesSection, availableSummaryBytes).trimEnd();
  let truncatedBody = joinBodySections([
    TRUNCATION_MARKER,
    truncatedSummary,
    originSection,
    closingLine,
  ]);

  while (byteLength(truncatedBody) > BODY_SIZE_CAP_BYTES && truncatedSummary.length > 0) {
    truncatedSummary = removeLastCharacter(truncatedSummary).trimEnd();
    truncatedBody = joinBodySections([
      TRUNCATION_MARKER,
      truncatedSummary,
      originSection,
      closingLine,
    ]);
  }

  return truncatedBody;
}

export async function createOrUpdatePR(
  octokit: GitHubRequestClient,
  options: CreateOrUpdatePROptions,
): Promise<CreateOrUpdatePRResult> {
  const existingPR = await findPRByHead(
    octokit,
    options.owner,
    options.repo,
    options.head,
    options.signal,
  );
  const prBody = options.body;

  if (existingPR) {
    throwIfAborted(options.signal);
    const updateResponse = await octokit.request<PR>(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        ...(options.base ? { base: options.base } : {}),
        body: prBody,
        owner: options.owner,
        pull_number: existingPR.number,
        ...(options.signal ? { request: { signal: options.signal } } : {}),
        repo: options.repo,
        title: options.title,
      },
    );

    return formatPRResponse(updateResponse.data, true);
  }

  const baseBranch =
    options.base ??
    (await resolveDefaultBranch(octokit, options.owner, options.repo, options.signal));

  try {
    throwIfAborted(options.signal);
    const createResponse = await octokit.request<PR>("POST /repos/{owner}/{repo}/pulls", {
      base: baseBranch,
      body: prBody,
      draft: options.draft ?? false,
      head: options.head,
      owner: options.owner,
      ...(options.signal ? { request: { signal: options.signal } } : {}),
      repo: options.repo,
      title: options.title,
    });

    return formatPRResponse(createResponse.data, false);
  } catch (thrownValue) {
    if (isPullRequestAlreadyExistsError(thrownValue)) {
      throw new Error(`Pull request already exists for head branch ${options.head}`, {
        cause: thrownValue,
      });
    }

    throw thrownValue;
  }
}
