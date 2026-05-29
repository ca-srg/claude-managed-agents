import { describe, expect, test } from "bun:test";

import { CreateSubIssueInput } from "@/features/decomposition/schemas";

function schemaDescription(schema: {
  description?: string;
  _def?: { description?: string };
}): string {
  return schema.description ?? schema._def?.description ?? "";
}

describe("CreateSubIssueInput", () => {
  test("accepts title with optional body and labels", () => {
    const parsed = CreateSubIssueInput.parse({
      assignees: ["octocat"],
      body: "Sub-issue body",
      labels: ["automation", "task"],
      title: "Child task",
    });

    expect(parsed).toEqual({
      assignees: ["octocat"],
      body: "Sub-issue body",
      labels: ["automation", "task"],
      title: "Child task",
    });
  });

  test("rejects a payload without title", () => {
    const parseOutcome = CreateSubIssueInput.safeParse({ body: "no title" });

    expect(parseOutcome.success).toBe(false);

    if (parseOutcome.success) {
      throw new Error("Expected schema parse to fail");
    }

    expect(parseOutcome.error.issues).toContainEqual(expect.objectContaining({ path: ["title"] }));
  });
});

describe("CreateSubIssue schema descriptions", () => {
  test("input schema exposes non-empty description", () => {
    expect(schemaDescription(CreateSubIssueInput)).not.toBe("");
  });

  test("major input fields expose non-empty descriptions", () => {
    expect(schemaDescription(CreateSubIssueInput.shape.body)).not.toBe("");
  });
});
