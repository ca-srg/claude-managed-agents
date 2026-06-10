import { z } from "zod";

export const CreateFinalPrInput = z
  .object({
    base: z.string().min(1).describe("Base branch the final pull request should target."),
    body: z
      .string()
      .min(1)
      .describe(
        "Pull request body content to publish or update. Must be written in Japanese. Use English for terms commonly written in English in developer workflows, such as code identifiers, file paths, URLs, and quoted source text.",
      ),
    head: z
      .string()
      .min(1)
      .describe("Head branch containing the orchestrated implementation work."),
    parentIssueNumber: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Deprecated: parent GitHub issue number. The server validates this against run origin when provided.",
      ),
    title: z
      .string()
      .min(1)
      .describe(
        "Pull request title to publish or update. Must be written in English using Conventional Commits format (`type(scope): subject`; omit scope when not useful).",
      ),
  })
  .strict()
  .describe("Input payload for creating or updating the final parent pull request.");

export const CreateFinalPrOutput = z
  .object({
    prNumber: z
      .number()
      .int()
      .positive()
      .describe("GitHub pull request number that was created or updated."),
    prUrl: z.string().url().describe("Canonical URL for the created or updated pull request."),
    success: z.boolean().describe("Whether the final pull request operation succeeded."),
    updated: z.boolean().describe("True when an existing PR was updated instead of created."),
  })
  .strict()
  .describe("Success payload returned after creating or updating the final pull request.");
