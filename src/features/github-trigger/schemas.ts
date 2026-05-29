import { z } from "zod";

const RepoSlugPattern = /^[\w.-]+\/[\w.-]+$/;

export const RepoSlugSchema = z.string().regex(RepoSlugPattern, "repo must match owner/name");

/**
 * Configuration for the GitHub issue polling trigger.
 *
 * The set of polled repositories is sourced from the WebUI-managed
 * `polled_repositories` table at runtime, so this config carries only
 * cross-repository tunables (poll cadence + match keywords).
 */
export const GithubTriggerConfigSchema = z
  .object({
    botMention: z
      .string()
      .min(1, "botMention must be a non-empty string")
      .regex(/^[\w-]+$/, "botMention may only contain letters, digits, hyphens, and underscores")
      .default("bot")
      .describe(
        "GitHub username (without `@`) that triggers a run when mentioned with ` run` at the start of an issue comment.",
      ),
    intervalMs: z
      .number()
      .int()
      .positive()
      .default(60_000)
      .describe("Polling interval in milliseconds."),
    triggerLabel: z
      .string()
      .min(1, "triggerLabel must be a non-empty string")
      .default("agent-run")
      .describe("Issue label whose addition triggers a run."),
  })
  .strict();

export type GithubTriggerConfig = z.infer<typeof GithubTriggerConfigSchema>;

const TRIGGER_SOURCES = ["comment", "label"] as const;
export const GithubTriggerSourceSchema = z.enum(TRIGGER_SOURCES);
export type GithubTriggerSource = z.infer<typeof GithubTriggerSourceSchema>;

export const GithubTriggerCandidateSchema = z
  .object({
    issueNumber: z.number().int().positive(),
    reason: z.string().min(1),
    repo: RepoSlugSchema,
    source: GithubTriggerSourceSchema,
    sourceId: z.string().min(1),
  })
  .strict();

export type GithubTriggerCandidate = z.infer<typeof GithubTriggerCandidateSchema>;

/**
 * Builds the per-source dedupe key persisted in `github_trigger_dedupe`.
 *
 * Including the repo guards against the (extremely unlikely) case where
 * GitHub assigns the same numeric id to a comment in one repo and a labeled
 * event in another — they must always be treated as distinct.
 */
export function dedupeKeyOf(candidate: GithubTriggerCandidate): string {
  return `${candidate.source}:${candidate.repo}:${candidate.sourceId}`;
}

export type GithubTriggerEnv = {
  GITHUB_BOT_MENTION?: string | undefined;
  GITHUB_TRIGGER_LABEL?: string | undefined;
  GITHUB_TRIGGER_POLL_INTERVAL_SECONDS?: string | undefined;
};

/**
 * Parses environment variables into a {@link GithubTriggerConfig}.
 *
 * Repositories to poll are NOT read from env: they are managed at runtime
 * via the WebUI (`polled_repositories` table). Only cross-repo tunables
 * are sourced from environment variables here.
 */
export function parseGithubTriggerConfigFromEnv(env: GithubTriggerEnv): GithubTriggerConfig {
  const intervalSecondsRaw = env.GITHUB_TRIGGER_POLL_INTERVAL_SECONDS;
  const intervalSeconds =
    intervalSecondsRaw === undefined || intervalSecondsRaw.trim() === ""
      ? undefined
      : Number.parseInt(intervalSecondsRaw, 10);

  if (
    intervalSeconds !== undefined &&
    (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0)
  ) {
    throw new Error(
      `GITHUB_TRIGGER_POLL_INTERVAL_SECONDS must be a positive integer (got ${intervalSecondsRaw})`,
    );
  }

  return GithubTriggerConfigSchema.parse({
    botMention: env.GITHUB_BOT_MENTION?.trim() || undefined,
    intervalMs: intervalSeconds === undefined ? undefined : intervalSeconds * 1_000,
    triggerLabel: env.GITHUB_TRIGGER_LABEL?.trim() || undefined,
  });
}
