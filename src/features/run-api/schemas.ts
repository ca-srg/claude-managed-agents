import { z } from "zod";

import {
  RunEventSchema,
  RunStatusSchema,
  RunSummarySchema,
  SubIssueSchema,
} from "@/shared/persistence/schemas";
import { RunOriginSchema } from "@/shared/run-origin";

const RepoSlugPattern = /^[\w.-]+\/[\w.-]+$/;

const RepoSlugSchema = z
  .string()
  .regex(RepoSlugPattern)
  .describe("GitHub repository slug in owner/name form.");

const NonEmptyStringSchema = z.string().min(1);
const TrimmedNonEmptyStringSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));
const PositiveIntegerSchema = z.number().int().positive();

const RunIdSchema = NonEmptyStringSchema.describe("Stable identifier for the managed run.");
const RunOriginTypeSchema = z.enum(["github_issue", "linear_issue"]);

const DescribedRunSummarySchema = RunSummarySchema.extend({
  branch: RunSummarySchema.shape.branch.describe("Git branch used by the managed run."),
  issueNumber: RunSummarySchema.shape.issueNumber.describe(
    "GitHub issue number for GitHub-origin runs, or null for non-GitHub origins.",
  ),
  origin: RunOriginSchema.optional().describe("Origin work item that started the run."),
  phase: RunSummarySchema.shape.phase.describe("Current orchestration phase for the run."),
  prUrl: RunSummarySchema.shape.prUrl.describe("Pull request URL produced by the run."),
  repo: RunSummarySchema.shape.repo.describe("GitHub repository slug for the run."),
  runId: RunSummarySchema.shape.runId.describe("Stable identifier for the managed run."),
  startedAt: RunSummarySchema.shape.startedAt.describe("ISO timestamp when the run started."),
  status: RunSummarySchema.shape.status.describe("Current lifecycle status for the run."),
})
  .strict()
  .describe("Summary of a managed run for run-api responses.");

const DescribedSubIssueSchema = SubIssueSchema.extend({
  issueId: SubIssueSchema.shape.issueId.describe("GitHub node/database id for the sub-issue."),
  issueNumber: SubIssueSchema.shape.issueNumber.describe("GitHub issue number for the sub-issue."),
  taskId: SubIssueSchema.shape.taskId.describe("Decomposed task id linked to the sub-issue."),
})
  .strict()
  .describe("Sub-issue linked to a managed run.");

const DescribedRunEventSchema = RunEventSchema.extend({
  id: RunEventSchema.shape.id.describe("Stable event id within the run event stream."),
  kind: RunEventSchema.shape.kind.describe("Machine-readable run event kind."),
  payload: RunEventSchema.shape.payload.describe("Structured payload for the run event."),
  runId: RunEventSchema.shape.runId.describe("Managed run id that owns the event."),
  ts: RunEventSchema.shape.ts.describe("ISO timestamp when the event was recorded."),
})
  .strict()
  .describe("Event emitted while a managed run executes.");

export const SessionSummarySchema = z
  .object({
    aborted: z.boolean().describe("Whether the session ended because it was aborted."),
    durationMs: z.number().int().nonnegative().describe("Session duration in milliseconds."),
    errored: z.boolean().describe("Whether the session ended with an error."),
    eventsProcessed: z
      .number()
      .int()
      .nonnegative()
      .describe("Number of Anthropic session events processed."),
    idleReached: z.boolean().describe("Whether the session reached the idle condition."),
    lastEventId: NonEmptyStringSchema.nullable().describe(
      "Last processed Anthropic event id, or null when none was recorded.",
    ),
    runId: RunIdSchema.describe("Managed run id that owns the session."),
    sessionId: NonEmptyStringSchema.describe("Anthropic Managed Agents session id."),
    timedOut: z.boolean().describe("Whether the session timed out."),
    toolErrors: z.number().int().nonnegative().describe("Number of tool calls that failed."),
    toolInvocations: z
      .number()
      .int()
      .nonnegative()
      .describe("Number of tool calls invoked by the session."),
  })
  .strict()
  .describe("Summary of an Anthropic session attached to a managed run.");
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

const RunStartSuccessOutputSchema = z
  .object({
    position: z.number().int().positive().describe("One-based position assigned by the run queue."),
    runId: RunIdSchema.describe("Stable identifier for the queued managed run."),
    status: z.literal("queued").describe("Initial lifecycle status for the queued run."),
  })
  .strict()
  .describe("Successful response returned after starting a run.");

const SchemaErrorSchema = z
  .object({
    issues: z.array(z.unknown()).describe("Validation issues reported by JSON or schema parsing."),
    message: z.literal("invalid request body").describe("Human-readable schema error message."),
    type: z.literal("schema").describe("Stable error type for request schema failures."),
  })
  .strict()
  .describe("Structured schema error returned when request parsing or validation fails.");

const SchemaErrorOutputSchema = z
  .object({
    error: SchemaErrorSchema.describe("Structured error returned when request validation fails."),
  })
  .strict()
  .describe("Error response returned when request validation fails.");

const RunNotFoundErrorSchema = z
  .object({
    message: z.literal("run not found").describe("Human-readable not-found message."),
    runId: RunIdSchema.describe("Run id requested by the caller."),
    type: z.literal("not_found").describe("Stable error type for missing runs."),
  })
  .strict()
  .describe("Structured stop error for missing runs.");

const RunAlreadyTerminalErrorSchema = z
  .object({
    message: z
      .literal("run is already terminal")
      .describe("Human-readable terminal-state message."),
    runId: RunIdSchema.describe("Run id requested by the caller."),
    status: RunStatusSchema.describe("Terminal status that prevented cancellation."),
    type: z.literal("already_terminal").describe("Stable error type for terminal runs."),
  })
  .strict()
  .describe("Structured stop error for terminal runs.");

const RunCancelTimeoutErrorSchema = z
  .object({
    message: z
      .literal("run cancellation timed out")
      .describe("Human-readable cancellation timeout message."),
    runId: RunIdSchema.describe("Run id requested by the caller."),
    type: z.literal("cancel_timeout").describe("Stable error type for cancellation timeouts."),
  })
  .strict()
  .describe("Structured stop error for cancellation timeouts.");

const RunStopErrorSchema = z
  .discriminatedUnion("type", [
    SchemaErrorSchema,
    RunNotFoundErrorSchema,
    RunAlreadyTerminalErrorSchema,
    RunCancelTimeoutErrorSchema,
  ])
  .describe("Structured error returned when stopping a run fails.");

const RunStopSuccessOutputSchema = z
  .object({
    runId: RunIdSchema.describe("Stable identifier for the stopped managed run."),
    stopped: z.boolean().describe("Whether the managed run was stopped."),
  })
  .strict()
  .describe("Successful response returned after stopping a run.");

const RunStopErrorOutputSchema = z
  .object({
    error: RunStopErrorSchema.describe("Structured error returned when run stop fails."),
  })
  .strict()
  .describe("Error response returned when stopping a run fails.");

const RunStartBaseSchema = {
  configPath: z.string().min(1).optional().describe("Optional path to a run configuration file."),
  dryRun: z
    .boolean()
    .default(false)
    .describe("Whether to enqueue the run in dry-run mode without remote execution."),
  repo: RepoSlugSchema.optional().describe(
    "Optional legacy primary GitHub repository slug. When omitted, registered repositories are used.",
  ),
  repositories: z
    .array(RepoSlugSchema)
    .optional()
    .describe("Optional explicit registered repositories to mount for the run."),
  vaultId: z
    .string()
    .min(1)
    .optional()
    .describe("Optional existing Anthropic vault id to reuse for the run."),
};

const GitHubIssueRunStartInputSchema = z
  .object({
    ...RunStartBaseSchema,
    issue: PositiveIntegerSchema.describe("Positive GitHub issue number to run."),
    origin: z.literal("github_issue").describe("Run origin type."),
  })
  .strict();

const LinearIssueRunStartInputSchema = z
  .object({
    ...RunStartBaseSchema,
    linearIssue: TrimmedNonEmptyStringSchema.describe("Linear issue identifier or URL to run."),
    origin: z.literal("linear_issue").describe("Run origin type."),
  })
  .strict();

function withDefaultRunOrigin(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const withOrigin = record.origin === undefined ? { ...record, origin: "github_issue" } : record;
  if (withOrigin.origin !== "github_issue") {
    return withOrigin;
  }

  const normalizedIssue = normalizeGitHubIssueRef(withOrigin.issue);
  if (normalizedIssue === null) {
    return withOrigin;
  }

  return {
    ...withOrigin,
    issue: normalizedIssue.issue,
    repo: typeof withOrigin.repo === "string" ? withOrigin.repo : normalizedIssue.repo,
  };
}

function normalizeGitHubIssueRef(value: unknown): { issue: number; repo?: string } | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return { issue: value };
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const numeric = trimmed.replace(/^#/, "");
  if (/^[1-9]\d*$/.test(numeric)) {
    return { issue: Number(numeric) };
  }

  const match = trimmed.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/i,
  );
  if (!match) {
    return null;
  }

  const [, owner, repo, issue] = match;
  return { issue: Number(issue), repo: `${owner}/${repo}` };
}

export const RunStartInputSchema = z
  .preprocess(
    withDefaultRunOrigin,
    z.discriminatedUnion("origin", [
      GitHubIssueRunStartInputSchema,
      LinearIssueRunStartInputSchema,
    ]),
  )
  .describe("Request body for starting a managed run.");
export type RunStartInput = z.infer<typeof RunStartInputSchema>;

export { RunOriginTypeSchema };

export const RunStartOutputSchema = z
  .union([RunStartSuccessOutputSchema, SchemaErrorOutputSchema])
  .describe("Response body returned after attempting to start a managed run.");
export type RunStartOutput = z.infer<typeof RunStartOutputSchema>;

export const RunStopInputSchema = z
  .object({
    maxWaitMs: z
      .number()
      .int()
      .positive()
      .max(60_000)
      .default(10_000)
      .describe("Maximum milliseconds to wait for stop confirmation."),
  })
  .strict()
  .describe("Request body for stopping the active managed run.");
export type RunStopInput = z.infer<typeof RunStopInputSchema>;

export const RunStopOutputSchema = z
  .union([RunStopSuccessOutputSchema, RunStopErrorOutputSchema])
  .describe("Response body returned after attempting to stop a managed run.");
export type RunStopOutput = z.infer<typeof RunStopOutputSchema>;

export const RunListQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("Maximum number of runs to return, from 1 through 200."),
    repo: RepoSlugSchema.optional().describe("Optional owner/name repository filter."),
    status: RunStatusSchema.optional().describe("Optional lifecycle status filter."),
  })
  .strict()
  .describe("URL query parameters for listing managed runs.");
export type RunListQuery = z.infer<typeof RunListQuerySchema>;

export const RunSummaryOutputSchema = z
  .object({
    runs: z.array(DescribedRunSummarySchema).describe("Run summaries returned for the query."),
    total: z.number().int().nonnegative().describe("Total number of runs matching the query."),
  })
  .strict()
  .describe("Response body for listing managed runs.");
export type RunSummaryOutput = z.infer<typeof RunSummaryOutputSchema>;

export const RunDetailOutputSchema = DescribedRunSummarySchema.extend({
  events: z
    .array(DescribedRunEventSchema)
    .optional()
    .describe("Optional run event history for the run."),
  sessions: z.array(SessionSummarySchema).describe("Anthropic session summaries for the run."),
  subIssues: z.array(DescribedSubIssueSchema).describe("Sub-issues linked to the run."),
})
  .strict()
  .describe("Detailed response body for a single managed run.");
export type RunDetailOutput = z.infer<typeof RunDetailOutputSchema>;
