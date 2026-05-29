import { z } from "zod";

import { RunStatusSchema } from "@/shared/persistence/schemas";

const NonEmptyStringSchema = z.string().min(1);
const RepoSlugSchema = z.string().regex(/^[^/]+\/[^/]+$/, "repo must match owner/name");

const RunExecutionBaseSchema = {
  configPath: NonEmptyStringSchema.optional(),
  dryRun: z.boolean(),
  repo: RepoSlugSchema,
  runId: NonEmptyStringSchema.optional(),
  vaultId: NonEmptyStringSchema.optional(),
};

const GitHubIssueRunExecutionInputSchema = z
  .object({
    ...RunExecutionBaseSchema,
    issue: z.number().int().positive(),
    origin: z.literal("github_issue"),
  })
  .strict();

const LinearIssueRunExecutionInputSchema = z
  .object({
    ...RunExecutionBaseSchema,
    linearIssue: NonEmptyStringSchema,
    origin: z.literal("linear_issue"),
  })
  .strict();

function withDefaultRunOrigin(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  return record.origin === undefined ? { ...record, origin: "github_issue" } : value;
}

export const RunExecutionInputSchema = z.preprocess(
  withDefaultRunOrigin,
  z.discriminatedUnion("origin", [
    GitHubIssueRunExecutionInputSchema,
    LinearIssueRunExecutionInputSchema,
  ]),
);

export const RunExecutionResultSchema = z
  .object({
    aborted: z.boolean(),
    decompositionPlan: z.unknown().optional(),
    errored: z
      .object({
        message: NonEmptyStringSchema,
        type: NonEmptyStringSchema,
      })
      .optional(),
    prUrl: NonEmptyStringSchema.optional(),
    runId: NonEmptyStringSchema,
    status: RunStatusSchema,
    timedOut: z.boolean(),
  })
  .strict();

export type ParsedRunExecutionInput = z.output<typeof RunExecutionInputSchema>;
export type RunExecutionInput =
  | ParsedRunExecutionInput
  | (Omit<z.output<typeof GitHubIssueRunExecutionInputSchema>, "origin"> & {
      origin?: "github_issue";
    });
export type RunExecutionResult = z.infer<typeof RunExecutionResultSchema>;
