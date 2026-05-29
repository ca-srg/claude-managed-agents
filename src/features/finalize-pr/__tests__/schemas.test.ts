import { describe, expect, test } from "bun:test";

import { CreateFinalPrInput } from "@/features/finalize-pr/schemas";

function schemaDescription(schema: {
  description?: string;
  _def?: { description?: string };
}): string {
  return schema.description ?? schema._def?.description ?? "";
}

describe("CreateFinalPrInput", () => {
  test("requires title, body, head, base, and parentIssueNumber", () => {
    const parsed = CreateFinalPrInput.parse({
      base: "main",
      body: "## Summary\n- done",
      head: "feature/task-8",
      parentIssueNumber: 123,
      title: "Task 8 result",
    });

    expect(parsed.parentIssueNumber).toBe(123);
  });

  test("rejects an empty title", () => {
    const parseOutcome = CreateFinalPrInput.safeParse({
      base: "main",
      body: "x",
      head: "feature/task-8",
      parentIssueNumber: 1,
      title: "",
    });

    expect(parseOutcome.success).toBe(false);

    if (parseOutcome.success) {
      throw new Error("Expected schema parse to fail");
    }

    expect(parseOutcome.error.issues).toContainEqual(expect.objectContaining({ path: ["title"] }));
  });
});

describe("CreateFinalPr schema descriptions", () => {
  test("input schema exposes non-empty description", () => {
    expect(schemaDescription(CreateFinalPrInput)).not.toBe("");
  });

  test("major input fields expose non-empty descriptions", () => {
    expect(schemaDescription(CreateFinalPrInput.shape.title)).not.toBe("");
  });
});
