import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  type GitHubIssue,
  type GitHubIssueClient,
  titleHashFor,
} from "@/features/decomposition/github-write";
import { handleCreateSubIssue } from "@/features/decomposition/handler";
import type { Config } from "@/shared/config";
import type { RunState } from "@/shared/types";

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

type MockOctokit = GitHubIssueClient & {
  paginateCalls: RequestCall[];
  requestCalls: RequestCall[];
};

type WriteRunStateCall = {
  runId: string;
  state: RunState;
};

function stableTaskId(title: string): string {
  return createHash("sha1").update(title).digest("hex");
}

function buildIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    id: 101,
    number: 12,
    state: "open",
    title: "Parent issue",
    ...overrides,
  };
}

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    commitStyle: "conventional",
    git: {
      authorEmail: "claude-agent@users.noreply.github.com",
      authorName: "claude-agent[bot]",
    },
    maxChildMinutes: 30,
    maxRunMinutes: 120,
    maxSubIssues: 5,
    models: {
      child: "claude-sonnet-4-6",
      parent: "claude-opus-4-7",
    },
    pr: {
      draft: true,
    },
    ...overrides,
  };
}

function buildRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    branch: "task-19",
    issueNumber: 12,
    repo: "acme/widgets",
    runId: "run-123",
    sessionIds: [],
    startedAt: "2026-04-23T00:00:00.000Z",
    subIssues: [],
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

function hashTaggedSubIssue(parentIssueNumber: number, title: string): GitHubIssue {
  return buildIssue({
    id: 501,
    number: 52,
    title: `${title} [sub-issue:${titleHashFor(parentIssueNumber, {
      acceptanceCriteria: [],
      description: "",
      id: stableTaskId(title),
      title,
    })}]`,
  });
}

describe("handleCreateSubIssue", () => {
  test("invalid input returns a structured schema error and does not call the API", async () => {
    const octokit = createMockOctokit();
    const writeRunStateCalls: WriteRunStateCall[] = [];
    const invalidArgs: unknown = { title: 123 };

    const handlerOutput = await handleCreateSubIssue(
      {
        cfg: buildConfig(),
        existingSubIssues: [],
        octokit,
        owner: "acme",
        parentIssueId: 101,
        parentIssueNumber: 12,
        repo: "widgets",
        runState: buildRunState(),
        writeRunState: async (runId: string, state: RunState) => {
          writeRunStateCalls.push({ runId, state });
        },
      },
      invalidArgs,
    );

    if (handlerOutput.success) {
      throw new Error("Expected create_sub_issue to fail for invalid input");
    }

    if (!handlerOutput.error) {
      throw new Error("Expected structured schema error details");
    }

    expect(handlerOutput.error.type).toBe("schema");
    expect(octokit.requestCalls).toEqual([]);
    expect(octokit.paginateCalls).toEqual([]);
    expect(writeRunStateCalls).toEqual([]);
  });

  test("uses the passed existingSubIssues from ctx when a matching sub-issue already exists", async () => {
    const existingSubIssue = hashTaggedSubIssue(12, "Document the handler");
    const existingSubIssues = [existingSubIssue];
    const octokit = createMockOctokit();
    const writeRunStateCalls: WriteRunStateCall[] = [];

    const handlerOutput = await handleCreateSubIssue(
      {
        cfg: buildConfig(),
        existingSubIssues,
        octokit,
        owner: "acme",
        parentIssueId: 101,
        parentIssueNumber: 12,
        repo: "widgets",
        runState: buildRunState(),
        writeRunState: async (runId: string, state: RunState) => {
          writeRunStateCalls.push({ runId, state });
        },
      },
      { title: "Document the handler" },
    );

    expect(handlerOutput).toEqual({
      reused: true,
      subIssueId: 501,
      subIssueNumber: 52,
      success: true,
    });
    expect(existingSubIssues).toEqual([existingSubIssue]);
    expect(octokit.requestCalls).toEqual([]);
    expect(writeRunStateCalls).toEqual([
      {
        runId: "run-123",
        state: {
          ...buildRunState(),
          subIssues: [
            {
              issueId: 501,
              issueNumber: 52,
              taskId: stableTaskId("Document the handler"),
            },
          ],
        },
      },
    ]);
  });

  test("returns success output for a freshly created sub-issue", async () => {
    const freshTitle = "Fresh child issue";
    const expectedToken = titleHashFor(12, {
      acceptanceCriteria: [],
      description: "Implement the child issue body.",
      id: stableTaskId(freshTitle),
      title: freshTitle,
    });
    const createdIssue = buildIssue({
      id: 333,
      number: 44,
      title: `${freshTitle} [sub-issue:${expectedToken}]`,
    });
    const octokit = createMockOctokit({
      requestOutcomes: [
        { data: createdIssue, kind: "resolve" },
        { data: buildIssue(), kind: "resolve" },
      ],
    });
    const runState = buildRunState();
    const writeRunStateCalls: WriteRunStateCall[] = [];

    const handlerOutput = await handleCreateSubIssue(
      {
        cfg: buildConfig(),
        existingSubIssues: [],
        octokit,
        owner: "acme",
        parentIssueId: 101,
        parentIssueNumber: 12,
        repo: "widgets",
        runState,
        writeRunState: async (runId: string, state: RunState) => {
          writeRunStateCalls.push({ runId, state });
        },
      },
      {
        assignees: ["octocat"],
        body: "Implement the child issue body.",
        labels: ["automation"],
        title: freshTitle,
      },
    );

    expect(handlerOutput).toEqual({
      reused: false,
      subIssueId: 333,
      subIssueNumber: 44,
      success: true,
    });
    expect(octokit.requestCalls[0]).toEqual({
      body: {
        assignees: ["octocat"],
        body: String(octokit.requestCalls[0]?.body?.body),
        labels: ["automation"],
        title: `${freshTitle} [sub-issue:${expectedToken}]`,
      },
      method: "POST",
      url: "/repos/acme/widgets/issues",
    });
    expect(String(octokit.requestCalls[0]?.body?.body)).toContain(
      "Implement the child issue body.",
    );
    expect(octokit.requestCalls[1]).toEqual({
      body: { sub_issue_id: 333 },
      method: "POST",
      url: "/repos/acme/widgets/issues/12/sub_issues",
    });
    expect(runState.subIssues).toEqual([
      {
        issueId: 333,
        issueNumber: 44,
        taskId: stableTaskId(freshTitle),
      },
    ]);
    expect(writeRunStateCalls).toEqual([
      {
        runId: "run-123",
        state: {
          ...buildRunState(),
          subIssues: [
            {
              issueId: 333,
              issueNumber: 44,
              taskId: stableTaskId(freshTitle),
            },
          ],
        },
      },
    ]);
  });

  test("dedup returns reused true and makes no POST requests", async () => {
    const dedupSubIssue = hashTaggedSubIssue(12, "Document the handler");
    const octokit = createMockOctokit();

    const handlerOutput = await handleCreateSubIssue(
      {
        cfg: buildConfig(),
        existingSubIssues: [dedupSubIssue],
        octokit,
        owner: "acme",
        parentIssueId: 101,
        parentIssueNumber: 12,
        repo: "widgets",
        runState: buildRunState(),
        writeRunState: async () => {},
      },
      { title: "Document the handler" },
    );

    expect(handlerOutput).toEqual({
      reused: true,
      subIssueId: 501,
      subIssueNumber: 52,
      success: true,
    });
    expect(octokit.requestCalls).toEqual([]);
    expect(octokit.paginateCalls).toEqual([]);
  });

  test("returns a structured cap error when createSubIssue hits the configured cap", async () => {
    const octokit = createMockOctokit();

    const handlerOutput = await handleCreateSubIssue(
      {
        cfg: buildConfig({ maxSubIssues: 1 }),
        existingSubIssues: [buildIssue({ id: 901, number: 92, title: "Already linked" })],
        octokit,
        owner: "acme",
        parentIssueId: 101,
        parentIssueNumber: 12,
        repo: "widgets",
        runState: buildRunState(),
        writeRunState: async () => {},
      },
      { title: "Fresh child issue" },
    );

    if (handlerOutput.success) {
      throw new Error("Expected create_sub_issue to report a cap error");
    }

    if (!handlerOutput.error) {
      throw new Error("Expected structured cap error details");
    }

    expect(handlerOutput.error).toEqual({
      details: {
        currentCount: 1,
        maxCap: 1,
        parentIssueNumber: 12,
      },
      message: "Parent issue #12 already has 1 sub-issues; max is 1",
      type: "sub_issue_cap_exceeded",
    });
    expect(octokit.requestCalls).toEqual([]);
  });
});
