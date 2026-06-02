import { describe, expect, test } from "bun:test";

import {
  RunDetailOutputSchema,
  RunListQuerySchema,
  RunStartInputSchema,
  RunStartOutputSchema,
  RunStopInputSchema,
  RunStopOutputSchema,
  RunSummaryOutputSchema,
} from "@/features/run-api/schemas";

function schemaDescription(schema: {
  description?: string;
  _def?: { description?: string };
}): string {
  return schema.description ?? schema._def?.description ?? "";
}

describe("RunStartInputSchema", () => {
  test("accepts a GitHub legacy start payload", () => {
    const parseOutcome = RunStartInputSchema.safeParse({
      dryRun: false,
      issue: 21925,
      repo: "CyberAgentSRG/server",
    });

    expect(parseOutcome.success).toBe(true);

    if (!parseOutcome.success) {
      throw new Error("Expected schema parse to succeed");
    }

    expect(parseOutcome.data).toEqual({
      dryRun: false,
      issue: 21925,
      origin: "github_issue",
      repo: "CyberAgentSRG/server",
    });
  });

  test("accepts a Linear issue start payload", () => {
    const parseOutcome = RunStartInputSchema.safeParse({
      linearIssue: "ENG-123",
      origin: "linear_issue",
      repo: "CyberAgentSRG/server",
    });

    expect(parseOutcome.success).toBe(true);

    if (!parseOutcome.success) {
      throw new Error("Expected schema parse to succeed");
    }

    expect(parseOutcome.data).toEqual({
      dryRun: false,
      linearIssue: "ENG-123",
      origin: "linear_issue",
      repo: "CyberAgentSRG/server",
    });
  });

  test("trims Linear issue identifiers before validating non-empty input", () => {
    const parseOutcome = RunStartInputSchema.safeParse({
      linearIssue: "  ENG-123  ",
      origin: "linear_issue",
      repo: "CyberAgentSRG/server",
    });

    expect(parseOutcome.success).toBe(true);

    if (!parseOutcome.success) {
      throw new Error("Expected schema parse to succeed");
    }

    expect(parseOutcome.data).toEqual({
      dryRun: false,
      linearIssue: "ENG-123",
      origin: "linear_issue",
      repo: "CyberAgentSRG/server",
    });

    const blankOutcome = RunStartInputSchema.safeParse({
      linearIssue: "   ",
      origin: "linear_issue",
      repo: "CyberAgentSRG/server",
    });

    expect(blankOutcome.success).toBe(false);

    if (blankOutcome.success) {
      throw new Error("Expected schema parse to fail");
    }

    expect(blankOutcome.error.issues).toContainEqual(
      expect.objectContaining({ path: ["linearIssue"] }),
    );
  });

  test("rejects Linear issue start payloads without an explicit repo", () => {
    const parseOutcome = RunStartInputSchema.safeParse({
      linearIssue: "ENG-123",
      origin: "linear_issue",
    });

    expect(parseOutcome.success).toBe(false);

    if (parseOutcome.success) {
      throw new Error("Expected schema parse to fail");
    }

    expect(parseOutcome.error.issues).toContainEqual(expect.objectContaining({ path: ["repo"] }));
  });

  test("rejects non-positive issue numbers and invalid repo slugs", () => {
    const parseOutcome = RunStartInputSchema.safeParse({ issue: 0, repo: "invalid" });

    expect(parseOutcome.success).toBe(false);

    if (parseOutcome.success) {
      throw new Error("Expected schema parse to fail");
    }

    expect(parseOutcome.error.issues).toContainEqual(expect.objectContaining({ path: ["issue"] }));
    expect(parseOutcome.error.issues).toContainEqual(expect.objectContaining({ path: ["repo"] }));
  });

  test("rejects unknown keys", () => {
    const parseOutcome = RunStartInputSchema.safeParse({
      extra: "no",
      issue: 1,
      repo: "a/b",
    });

    expect(parseOutcome.success).toBe(false);

    if (parseOutcome.success) {
      throw new Error("Expected schema parse to fail");
    }

    expect(parseOutcome.error.issues).toContainEqual(
      expect.objectContaining({ code: "unrecognized_keys" }),
    );
  });
});

describe("RunStopInputSchema", () => {
  test("defaults maxWaitMs to 10000", () => {
    const parseOutcome = RunStopInputSchema.safeParse({});

    expect(parseOutcome.success).toBe(true);

    if (!parseOutcome.success) {
      throw new Error("Expected schema parse to succeed");
    }

    expect(parseOutcome.data.maxWaitMs).toBe(10_000);
  });
});

describe("RunListQuerySchema", () => {
  test("coerces URL query limit strings and accepts known status values", () => {
    const parseOutcome = RunListQuerySchema.safeParse({ limit: "50", status: "running" });

    expect(parseOutcome.success).toBe(true);

    if (!parseOutcome.success) {
      throw new Error("Expected schema parse to succeed");
    }

    expect(parseOutcome.data).toEqual({ limit: 50, status: "running" });
  });

  test("rejects unknown status values", () => {
    const parseOutcome = RunListQuerySchema.safeParse({ status: "unknown" });

    expect(parseOutcome.success).toBe(false);

    if (parseOutcome.success) {
      throw new Error("Expected schema parse to fail");
    }

    expect(parseOutcome.error.issues).toContainEqual(expect.objectContaining({ path: ["status"] }));
  });
});

describe("run-api output schemas", () => {
  test("accept start and stop success and error responses", () => {
    expect(
      RunStartOutputSchema.safeParse({ position: 1, runId: "run-1", status: "queued" }).success,
    ).toBe(true);
    expect(
      RunStartOutputSchema.safeParse({
        error: { issues: [], message: "invalid request body", type: "schema" },
      }).success,
    ).toBe(true);
    expect(
      RunStartOutputSchema.safeParse({
        error: {
          message: "At least one enabled repository must be registered before starting a run",
          type: "run_target_resolution",
        },
      }).success,
    ).toBe(true);
    expect(RunStopOutputSchema.safeParse({ runId: "run-1", stopped: true }).success).toBe(true);
    expect(
      RunStopOutputSchema.safeParse({
        error: { message: "run not found", runId: "run-1", type: "not_found" },
      }).success,
    ).toBe(true);
    expect(
      RunStopOutputSchema.safeParse({
        error: {
          message: "run is already terminal",
          runId: "run-1",
          status: "completed",
          type: "already_terminal",
        },
      }).success,
    ).toBe(true);
    expect(
      RunStopOutputSchema.safeParse({
        error: { message: "run cancellation timed out", runId: "run-1", type: "cancel_timeout" },
      }).success,
    ).toBe(true);
    expect(
      RunStopOutputSchema.safeParse({
        error: { issues: [], message: "invalid request body", type: "schema" },
      }).success,
    ).toBe(true);
  });

  test("accepts run summary and detail response payloads", () => {
    const runSummary = {
      issueNumber: 21925,
      repo: "CyberAgentSRG/server",
      runId: "run-1",
      startedAt: "2026-04-28T12:00:00Z",
      status: "running",
    };

    expect(RunSummaryOutputSchema.parse({ runs: [runSummary], total: 1 })).toEqual({
      runs: [runSummary],
      total: 1,
    });

    const detail = RunDetailOutputSchema.parse({
      ...runSummary,
      events: [
        {
          id: "event-1",
          kind: "phase",
          payload: { phase: "decomposition" },
          runId: "run-1",
          ts: "2026-04-28T12:00:01Z",
        },
      ],
      sessions: [
        {
          aborted: false,
          durationMs: 123,
          errored: false,
          eventsProcessed: 4,
          idleReached: true,
          lastEventId: null,
          runId: "run-1",
          sessionId: "sesn-1",
          timedOut: false,
          toolErrors: 0,
          toolInvocations: 2,
        },
      ],
      subIssues: [{ issueId: 1, issueNumber: 2, taskId: "task-1" }],
    });

    expect(detail.sessions[0]?.sessionId).toBe("sesn-1");
  });
});

describe("run-api schema descriptions", () => {
  test("input schemas and fields expose non-empty descriptions", () => {
    expect(schemaDescription(RunStartInputSchema)).not.toBe("");
    expect(schemaDescription(RunStopInputSchema.shape.maxWaitMs)).not.toBe("");
    expect(schemaDescription(RunListQuerySchema.shape.limit)).not.toBe("");
    expect(schemaDescription(RunListQuerySchema.shape.repo)).not.toBe("");
  });
});
