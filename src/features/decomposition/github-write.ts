import { createHash } from "node:crypto";

import type { Logger } from "pino";

import type { GitHubIssue, GitHubIssueClient } from "@/shared/github/types";
import type { DecomposedTask } from "@/shared/types";

export type { GitHubIssue, GitHubIssueClient } from "@/shared/github/types";

export type CreateSubIssueOptions = {
  assignees: string[];
  existingSubIssues: GitHubIssue[];
  labels: string[];
  logger?: Pick<Logger, "warn">;
  maxCap: number;
  owner: string;
  parentId: number;
  parentN: number;
  repo: string;
  task: DecomposedTask;
};

export class SubIssueCapExceeded extends Error {
  readonly currentCount: number;
  readonly maxCap: number;
  readonly parentIssueNumber: number;

  constructor(parentIssueNumber: number, maxCap: number, currentCount: number) {
    super(
      `Parent issue #${parentIssueNumber} already has ${currentCount} sub-issues; max is ${maxCap}`,
    );
    this.currentCount = currentCount;
    this.maxCap = maxCap;
    this.name = "SubIssueCapExceeded";
    this.parentIssueNumber = parentIssueNumber;
  }
}

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

function buildTitleHashToken(titleHash: string): string {
  return `[sub-issue:${titleHash}]`;
}

function buildSubIssueTitle(parentIssueNumber: number, task: DecomposedTask): string {
  return `${task.title} ${buildTitleHashToken(titleHashFor(parentIssueNumber, task))}`;
}

function buildAcceptanceCriteriaSection(task: DecomposedTask): string[] {
  if (task.acceptanceCriteria.length === 0) {
    return [];
  }

  return [
    "## Acceptance Criteria",
    ...task.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
  ];
}

function buildSubIssueBody(
  parentIssueNumber: number,
  parentIssueId: number,
  task: DecomposedTask,
): string {
  const titleHash = titleHashFor(parentIssueNumber, task);
  const bodySections = [
    `<!-- parent-issue-number:${parentIssueNumber} -->`,
    `<!-- parent-issue-id:${parentIssueId} -->`,
    `<!-- task-id:${task.id} -->`,
    `<!-- title-hash:${titleHash} -->`,
    task.description,
    ...buildAcceptanceCriteriaSection(task),
  ].filter((bodySection) => bodySection.length > 0);

  return `${bodySections.join("\n\n")}\n`;
}

function findExistingSubIssue(
  parentIssueNumber: number,
  task: DecomposedTask,
  existingSubIssues: GitHubIssue[],
): GitHubIssue | null {
  const titleHashToken = buildTitleHashToken(titleHashFor(parentIssueNumber, task));

  return (
    existingSubIssues.find((existingSubIssue) => existingSubIssue.title.includes(titleHashToken)) ??
    null
  );
}

export function titleHashFor(parentIssueNumber: number, task: DecomposedTask): string {
  return createHash("sha1").update(`${parentIssueNumber}:${task.id}:${task.title}`).digest("hex");
}

export async function closeOrphanIssue(
  octokit: GitHubIssueClient,
  owner: string,
  repo: string,
  issueNumber: number,
  logger?: Pick<Logger, "warn">,
): Promise<void> {
  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
      issue_number: issueNumber,
      owner,
      repo,
      state: "closed",
      state_reason: "not_planned",
    });
  } catch (error) {
    logger?.warn(
      {
        error,
        issueNumber,
        owner,
        repo,
      },
      "Failed to close orphan GitHub issue",
    );
    throw error;
  }
}

export async function unlinkSubIssue(
  octokit: GitHubIssueClient,
  owner: string,
  repo: string,
  parentIssueNumber: number,
  subIssueId: number,
): Promise<void> {
  await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/sub_issue", {
    issue_number: parentIssueNumber,
    owner,
    repo,
    sub_issue_id: subIssueId,
  });
}

export async function createSubIssue(
  octokit: GitHubIssueClient,
  options: CreateSubIssueOptions,
): Promise<{ issue: GitHubIssue; reused: boolean }> {
  const existingSubIssue = findExistingSubIssue(
    options.parentN,
    options.task,
    options.existingSubIssues,
  );
  if (existingSubIssue) {
    return { issue: existingSubIssue, reused: true };
  }

  if (options.existingSubIssues.length >= options.maxCap) {
    throw new SubIssueCapExceeded(
      options.parentN,
      options.maxCap,
      options.existingSubIssues.length,
    );
  }

  const createIssueResponse = await octokit.request("POST /repos/{owner}/{repo}/issues", {
    assignees: options.assignees,
    body: buildSubIssueBody(options.parentN, options.parentId, options.task),
    labels: options.labels,
    owner: options.owner,
    repo: options.repo,
    title: buildSubIssueTitle(options.parentN, options.task),
  });
  const createdIssue = assertGitHubIssue(
    createIssueResponse.data,
    `created sub-issue for #${options.parentN}`,
  );

  try {
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", {
      issue_number: options.parentN,
      owner: options.owner,
      repo: options.repo,
      sub_issue_id: createdIssue.id,
    });
  } catch (error) {
    options.logger?.warn(
      {
        createdIssueId: createdIssue.id,
        createdIssueNumber: createdIssue.number,
        error,
        parentIssueNumber: options.parentN,
      },
      "Failed to link sub-issue; closing orphan issue",
    );
    await closeOrphanIssue(
      octokit,
      options.owner,
      options.repo,
      createdIssue.number,
      options.logger,
    );
    throw error;
  }

  return {
    issue: createdIssue,
    reused: false,
  };
}
