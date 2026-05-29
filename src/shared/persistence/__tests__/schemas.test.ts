import { describe, expect, test } from "bun:test";

import { RunPhaseSchema, RunStatusSchema, RunSummarySchema } from "../schemas";

describe("run-level schemas", () => {
  test("accepts a valid run status", () => {
    expect(RunStatusSchema.safeParse("queued").success).toBe(true);
  });

  test("rejects an invalid run status", () => {
    expect(RunStatusSchema.safeParse("invalid").success).toBe(false);
  });

  test("accepts a valid run phase", () => {
    expect(RunPhaseSchema.safeParse("preflight").success).toBe(true);
  });

  test("accepts a minimal run summary", () => {
    expect(
      RunSummarySchema.safeParse({
        runId: "r1",
        issueNumber: 1,
        repo: "a/b",
        startedAt: "2026-01-01",
        status: "running",
      }).success,
    ).toBe(true);
  });
});
