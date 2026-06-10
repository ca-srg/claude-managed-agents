import { describe, expect, test } from "bun:test";

import { buildPRBody, createOrUpdatePR, type resolveDefaultBranch } from "../github-operations";

type GitHubClient = Parameters<typeof resolveDefaultBranch>[0];

type MockApiResponse = {
  after?: () => void;
  data: unknown;
  status?: number;
};

type RequestCall = {
  body: Record<string, unknown> | undefined;
  method: string;
  url: string;
};

class MockRequestError extends Error {
  response?: {
    data?: {
      message?: string;
    };
  };
  status: number;

  constructor(message: string, status: number, apiMessage?: string) {
    super(message);
    this.name = "MockRequestError";
    this.status = status;
    this.response = apiMessage ? { data: { message: apiMessage } } : undefined;
  }
}

class MockOctokit implements GitHubClient {
  readonly calls: RequestCall[] = [];
  readonly queuedResponses = new Map<string, Array<MockApiResponse | MockRequestError>>();

  enqueue(route: string, response: MockApiResponse | MockRequestError): void {
    const existingQueue = this.queuedResponses.get(route) ?? [];
    existingQueue.push(response);
    this.queuedResponses.set(route, existingQueue);
  }

  async request<TResponse>(
    route: string,
    parameters?: Record<string, unknown>,
  ): Promise<{ data: TResponse; status: number }> {
    const [method, ...urlParts] = route.split(" ");
    if (!method) {
      throw new Error(`Unexpected request route: ${route}`);
    }

    const url = urlParts.join(" ");
    this.calls.push({ body: parameters, method, url });

    const queuedResponses = this.queuedResponses.get(route);
    const nextResponse = queuedResponses?.shift();
    if (!nextResponse) {
      throw new Error(`Unexpected request: ${route}`);
    }

    if (nextResponse instanceof MockRequestError) {
      throw nextResponse;
    }

    nextResponse.after?.();
    return {
      data: nextResponse.data as TResponse,
      status: nextResponse.status ?? 200,
    };
  }
}

function countClosingLines(body: string, issueNumber: number): number {
  return body.match(new RegExp(`^Closes #${issueNumber}$`, "gm"))?.length ?? 0;
}

function countClosingReferences(body: string, issueNumber: number): number {
  return body.match(new RegExp(`\\bCloses #${issueNumber}\\b`, "g"))?.length ?? 0;
}

function createPullRequestPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    body: "Initial body",
    draft: true,
    html_url: "https://github.com/acme/widgets/pull/7",
    number: 7,
    state: "open",
    title: "Initial title",
    ...overrides,
  };
}

describe("buildPRBody", () => {
  const claudeSessionUrl =
    "https://platform.claude.com/workspaces/default/sessions/sesn_01MfJnHA6dgV7MQjfQSZx5VY";
  const claudeSessionSection = ["## Claude Managed Agents session", claudeSessionUrl].join("\n");

  test("auto-appends Closes #N if missing from the user body", () => {
    const body = buildPRBody("Summary", 42, [
      { issueNumber: 101, title: "Task 1", url: "http://x/1" },
    ]);

    expect(body).toContain("Summary");
    expect(body).toContain("- Closes #101");
    expect(body).not.toContain("Task 1");
    expect(body).not.toContain("http://x/1");
    expect(countClosingLines(body, 42)).toBe(1);
    expect(countClosingReferences(body, 101)).toBe(1);
  });

  test("keeps Closes #N exactly once when the user body already contains it", () => {
    const userBody = ["Summary", "", "Closes #42", ""].join("\n");

    const body = buildPRBody(userBody, 42, []);

    expect(countClosingLines(body, 42)).toBe(1);
  });

  test("normalizes alternate closing keywords for the parent issue", () => {
    const userBody = ["Summary", "", "Fixes acme/widgets # 42", "Resolves #43"].join("\n");

    const body = buildPRBody(userBody, 42, []);

    expect(countClosingLines(body, 42)).toBe(1);
    expect(body).not.toContain("Fixes acme/widgets # 42");
    expect(body).toContain("Resolves #43");
  });

  test("normalizes existing closing keyword references for sub-issues", () => {
    const userBody = ["Summary", "", "Fixes #101", "Details remain"].join("\n");

    const body = buildPRBody(userBody, 42, [
      { issueNumber: 101, title: "Task 1", url: "http://x/1" },
      { issueNumber: 102, title: "Task 2", url: "http://x/2" },
    ]);

    expect(body).toContain("Details remain");
    expect(body).not.toContain("Fixes #101");
    expect(countClosingReferences(body, 101)).toBe(1);
    expect(countClosingReferences(body, 102)).toBe(1);
  });

  test("strips all GitHub closing keyword references for Linear-origin bodies", () => {
    const userBody = [
      "Summary",
      "",
      "FIXES # 123",
      "Resolves acme/widgets #456",
      "This closed https://github.com/acme/widgets/issues/789.",
      "Details remain",
    ].join("\n");

    const body = buildPRBody(userBody, null, [], "## Origin\n- ENG-123");

    expect(body).toContain("Summary");
    expect(body).toContain("Details remain");
    expect(body).toContain("## Origin");
    expect(body).not.toContain("# 123");
    expect(body).not.toContain("acme/widgets #456");
    expect(body).not.toContain("https://github.com/acme/widgets/issues/789");
    expect(body).not.toContain("Closes #");
  });

  test("appends the Claude Managed Agents session URL at the bottom", () => {
    const body = buildPRBody("Summary", 42, [], "", claudeSessionSection);

    expect(body).toBe(`Summary\n\nCloses #42\n\n${claudeSessionSection}\n`);
    expect(body.endsWith(`${claudeSessionUrl}\n`)).toBe(true);
  });

  test("truncates PR bodies over 60KB with ...[truncated; see sub-issues for details] marker", () => {
    const longSummary = "A".repeat(70 * 1024);

    const body = buildPRBody(
      longSummary,
      42,
      [{ title: "Task 1", url: "http://x/1" }],
      "",
      claudeSessionSection,
    );

    expect(Buffer.byteLength(body, "utf8") <= 60 * 1024).toBe(true);
    expect(body).toContain("...[truncated; see sub-issues for details]");
    expect(countClosingLines(body, 42)).toBe(1);
    expect(body.endsWith(`${claudeSessionUrl}\n`)).toBe(true);
  });
});

describe("createOrUpdatePR", () => {
  test("creates a new PR when no existing PR matches the head branch", async () => {
    const mockOctokit = new MockOctokit();
    mockOctokit.enqueue("GET /repos/{owner}/{repo}/pulls", { data: [] });
    mockOctokit.enqueue("GET /repos/{owner}/{repo}", {
      data: { default_branch: "main" },
    });
    mockOctokit.enqueue("POST /repos/{owner}/{repo}/pulls", {
      data: createPullRequestPayload({
        body: "Summary\n\n## Sub-issues\n- [Task 1](http://x/1)\n\nCloses #42\n",
        draft: false,
      }),
      status: 201,
    });

    const prOutcome = await createOrUpdatePR(mockOctokit, {
      body: "Summary",
      head: "feature/task-10",
      owner: "acme",
      repo: "widgets",
      title: "Add PR service",
    });

    expect(prOutcome).toEqual({
      prNumber: 7,
      prUrl: "https://github.com/acme/widgets/pull/7",
      updated: false,
    });

    const createCall = mockOctokit.calls.at(-1);
    if (!createCall?.body) {
      throw new Error("Expected the create PR request to include a body payload");
    }

    expect(createCall.method).toBe("POST");
    expect(createCall.url).toBe("/repos/{owner}/{repo}/pulls");
    expect(createCall.body.base).toBe("main");
    expect(createCall.body.draft).toBe(false);
    expect(createCall.body.head).toBe("feature/task-10");
    expect(createCall.body.title).toBe("Add PR service");

    const requestBody = createCall.body.body;
    if (typeof requestBody !== "string") {
      throw new Error("Expected the create PR body to be a string");
    }

    expect(requestBody).toBe("Summary");
  });

  test("updates the existing PR for the same head branch instead of creating a duplicate", async () => {
    const mockOctokit = new MockOctokit();
    mockOctokit.enqueue("GET /repos/{owner}/{repo}/pulls", {
      data: [
        createPullRequestPayload({
          body: "Old body",
          draft: false,
          number: 11,
          title: "Old title",
        }),
      ],
    });
    mockOctokit.enqueue("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      data: createPullRequestPayload({
        body: "Updated body\n\nCloses #42\n",
        draft: false,
        number: 11,
        title: "Updated title",
      }),
    });

    const prOutcome = await createOrUpdatePR(mockOctokit, {
      base: "release",
      body: "Updated body",
      draft: false,
      head: "feature/task-10",
      owner: "acme",
      repo: "widgets",
      title: "Updated title",
    });

    expect(prOutcome).toEqual({
      prNumber: 11,
      prUrl: "https://github.com/acme/widgets/pull/7",
      updated: true,
    });
    expect(mockOctokit.calls).toHaveLength(2);
    expect(mockOctokit.calls[1]?.method).toBe("PATCH");
    expect(mockOctokit.calls[1]?.url).toBe("/repos/{owner}/{repo}/pulls/{pull_number}");
    expect(mockOctokit.calls[1]?.body?.pull_number).toBe(11);
    expect(mockOctokit.calls[1]?.body?.title).toBe("Updated title");
    expect(mockOctokit.calls[1]?.body?.base).toBe("release");
    expect(mockOctokit.calls[1]?.body?.body).toBe("Updated body");
    expect(mockOctokit.calls.some((call) => call.method === "POST")).toBe(false);
  });

  test("returns the update result when the signal aborts after the PATCH succeeds", async () => {
    const abortController = new AbortController();
    const mockOctokit = new MockOctokit();
    mockOctokit.enqueue("GET /repos/{owner}/{repo}/pulls", {
      data: [createPullRequestPayload({ body: "Old body", number: 21, title: "Old title" })],
    });
    mockOctokit.enqueue("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      after: () => abortController.abort(),
      data: createPullRequestPayload({
        html_url: "https://github.com/acme/widgets/pull/21",
        number: 21,
        title: "Updated title",
      }),
    });

    const prOutcome = await createOrUpdatePR(mockOctokit, {
      base: "release",
      body: "Updated body",
      head: "feature/task-21",
      owner: "acme",
      repo: "widgets",
      signal: abortController.signal,
      title: "Updated title",
    });

    expect(abortController.signal.aborted).toBe(true);
    expect(prOutcome).toEqual({
      prNumber: 21,
      prUrl: "https://github.com/acme/widgets/pull/21",
      updated: true,
    });
    const readRequest = mockOctokit.calls[0]?.body?.request as { signal?: AbortSignal } | undefined;
    expect(readRequest?.signal).toBe(abortController.signal);
    expect(Object.hasOwn(mockOctokit.calls[1]?.body ?? {}, "request")).toBe(false);
  });

  test("returns the create result when the signal aborts after the POST succeeds", async () => {
    const abortController = new AbortController();
    const mockOctokit = new MockOctokit();
    mockOctokit.enqueue("GET /repos/{owner}/{repo}/pulls", { data: [] });
    mockOctokit.enqueue("GET /repos/{owner}/{repo}", {
      data: { default_branch: "main" },
    });
    mockOctokit.enqueue("POST /repos/{owner}/{repo}/pulls", {
      after: () => abortController.abort(),
      data: createPullRequestPayload({
        html_url: "https://github.com/acme/widgets/pull/22",
        number: 22,
      }),
      status: 201,
    });

    const prOutcome = await createOrUpdatePR(mockOctokit, {
      body: "Summary",
      head: "feature/task-22",
      owner: "acme",
      repo: "widgets",
      signal: abortController.signal,
      title: "Add PR service",
    });

    expect(abortController.signal.aborted).toBe(true);
    expect(prOutcome).toEqual({
      prNumber: 22,
      prUrl: "https://github.com/acme/widgets/pull/22",
      updated: false,
    });
    const findReadRequest = mockOctokit.calls[0]?.body?.request as
      | { signal?: AbortSignal }
      | undefined;
    const defaultBranchReadRequest = mockOctokit.calls[1]?.body?.request as
      | { signal?: AbortSignal }
      | undefined;
    expect(findReadRequest?.signal).toBe(abortController.signal);
    expect(defaultBranchReadRequest?.signal).toBe(abortController.signal);
    expect(Object.hasOwn(mockOctokit.calls[2]?.body ?? {}, "request")).toBe(false);
  });

  test("defaults to draft=false (ready for review) when draft is omitted for new pull requests", async () => {
    const mockOctokit = new MockOctokit();
    mockOctokit.enqueue("GET /repos/{owner}/{repo}/pulls", { data: [] });
    mockOctokit.enqueue("GET /repos/{owner}/{repo}", {
      data: { default_branch: "main" },
    });
    mockOctokit.enqueue("POST /repos/{owner}/{repo}/pulls", {
      data: createPullRequestPayload({ draft: false, number: 12 }),
      status: 201,
    });

    await createOrUpdatePR(mockOctokit, {
      body: "Summary",
      head: "feature/default-ready",
      owner: "acme",
      repo: "widgets",
      title: "Default ready",
    });

    expect(mockOctokit.calls[2]?.body?.draft).toBe(false);
  });

  test("honors an explicit draft=false value for new pull requests", async () => {
    const mockOctokit = new MockOctokit();
    mockOctokit.enqueue("GET /repos/{owner}/{repo}/pulls", { data: [] });
    mockOctokit.enqueue("GET /repos/{owner}/{repo}", {
      data: { default_branch: "main" },
    });
    mockOctokit.enqueue("POST /repos/{owner}/{repo}/pulls", {
      data: createPullRequestPayload({ draft: false, number: 13 }),
      status: 201,
    });

    await createOrUpdatePR(mockOctokit, {
      body: "Summary",
      draft: false,
      head: "feature/ready-for-review",
      owner: "acme",
      repo: "widgets",
      title: "Ready for review",
    });

    expect(mockOctokit.calls[2]?.body?.draft).toBe(false);
  });

  test("fails fast with a clear error when GitHub reports that the pull request already exists", async () => {
    const mockOctokit = new MockOctokit();
    mockOctokit.enqueue("GET /repos/{owner}/{repo}/pulls", { data: [] });
    mockOctokit.enqueue("GET /repos/{owner}/{repo}", {
      data: { default_branch: "main" },
    });
    mockOctokit.enqueue(
      "POST /repos/{owner}/{repo}/pulls",
      new MockRequestError(
        "Validation Failed",
        422,
        "A pull request already exists for acme:feature/task-10.",
      ),
    );

    await expect(
      createOrUpdatePR(mockOctokit, {
        body: "Summary",
        head: "feature/task-10",
        owner: "acme",
        repo: "widgets",
        title: "Add PR service",
      }),
    ).rejects.toThrow("Pull request already exists for head branch feature/task-10");
  });
});
