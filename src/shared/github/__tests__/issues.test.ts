import { describe, expect, test } from "bun:test";

import { type GitHubIssue, listSubIssues, readIssue } from "@/shared/github/issues";

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

describe("shared github issues", () => {
  test("readIssue rejects when target is a pull request", async () => {
    const octokit = createMockOctokit({
      requestOutcomes: [
        {
          data: buildIssue({ pull_request: { url: "https://example.test/pr/12" } }),
          kind: "resolve",
        },
      ],
    });

    await expect(readIssue(octokit, "acme", "widgets", 12)).rejects.toThrow("pull request");

    expect(octokit.requestCalls).toEqual([
      { body: undefined, method: "GET", url: "/repos/acme/widgets/issues/12" },
    ]);
    expect(octokit.paginateCalls).toEqual([]);
  });

  test("readIssue rejects when issue is closed", async () => {
    const octokit = createMockOctokit({
      requestOutcomes: [{ data: buildIssue({ state: "closed" }), kind: "resolve" }],
    });

    await expect(readIssue(octokit, "acme", "widgets", 12)).rejects.toThrow("closed");

    expect(octokit.requestCalls).toEqual([
      { body: undefined, method: "GET", url: "/repos/acme/widgets/issues/12" },
    ]);
    expect(octokit.paginateCalls).toEqual([]);
  });

  test("readIssue returns the issue plus existing sub-issues", async () => {
    const existingSubIssue = buildIssue({ id: 501, number: 34, title: "Child issue" });
    const octokit = createMockOctokit({
      paginateOutcomes: [[existingSubIssue]],
      requestOutcomes: [{ data: buildIssue(), kind: "resolve" }],
    });

    const issueRecord = await readIssue(octokit, "acme", "widgets", 12);

    expect(issueRecord.issue).toEqual(buildIssue());
    expect(issueRecord.subIssues).toEqual([existingSubIssue]);
    expect(octokit.requestCalls).toEqual([
      { body: undefined, method: "GET", url: "/repos/acme/widgets/issues/12" },
    ]);
    expect(octokit.paginateCalls).toEqual([
      { body: undefined, method: "GET", url: "/repos/acme/widgets/issues/12/sub_issues" },
    ]);
  });

  test("listSubIssues returns the paginated sub-issue array", async () => {
    const firstSubIssue = buildIssue({ id: 201, number: 21, title: "Child A" });
    const secondSubIssue = buildIssue({ id: 202, number: 22, title: "Child B" });
    const octokit = createMockOctokit({ paginateOutcomes: [[firstSubIssue, secondSubIssue]] });

    const subIssues = await listSubIssues(octokit, "acme", "widgets", 12);

    expect(subIssues).toEqual([firstSubIssue, secondSubIssue]);
    expect(octokit.paginateCalls).toEqual([
      { body: undefined, method: "GET", url: "/repos/acme/widgets/issues/12/sub_issues" },
    ]);
  });
});
