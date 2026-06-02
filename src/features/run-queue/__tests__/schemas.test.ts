import { describe, expect, test } from "bun:test";

import { RunStartInputSchema } from "@/features/run-queue/schemas";

describe("RunStartInputSchema", () => {
  test("accepts GitHub issue URLs and adopts the URL repository", () => {
    const parseOutcome = RunStartInputSchema.safeParse({
      issue: "https://github.com/CyberAgentSRG/server/issues/21925",
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

  test("accepts GitHub issue URLs when the explicit repo matches", () => {
    const parseOutcome = RunStartInputSchema.safeParse({
      issue: "https://github.com/CyberAgentSRG/server/issues/21925",
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

  test("rejects GitHub issue URLs when the explicit repo conflicts", () => {
    const parseOutcome = RunStartInputSchema.safeParse({
      issue: "https://github.com/CyberAgentSRG/server/issues/21925",
      repo: "CyberAgentSRG/api",
    });

    expect(parseOutcome.success).toBe(false);

    if (parseOutcome.success) {
      throw new Error("Expected schema parse to fail");
    }

    expect(parseOutcome.error.issues).toContainEqual(expect.objectContaining({ path: ["repo"] }));
  });
});
