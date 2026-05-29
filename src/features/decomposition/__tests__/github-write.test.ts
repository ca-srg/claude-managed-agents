import { describe, expect, test } from "bun:test";

import {
  closeOrphanIssue,
  createSubIssue,
  type GitHubIssue,
  SubIssueCapExceeded,
  titleHashFor,
  unlinkSubIssue,
} from "@/features/decomposition/github-write";
import type { DecomposedTask } from "@/shared/types";

type RequestCall = {
  body?: Record<string, unknown>;
  method: string;
  url: string;
};

type RequestOutcome =
  | {
      data: unknown;
      kind: "resolve";
    }
  | {
      error: Error;
      kind: "reject";
    };

type MockOctokit = {
  paginate: (route: string, parameters?: Record<string, unknown>) => Promise<unknown[]>;
  paginateCalls: RequestCall[];
  request: (route: string, parameters?: Record<string, unknown>) => Promise<{ data: unknown }>;
  requestCalls: RequestCall[];
};

const taskA: DecomposedTask = {
  acceptanceCriteria: ["ships cleanly", "keeps title hash stable"],
  description: "Implement the child issue behavior.",
  id: "task-a",
  title: "Task A",
};

function buildIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    id: 101,
    number: 12,
    state: "open",
    title: "Parent issue",
    ...overrides,
  };
}

function materializeCall(route: string, parameters: Record<string, unknown> = {}): RequestCall {
  const routeParts = route.split(" ");
  const method = routeParts[0];
  const rawUrl = routeParts[1];
  if (typeof method !== "string" || typeof rawUrl !== "string") {
    throw new Error(`Invalid route: ${route}`);
  }

  const placeholderKeys: string[] = [];
  for (const placeholderMatch of rawUrl.matchAll(/\{([^}]+)\}/g)) {
    const placeholderKey = placeholderMatch[1];
    if (typeof placeholderKey !== "string") {
      throw new Error(`Invalid placeholder in route: ${route}`);
    }

    placeholderKeys.push(placeholderKey);
  }

  let url = rawUrl;
  for (const placeholderKey of placeholderKeys) {
    const placeholderValue = parameters[placeholderKey];
    if (typeof placeholderValue === "undefined") {
      throw new Error(`Missing route parameter: ${placeholderKey}`);
    }

    url = url.replace(`{${placeholderKey}}`, String(placeholderValue));
  }

  const bodyEntries = Object.entries(parameters).filter(
    ([parameterKey]) =>
      !placeholderKeys.includes(parameterKey) &&
      parameterKey !== "page" &&
      parameterKey !== "per_page",
  );

  return {
    body: bodyEntries.length > 0 ? Object.fromEntries(bodyEntries) : undefined,
    method,
    url,
  };
}

function createMockOctokit(
  options: { paginateOutcomes?: unknown[][]; requestOutcomes?: RequestOutcome[] } = {},
): MockOctokit {
  const pendingPaginateOutcomes = [...(options.paginateOutcomes ?? [])];
  const pendingRequestOutcomes = [...(options.requestOutcomes ?? [])];
  const paginateCalls: RequestCall[] = [];
  const requestCalls: RequestCall[] = [];

  return {
    async paginate(route: string, parameters?: Record<string, unknown>) {
      paginateCalls.push(materializeCall(route, parameters ?? {}));

      const nextOutcome = pendingPaginateOutcomes.shift();
      if (!nextOutcome) {
        throw new Error(`Unexpected paginate call: ${route}`);
      }

      return nextOutcome;
    },
    paginateCalls,
    async request(route: string, parameters?: Record<string, unknown>) {
      requestCalls.push(materializeCall(route, parameters ?? {}));

      const nextOutcome = pendingRequestOutcomes.shift();
      if (!nextOutcome) {
        throw new Error(`Unexpected request call: ${route}`);
      }

      if (nextOutcome.kind === "reject") {
        throw nextOutcome.error;
      }

      return { data: nextOutcome.data };
    },
    requestCalls,
  };
}

describe("github decomposition write", () => {
  test("createSubIssue creates an issue and then links it to the parent", async () => {
    const expectedHash = titleHashFor(12, taskA);
    const createdIssue = buildIssue({
      id: 333,
      number: 44,
      title: `Task A [sub-issue:${expectedHash}]`,
    });
    const octokit = createMockOctokit({
      requestOutcomes: [
        { data: createdIssue, kind: "resolve" },
        { data: buildIssue(), kind: "resolve" },
      ],
    });

    const creation = await createSubIssue(octokit, {
      assignees: ["octocat"],
      existingSubIssues: [],
      labels: ["automation"],
      maxCap: 5,
      owner: "acme",
      parentId: 101,
      parentN: 12,
      repo: "widgets",
      task: taskA,
    });

    expect(creation).toEqual({ issue: createdIssue, reused: false });
    expect(octokit.requestCalls).toHaveLength(2);
    expect(octokit.requestCalls[0]).toEqual({
      body: {
        assignees: ["octocat"],
        body: String(octokit.requestCalls[0]?.body?.body),
        labels: ["automation"],
        title: `Task A [sub-issue:${expectedHash}]`,
      },
      method: "POST",
      url: "/repos/acme/widgets/issues",
    });
    expect(String(octokit.requestCalls[0]?.body?.body)).toContain(
      "Implement the child issue behavior.",
    );
    expect(octokit.requestCalls[1]).toEqual({
      body: { sub_issue_id: 333 },
      method: "POST",
      url: "/repos/acme/widgets/issues/12/sub_issues",
    });
  });

  test("createSubIssue is idempotent when an existing sub-issue title contains the hash", async () => {
    const stableHash = titleHashFor(12, taskA);
    const existingSubIssue = buildIssue({
      id: 404,
      number: 55,
      title: `Task A [sub-issue:${stableHash}]`,
    });
    const octokit = createMockOctokit();

    const creation = await createSubIssue(octokit, {
      assignees: [],
      existingSubIssues: [existingSubIssue],
      labels: [],
      maxCap: 5,
      owner: "acme",
      parentId: 101,
      parentN: 12,
      repo: "widgets",
      task: taskA,
    });

    expect(creation).toEqual({ issue: existingSubIssue, reused: true });
    expect(octokit.requestCalls).toEqual([]);
  });

  test("createSubIssue closes the orphan issue when linking fails and never DELETEs an issue endpoint", async () => {
    const createdIssue = buildIssue({ id: 700, number: 71, title: "Child issue" });
    const octokit = createMockOctokit({
      requestOutcomes: [
        { data: createdIssue, kind: "resolve" },
        { error: new Error("link failed"), kind: "reject" },
        { data: buildIssue({ number: 71, state: "closed" }), kind: "resolve" },
      ],
    });

    await expect(
      createSubIssue(octokit, {
        assignees: [],
        existingSubIssues: [],
        labels: [],
        maxCap: 5,
        owner: "acme",
        parentId: 101,
        parentN: 12,
        repo: "widgets",
        task: taskA,
      }),
    ).rejects.toThrow("link failed");

    expect(octokit.requestCalls).toHaveLength(3);
    expect(octokit.requestCalls[0]).toEqual({
      body: {
        assignees: [],
        body: String(octokit.requestCalls[0]?.body?.body),
        labels: [],
        title: String(octokit.requestCalls[0]?.body?.title),
      },
      method: "POST",
      url: "/repos/acme/widgets/issues",
    });
    expect(typeof octokit.requestCalls[0]?.body?.body).toBe("string");
    expect(String(octokit.requestCalls[0]?.body?.title)).toContain("Task A");
    expect(octokit.requestCalls[1]).toEqual({
      body: { sub_issue_id: 700 },
      method: "POST",
      url: "/repos/acme/widgets/issues/12/sub_issues",
    });
    expect(octokit.requestCalls[2]).toEqual({
      body: { state: "closed", state_reason: "not_planned" },
      method: "PATCH",
      url: "/repos/acme/widgets/issues/71",
    });
    expect(
      octokit.requestCalls.some(
        (requestCall) =>
          requestCall.method === "DELETE" &&
          /\/repos\/acme\/widgets\/issues\/\d+$/.test(requestCall.url),
      ),
    ).toBe(false);
  });

  test("createSubIssue enforces the configured max sub-issue cap", async () => {
    const octokit = createMockOctokit();

    let thrownError: unknown;

    try {
      await createSubIssue(octokit, {
        assignees: [],
        existingSubIssues: [buildIssue({ id: 901, number: 92, title: "Already linked" })],
        labels: [],
        maxCap: 1,
        owner: "acme",
        parentId: 101,
        parentN: 12,
        repo: "widgets",
        task: taskA,
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError instanceof SubIssueCapExceeded).toBe(true);

    expect(octokit.requestCalls).toEqual([]);
  });

  test("closeOrphanIssue patches the issue closed with not_planned", async () => {
    const octokit = createMockOctokit({
      requestOutcomes: [{ data: buildIssue({ number: 44, state: "closed" }), kind: "resolve" }],
    });

    await closeOrphanIssue(octokit, "acme", "widgets", 44);

    expect(octokit.requestCalls).toEqual([
      {
        body: { state: "closed", state_reason: "not_planned" },
        method: "PATCH",
        url: "/repos/acme/widgets/issues/44",
      },
    ]);
  });

  test("unlinkSubIssue deletes the sub-issue relationship", async () => {
    const octokit = createMockOctokit({
      requestOutcomes: [{ data: buildIssue(), kind: "resolve" }],
    });

    await unlinkSubIssue(octokit, "acme", "widgets", 12, 333);

    expect(octokit.requestCalls).toEqual([
      {
        body: { sub_issue_id: 333 },
        method: "DELETE",
        url: "/repos/acme/widgets/issues/12/sub_issue",
      },
    ]);
  });
});
