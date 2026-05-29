import { z } from "zod";

const NonEmptyStringSchema = z.string().min(1);
const PositiveIntegerSchema = z.number().int().positive();

const RepoRefSchema = z.object({
  name: NonEmptyStringSchema,
  owner: NonEmptyStringSchema,
});

export type RepoRef = z.infer<typeof RepoRefSchema>;

export const StopByIssueRepoSchema = z.object({
  issueNumber: PositiveIntegerSchema,
  repo: RepoRefSchema,
});
export type StopByIssueRepoInput = z.infer<typeof StopByIssueRepoSchema>;

export const StopByRunIdSchema = z.object({
  runId: NonEmptyStringSchema,
});
export type StopByRunIdInput = z.infer<typeof StopByRunIdSchema>;

export const StopOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    runId: NonEmptyStringSchema,
    status: z.literal("stopped"),
  }),
  z.object({
    reason: z.enum([
      "not_found",
      "already_completed",
      "pid_missing",
      "process_not_running",
      "still_running_after_signal",
    ]),
    runId: NonEmptyStringSchema.optional(),
    status: z.literal("not_stopped"),
  }),
]);
export type StopOutcome = z.infer<typeof StopOutcomeSchema>;
