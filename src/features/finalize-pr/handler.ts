import type { z } from "zod";
import type { Config } from "@/shared/config";
import { originDisplay, originUrl, type RunOrigin } from "@/shared/run-origin";
import type { RunState } from "@/shared/types";
import {
  buildPRBody,
  createOrUpdatePR,
  type GitHubRequestClient,
  resolveDefaultBranch,
  type SubIssueSummary,
} from "./github-operations";

import { CreateFinalPrInput, CreateFinalPrOutput } from "./schemas";

type CreateFinalPrSuccess = z.infer<typeof CreateFinalPrOutput>;

type CreateFinalPrFailure = {
  error: {
    details?: unknown;
    message: string;
    type: string;
  };
  prNumber: number;
  prUrl: string;
  success: false;
  updated: boolean;
};

export type CreateFinalPrContext = {
  octokit: GitHubRequestClient;
  cfg: Config;
  owner: string;
  repo: string;
  runState: RunState;
  origin?: RunOrigin;
  parentIssueNumber?: number;
  baseBranch?: string;
  signal?: AbortSignal;
};

export type CreateFinalPrResult = CreateFinalPrSuccess | CreateFinalPrFailure;

export const createFinalPrDeps = {
  buildPRBody,
  createOrUpdatePR,
  resolveDefaultBranch,
};

const CLAUDE_MANAGED_AGENTS_SESSION_URL_PREFIX =
  "https://platform.claude.com/workspaces/default/sessions/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildFailure(type: string, message: string, details?: unknown): CreateFinalPrFailure {
  return {
    error: typeof details === "undefined" ? { message, type } : { details, message, type },
    prNumber: 0,
    prUrl: "",
    success: false,
    updated: false,
  };
}

function errorMessageFromUnknown(thrownValue: unknown): string {
  if (thrownValue instanceof Error && thrownValue.message.length > 0) {
    return thrownValue.message;
  }

  if (isRecord(thrownValue) && typeof thrownValue.message === "string") {
    return thrownValue.message;
  }

  return "Failed to create or update the final pull request";
}

function buildSubIssuesSummary(
  owner: string,
  repo: string,
  runState: RunState,
): readonly SubIssueSummary[] {
  return runState.subIssues.map((subIssue) => ({
    title: `Sub-issue #${subIssue.issueNumber}`,
    url: `https://github.com/${owner}/${repo}/issues/${subIssue.issueNumber}`,
  }));
}

function contextParentIssueNumber(ctx: CreateFinalPrContext): number | null {
  const origin = ctx.origin ?? ctx.runState.origin;
  if (origin?.type === "github_issue") {
    return origin.issueNumber;
  }

  return ctx.parentIssueNumber ?? null;
}

function buildOriginSection(ctx: CreateFinalPrContext): string {
  const origin = ctx.origin ?? ctx.runState.origin;
  if (origin?.type !== "linear_issue") {
    return "";
  }

  const display = originDisplay(origin);
  const url = originUrl(origin);
  const originLine = url ? `- [${display}](${url})` : `- ${display}`;

  return ["## Origin", originLine].join("\n");
}

function firstSessionId(runState: RunState): string | null {
  for (const sessionId of runState.sessionIds) {
    const trimmedSessionId = sessionId.trim();
    if (trimmedSessionId.length > 0) {
      return trimmedSessionId;
    }
  }

  return null;
}

function buildClaudeManagedAgentsSessionSection(runState: RunState): string {
  const sessionId = firstSessionId(runState);
  if (sessionId === null) {
    return "";
  }

  const sessionUrl = `${CLAUDE_MANAGED_AGENTS_SESSION_URL_PREFIX}${encodeURIComponent(sessionId)}`;
  return ["## Claude Managed Agents session", sessionUrl].join("\n");
}

function normalizeConfiguredBase(baseBranch?: string): string | undefined {
  if (typeof baseBranch !== "string") {
    return undefined;
  }

  const trimmedBaseBranch = baseBranch.trim();
  return trimmedBaseBranch.length > 0 ? trimmedBaseBranch : undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("create_final_pr aborted");
  }
}

async function normalizeArgs(ctx: CreateFinalPrContext, args: unknown): Promise<unknown> {
  throwIfAborted(ctx.signal);
  if (!isRecord(args) || typeof args.base !== "string") {
    return args;
  }

  const trimmedBase = args.base.trim();
  if (trimmedBase.length > 0) {
    return {
      ...args,
      base: trimmedBase,
    };
  }

  return {
    ...args,
    base:
      normalizeConfiguredBase(ctx.baseBranch) ??
      (await createFinalPrDeps.resolveDefaultBranch(ctx.octokit, ctx.owner, ctx.repo, ctx.signal)),
  };
}

export async function handleCreateFinalPr(
  ctx: CreateFinalPrContext,
  args: unknown,
): Promise<CreateFinalPrResult> {
  let normalizedArgs: unknown;

  try {
    normalizedArgs = await normalizeArgs(ctx, args);
  } catch (thrownValue) {
    return buildFailure(
      "create_final_pr_failed",
      errorMessageFromUnknown(thrownValue),
      thrownValue,
    );
  }

  const parsedInput = CreateFinalPrInput.safeParse(normalizedArgs);
  if (!parsedInput.success) {
    return buildFailure(
      "validation_error",
      "Invalid create_final_pr input",
      parsedInput.error.flatten(),
    );
  }

  const parentIssueNumber = contextParentIssueNumber(ctx);
  if (
    parsedInput.data.parentIssueNumber !== undefined &&
    parentIssueNumber !== null &&
    parsedInput.data.parentIssueNumber !== parentIssueNumber
  ) {
    return buildFailure("validation_error", "Invalid create_final_pr input", {
      parentIssueNumber: ["parentIssueNumber does not match the run origin"],
    });
  }

  if (parsedInput.data.parentIssueNumber !== undefined && parentIssueNumber === null) {
    return buildFailure("validation_error", "Invalid create_final_pr input", {
      parentIssueNumber: ["parentIssueNumber is not supported for Linear-origin runs"],
    });
  }

  const subIssuesSummary = buildSubIssuesSummary(ctx.owner, ctx.repo, ctx.runState);
  const requestBody = createFinalPrDeps.buildPRBody(
    parsedInput.data.body,
    parentIssueNumber,
    subIssuesSummary,
    buildOriginSection(ctx),
    buildClaudeManagedAgentsSessionSection(ctx.runState),
  );

  try {
    throwIfAborted(ctx.signal);
    const prResult = await createFinalPrDeps.createOrUpdatePR(ctx.octokit, {
      base: parsedInput.data.base,
      body: requestBody,
      draft: ctx.cfg.pr.draft,
      head: parsedInput.data.head,
      owner: ctx.owner,
      repo: ctx.repo,
      signal: ctx.signal,
      title: parsedInput.data.title,
    });

    const output = CreateFinalPrOutput.safeParse({
      prNumber: prResult.prNumber,
      prUrl: prResult.prUrl,
      success: true,
      updated: prResult.updated,
    });
    if (!output.success) {
      return buildFailure(
        "output_validation_error",
        "Invalid create_final_pr output",
        output.error.flatten(),
      );
    }

    return output.data;
  } catch (thrownValue) {
    return buildFailure(
      "create_final_pr_failed",
      errorMessageFromUnknown(thrownValue),
      thrownValue,
    );
  }
}
