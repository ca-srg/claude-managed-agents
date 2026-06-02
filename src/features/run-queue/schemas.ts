import { z } from "zod";

const BaseRunStartInputSchema = {
  configPath: z.string().min(1).optional(),
  dryRun: z.boolean().default(false),
  repo: z
    .string()
    .regex(/^[^/]+\/[^/]+$/, "repo must match owner/name")
    .optional(),
  repositories: z
    .array(z.string().regex(/^[^/]+\/[^/]+$/, "repo must match owner/name"))
    .optional(),
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
