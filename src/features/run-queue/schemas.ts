import { z } from "zod";

const BaseRunStartInputSchema = {
  configPath: z.string().min(1).optional(),
  dryRun: z.boolean().default(false),
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "repo must match owner/name"),
  vaultId: z.string().min(1).optional(),
};

const GitHubIssueRunStartInputSchema = z
  .object({
    ...BaseRunStartInputSchema,
    issue: z.number().int().positive(),
    origin: z.literal("github_issue"),
  })
  .strict();

const LinearIssueRunStartInputSchema = z
  .object({
    ...BaseRunStartInputSchema,
    linearIssue: z.string().min(1),
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

export const RunStartInputSchema = z.preprocess(
  withDefaultRunOrigin,
  z.discriminatedUnion("origin", [GitHubIssueRunStartInputSchema, LinearIssueRunStartInputSchema]),
);

export type ParsedRunStartInput = z.output<typeof RunStartInputSchema>;
export type RunStartInput =
  | ParsedRunStartInput
  | (Omit<z.output<typeof GitHubIssueRunStartInputSchema>, "origin"> & {
      origin?: "github_issue";
    });
