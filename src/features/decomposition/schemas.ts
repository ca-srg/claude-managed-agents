import { z } from "zod";

import { ToolErrorSchema } from "@/shared/tool-schema-core";

export const CreateSubIssueInput = z
  .object({
    assignees: z
      .array(z.string().min(1).describe("GitHub login to assign to the created sub-issue."))
      .optional()
      .describe("Optional list of GitHub assignees for the sub-issue."),
    body: z
      .string()
      .optional()
      .describe(
        "Optional Markdown body for the sub-issue. Must be written in Japanese. Use English for terms commonly written in English in developer workflows, such as code identifiers, file paths, URLs, and quoted source text.",
      ),
    labels: z
      .array(z.string().min(1).describe("GitHub label name to apply to the sub-issue."))
      .optional()
      .describe("Optional label names for the sub-issue."),
    title: z
      .string()
      .min(1)
      .describe(
        "Sub-issue title for the delegated child task. Must be written in English using Conventional Commits format (`type(scope): subject`; omit scope when not useful).",
      ),
  })
  .strict()
  .describe("Input payload for creating or reusing a linked GitHub sub-issue.");

export const CreateSubIssueOutput = z
  .object({
    error: ToolErrorSchema.optional().describe(
      "Structured failure details when sub-issue creation fails.",
    ),
    reused: z.boolean().describe("True when an existing matching sub-issue was reused."),
    subIssueId: z
      .number()
      .int()
      .positive()
      .describe("GitHub node/database id for the linked sub-issue."),
    subIssueNumber: z
      .number()
      .int()
      .positive()
      .describe("GitHub issue number for the linked sub-issue."),
    success: z.boolean().describe("Whether the sub-issue operation succeeded."),
  })
  .strict()
  .describe("Result payload returned after creating or reusing a linked sub-issue.");
