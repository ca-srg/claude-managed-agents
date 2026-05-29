import { createHash } from "node:crypto";

import type { z } from "zod";

import {
  createSubIssue,
  type GitHubIssue,
  type GitHubIssueClient,
  SubIssueCapExceeded,
} from "@/features/decomposition/github-write";
import { CreateSubIssueInput, type CreateSubIssueOutput } from "@/features/decomposition/schemas";
import type { Config } from "@/shared/config";
import { writeRunState as defaultWriteRunState } from "@/shared/state";
import type { DecomposedTask, RunState } from "@/shared/types";

type CreateSubIssueInputValue = z.infer<typeof CreateSubIssueInput>;
type CreateSubIssueSuccessOutput = z.infer<typeof CreateSubIssueOutput>;

type ToolFailure = {
  error: {
    details?: unknown;
    message: string;
    type: string;
  };
  reused: false;
  subIssueId: 0;
  subIssueNumber: 0;
  success: false;
};

type WriteRunState = (runId: string, state: RunState) => Promise<void>;

export type CreateSubIssueContext = {
  cfg: Config;
  existingSubIssues: GitHubIssue[];
  octokit: GitHubIssueClient;
  owner: string;
  parentIssueId: number;
  parentIssueNumber: number;
  repo: string;
  runState: RunState;
  writeRunState?: WriteRunState;
};

export type HandleCreateSubIssueOutput = CreateSubIssueSuccessOutput | ToolFailure;

function stableTaskId(title: string): string {
  return createHash("sha1").update(title).digest("hex");
}

function buildTask(input: CreateSubIssueInputValue): DecomposedTask {
  return {
    acceptanceCriteria: [],
    description: input.body ?? "",
    id: stableTaskId(input.title),
    title: input.title,
  };
}

function schemaErrorMessage(argsError: z.ZodError<CreateSubIssueInputValue>): string {
  const issueMessages = argsError.issues.map((issue) => {
    const issuePath = issue.path.length > 0 ? issue.path.join(".") : "input";
    return `${issuePath}: ${issue.message}`;
  });

  return issueMessages.length > 0
    ? `Invalid create_sub_issue input: ${issueMessages.join("; ")}`
    : "Invalid create_sub_issue input";
}

function failureOutput(message: string, type: string, details?: unknown): ToolFailure {
  const error = typeof details === "undefined" ? { message, type } : { details, message, type };

  return {
    error,
    reused: false,
    subIssueId: 0,
    subIssueNumber: 0,
    success: false,
  };
}

function upsertSubIssue(
  currentSubIssues: RunState["subIssues"],
  nextSubIssue: RunState["subIssues"][number],
): RunState["subIssues"] {
  const existingIndex = currentSubIssues.findIndex(
    (storedSubIssue) => storedSubIssue.taskId === nextSubIssue.taskId,
  );

  if (existingIndex === -1) {
    return [...currentSubIssues, nextSubIssue];
  }

  return currentSubIssues.map((storedSubIssue, subIssueIndex) =>
    subIssueIndex === existingIndex ? nextSubIssue : storedSubIssue,
  );
}

function unexpectedErrorDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
    };
  }

  return {
    cause: error,
  };
}

export async function handleCreateSubIssue(
  ctx: CreateSubIssueContext,
  args: unknown,
): Promise<HandleCreateSubIssueOutput> {
  const parsedInput = CreateSubIssueInput.safeParse(args);
  if (!parsedInput.success) {
    return failureOutput(
      schemaErrorMessage(parsedInput.error),
      "schema",
      parsedInput.error.flatten(),
    );
  }

  const subIssueTask = buildTask(parsedInput.data);

  try {
    const creation = await createSubIssue(ctx.octokit, {
      assignees: parsedInput.data.assignees ?? [],
      existingSubIssues: ctx.existingSubIssues,
      labels: parsedInput.data.labels ?? [],
      maxCap: ctx.cfg.maxSubIssues,
      owner: ctx.owner,
      parentId: ctx.parentIssueId,
      parentN: ctx.parentIssueNumber,
      repo: ctx.repo,
      task: subIssueTask,
    });

    const nextRunState: RunState = {
      ...ctx.runState,
      subIssues: upsertSubIssue(ctx.runState.subIssues, {
        issueId: creation.issue.id,
        issueNumber: creation.issue.number,
        taskId: subIssueTask.id,
      }),
    };
    const persistRunState = ctx.writeRunState ?? defaultWriteRunState;

    await persistRunState(ctx.runState.runId, nextRunState);
    ctx.runState.subIssues = nextRunState.subIssues;

    return {
      reused: creation.reused,
      subIssueId: creation.issue.id,
      subIssueNumber: creation.issue.number,
      success: true,
    };
  } catch (error) {
    if (error instanceof SubIssueCapExceeded) {
      return failureOutput(error.message, "sub_issue_cap_exceeded", {
        currentCount: error.currentCount,
        maxCap: error.maxCap,
        parentIssueNumber: error.parentIssueNumber,
      });
    }

    return failureOutput(
      error instanceof Error ? error.message : "Unexpected create_sub_issue failure",
      "unexpected",
      unexpectedErrorDetails(error),
    );
  }
}
