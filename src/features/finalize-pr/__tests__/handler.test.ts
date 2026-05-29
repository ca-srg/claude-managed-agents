import { beforeEach, describe, expect, test } from "bun:test";

import type { Config } from "@/shared/config";
import type { RunState } from "@/shared/types";
import type {
  CreateOrUpdatePROptions,
  CreateOrUpdatePRResult,
  GitHubRequestClient,
  PR,
  SubIssueSummary,
} from "../github-operations";
import { type CreateFinalPrContext, createFinalPrDeps, handleCreateFinalPr } from "../handler";

declare module "bun:test" {
  function beforeEach(fn: () => void | Promise<void>): void;
}

type BuildPRBody = typeof import("../github-operations").buildPRBody;
type BuildPRBodyArgs = Parameters<BuildPRBody>;
type CreateOrUpdatePR = typeof import("../github-operations").createOrUpdatePR;
type ResolveDefaultBranch = typeof import("../github-operations").resolveDefaultBranch;
type ResolveDefaultBranchArgs = Parameters<ResolveDefaultBranch>;

type RequestCall = {
  parameters: Record<string, unknown> | undefined;
  route: string;
};

type MockApiResponse = {
  data: unknown;
  status?: number;
};

class MockOctokit implements GitHubRequestClient {
  readonly calls: RequestCall[] = [];
  readonly queuedResponses = new Map<string, Array<MockApiResponse | Error>>();

  enqueue(route: string, response: MockApiResponse | Error): void {
    const queuedEntries = this.queuedResponses.get(route) ?? [];
    queuedEntries.push(response);
    this.queuedResponses.set(route, queuedEntries);
  }

  async request<TResponse>(
    route: string,
    parameters?: Record<string, unknown>,
  ): Promise<{ data: TResponse; status?: number }> {
    this.calls.push({ parameters, route });

    const queuedEntries = this.queuedResponses.get(route);
    const nextResponse = queuedEntries?.shift();
    if (!nextResponse) {
      throw new Error(`Unexpected request: ${route}`);
    }

    if (nextResponse instanceof Error) {
      throw nextResponse;
    }

    return {
      data: nextResponse.data as TResponse,
      status: nextResponse.status,
    };
  }
}

const buildPRBodyCalls: BuildPRBodyArgs[] = [];
const createOrUpdatePRCalls: CreateOrUpdatePROptions[] = [];
const resolveDefaultBranchCalls: ResolveDefaultBranchArgs[] = [];

function defaultBuildPRBody(
  userBody: string,
  parentIssueNumber: number | null,
  subIssuesSummary: readonly SubIssueSummary[],
  originSection = "",
): string {
  const normalizedUserBody =
    parentIssueNumber === null
      ? userBody.replace(/(^|\n)\s*Closes\s*:?\s*#\d+\s*(?=\n|$)/gi, "$1").trim()
      : userBody
          .replace(
            new RegExp(`(^|\\n)\\s*Closes\\s*:?\\s*#${parentIssueNumber}\\s*(?=\\n|$)`, "gi"),
            "$1",
          )
          .trim();
  const subIssueLines = subIssuesSummary.map(
    (subIssue) => `- [${subIssue.title}](${subIssue.url})`,
  );
  const sections = [normalizedUserBody];

  if (subIssueLines.length > 0) {
    sections.push(["## Sub-issues", ...subIssueLines].join("\n"));
  }

  if (originSection.trim().length > 0) {
    sections.push(originSection);
  }

  if (parentIssueNumber !== null) {
    sections.push(`Closes #${parentIssueNumber}`);
  }

  return `${sections.filter((section) => section.trim().length > 0).join("\n\n")}\n`;
}

async function defaultResolveDefaultBranch(): Promise<string> {
  return "main";
}

async function defaultCreateOrUpdatePR(
  octokit: GitHubRequestClient,
  options: CreateOrUpdatePROptions,
): Promise<CreateOrUpdatePRResult> {
  const existingPrResponse = await octokit.request<PR[]>("GET /repos/{owner}/{repo}/pulls", {
    head: options.head,
    owner: options.owner,
    per_page: 1,
    repo: options.repo,
    state: "open",
  });
  const existingPr = existingPrResponse.data[0];

  if (existingPr) {
    const updateResponse = await octokit.request<PR>(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        base: options.base,
        body: options.body,
        owner: options.owner,
        pull_number: existingPr.number,
        repo: options.repo,
        title: options.title,
      },
    );

    return {
      prNumber: updateResponse.data.number,
      prUrl: updateResponse.data.html_url,
      updated: true,
    };
  }

  const createResponse = await octokit.request<PR>("POST /repos/{owner}/{repo}/pulls", {
    base: options.base ?? (await defaultResolveDefaultBranch()),
    body: options.body,
    draft: options.draft,
    head: options.head,
    owner: options.owner,
    repo: options.repo,
    title: options.title,
  });

  return {
    prNumber: createResponse.data.number,
    prUrl: createResponse.data.html_url,
    updated: false,
  };
}

let buildPRBodyImpl: BuildPRBody = defaultBuildPRBody;
let createOrUpdatePRImpl: CreateOrUpdatePR = defaultCreateOrUpdatePR;
let resolveDefaultBranchImpl: ResolveDefaultBranch = defaultResolveDefaultBranch;

type HandlerContext = CreateFinalPrContext;

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    commitStyle: "conventional",
    git: {
      authorEmail: "claude-agent@users.noreply.github.com",
      authorName: "claude-agent[bot]",
    },
    maxChildMinutes: 30,
    maxRunMinutes: 120,
    maxSubIssues: 10,
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
    branch: "feature/final-pr",
    issueNumber: 42,
    repo: "acme/widgets",
    runId: "run-123",
    sessionIds: ["session-1"],
    startedAt: "2026-04-23T00:00:00.000Z",
    subIssues: [
      { issueId: 501, issueNumber: 101, taskId: "task-1" },
      { issueId: 502, issueNumber: 102, taskId: "task-2" },
    ],
    ...overrides,
  };
}

function buildContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  const octokit = overrides.octokit ?? new MockOctokit();

  const context: HandlerContext = {
    baseBranch: overrides.baseBranch,
    cfg: overrides.cfg ?? buildConfig(),
    octokit,
    owner: overrides.owner ?? "acme",
    parentIssueNumber: overrides.parentIssueNumber ?? 42,
    repo: overrides.repo ?? "widgets",
    runState: overrides.runState ?? buildRunState(),
  };

  if (overrides.signal) {
    context.signal = overrides.signal;
  }

  return context;
}

function buildValidArgs(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    base: "main",
    body: "Implementation summary",
    head: "feature/final-pr",
    parentIssueNumber: 42,
    title: "Ship final PR",
    ...overrides,
  };
}

function buildPullRequest(overrides: Partial<PR> = {}): PR {
  return {
    body: "Original body",
    html_url: "https://github.com/acme/widgets/pull/12",
    number: 12,
    title: "Original title",
    ...overrides,
  };
}

function countClosingLines(body: string, issueNumber: number): number {
  return body.match(new RegExp(`^Closes #${issueNumber}$`, "gm"))?.length ?? 0;
}

beforeEach(() => {
  buildPRBodyCalls.length = 0;
  createOrUpdatePRCalls.length = 0;
  resolveDefaultBranchCalls.length = 0;
  buildPRBodyImpl = defaultBuildPRBody;
  createOrUpdatePRImpl = defaultCreateOrUpdatePR;
  resolveDefaultBranchImpl = defaultResolveDefaultBranch;
  createFinalPrDeps.buildPRBody = (...args: BuildPRBodyArgs) => {
    buildPRBodyCalls.push(args);
    return buildPRBodyImpl(...args);
  };
  createFinalPrDeps.createOrUpdatePR = (...args: Parameters<CreateOrUpdatePR>) => {
    createOrUpdatePRCalls.push(args[1]);
    return createOrUpdatePRImpl(...args);
  };
  createFinalPrDeps.resolveDefaultBranch = (...args: ResolveDefaultBranchArgs) => {
    resolveDefaultBranchCalls.push(args);
    return resolveDefaultBranchImpl(...args);
  };
});

describe("handleCreateFinalPr", () => {
  test("returns structured validation errors when required fields are missing or invalid", async () => {
    const invalidCases = [
      buildValidArgs({ title: undefined }),
      buildValidArgs({ body: undefined }),
      buildValidArgs({ head: undefined }),
      {
        body: "Implementation summary",
        head: "feature/final-pr",
        parentIssueNumber: 42,
        title: "Ship final PR",
      },
      buildValidArgs({ parentIssueNumber: 0 }),
    ];

    for (const invalidArgs of invalidCases) {
      const prOutcome = await handleCreateFinalPr(buildContext(), invalidArgs);

      if (!("error" in prOutcome)) {
        throw new Error("Expected validation failures to return success=false");
      }

      expect(prOutcome.prUrl).toBe("");
      expect(prOutcome.prNumber).toBe(0);
      expect(prOutcome.updated).toBe(false);
      expect(prOutcome.error.type).toBe("validation_error");
      expect(prOutcome.error.message).toContain("Invalid create_final_pr input");
    }

    expect(createOrUpdatePRCalls).toHaveLength(0);
  });

  test("uses ctx.baseBranch instead of resolving when base is effectively missing", async () => {
    createOrUpdatePRImpl = async (_octokit, _options): Promise<CreateOrUpdatePRResult> => ({
      prNumber: 77,
      prUrl: "https://github.com/acme/widgets/pull/77",
      updated: false,
    });
    resolveDefaultBranchImpl = async () => {
      throw new Error("resolveDefaultBranch should not run when ctx.baseBranch is set");
    };

    const prOutcome = await handleCreateFinalPr(
      buildContext({ baseBranch: "release/2026.04" }),
      buildValidArgs({ base: "   " }),
    );

    expect(prOutcome).toEqual({
      prNumber: 77,
      prUrl: "https://github.com/acme/widgets/pull/77",
      success: true,
      updated: false,
    });
    expect(resolveDefaultBranchCalls).toHaveLength(0);
    expect(createOrUpdatePRCalls[0]?.base).toBe("release/2026.04");
  });

  test("default branch is resolved when base is effectively missing", async () => {
    createOrUpdatePRImpl = async (_octokit, _options): Promise<CreateOrUpdatePRResult> => ({
      prNumber: 78,
      prUrl: "https://github.com/acme/widgets/pull/78",
      updated: false,
    });
    resolveDefaultBranchImpl = async () => "develop";

    const prOutcome = await handleCreateFinalPr(buildContext(), buildValidArgs({ base: "   " }));

    expect(prOutcome).toEqual({
      prNumber: 78,
      prUrl: "https://github.com/acme/widgets/pull/78",
      success: true,
      updated: false,
    });
    expect(resolveDefaultBranchCalls).toHaveLength(1);
    expect(resolveDefaultBranchCalls[0]?.[1]).toBe("acme");
    expect(resolveDefaultBranchCalls[0]?.[2]).toBe("widgets");
    expect(createOrUpdatePRCalls[0]?.base).toBe("develop");
  });

  test("body includes Closes #42 exactly once and lists each sub-issue number", async () => {
    createOrUpdatePRImpl = async (_octokit, _options): Promise<CreateOrUpdatePRResult> => ({
      prNumber: 79,
      prUrl: "https://github.com/acme/widgets/pull/79",
      updated: false,
    });

    await handleCreateFinalPr(
      buildContext(),
      buildValidArgs({
        body: "Summary line\n\nCloses #42",
      }),
    );

    const requestBody = createOrUpdatePRCalls[0]?.body;
    if (typeof requestBody !== "string") {
      throw new Error("Expected createOrUpdatePR to receive a string body");
    }

    expect(countClosingLines(requestBody, 42)).toBe(1);
    expect(requestBody).toContain("#101");
    expect(requestBody).toContain("#102");
  });

  test("sub-issue summary list appears in body", async () => {
    createOrUpdatePRImpl = async (_octokit, _options): Promise<CreateOrUpdatePRResult> => ({
      prNumber: 80,
      prUrl: "https://github.com/acme/widgets/pull/80",
      updated: false,
    });

    await handleCreateFinalPr(buildContext(), buildValidArgs());

    const requestBody = createOrUpdatePRCalls[0]?.body;
    if (typeof requestBody !== "string") {
      throw new Error("Expected createOrUpdatePR to receive a string body");
    }

    expect(requestBody).toContain("## Sub-issues");
    expect(requestBody).toContain("[Sub-issue #101](https://github.com/acme/widgets/issues/101)");
    expect(requestBody).toContain("[Sub-issue #102](https://github.com/acme/widgets/issues/102)");
  });

  test("existing PR updates title/body without creating a duplicate", async () => {
    const octokit = new MockOctokit();
    octokit.enqueue("GET /repos/{owner}/{repo}/pulls", {
      data: [buildPullRequest({ body: "Old body", number: 19, title: "Old title" })],
    });
    octokit.enqueue("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      data: buildPullRequest({
        body: "Updated body\n\nCloses #42\n",
        number: 19,
        title: "Updated title",
      }),
    });

    const prOutcome = await handleCreateFinalPr(
      buildContext({ octokit }),
      buildValidArgs({ body: "Updated body", title: "Updated title" }),
    );

    expect(prOutcome).toEqual({
      prNumber: 19,
      prUrl: "https://github.com/acme/widgets/pull/12",
      success: true,
      updated: true,
    });
    expect(
      octokit.calls.filter((call) => call.route === "POST /repos/{owner}/{repo}/pulls"),
    ).toHaveLength(0);
    expect(
      octokit.calls.filter(
        (call) => call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      ),
    ).toHaveLength(1);

    const updateParameters = octokit.calls.find(
      (call) => call.route === "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
    )?.parameters;
    expect(updateParameters?.title).toBe("Updated title");
    expect(typeof updateParameters?.body).toBe("string");
  });

  test("returns success true with prUrl prNumber and updated on success", async () => {
    createOrUpdatePRImpl = async (_octokit, _options): Promise<CreateOrUpdatePRResult> => ({
      prNumber: 81,
      prUrl: "https://github.com/acme/widgets/pull/81",
      updated: true,
    });

    const prOutcome = await handleCreateFinalPr(buildContext(), buildValidArgs());

    expect(prOutcome).toEqual({
      prNumber: 81,
      prUrl: "https://github.com/acme/widgets/pull/81",
      success: true,
      updated: true,
    });
  });

  test("returns the PR result when the signal aborts after createOrUpdatePR succeeds", async () => {
    const abortController = new AbortController();
    createOrUpdatePRImpl = async (_octokit, _options): Promise<CreateOrUpdatePRResult> => {
      abortController.abort();
      return {
        prNumber: 82,
        prUrl: "https://github.com/acme/widgets/pull/82",
        updated: false,
      };
    };

    const prOutcome = await handleCreateFinalPr(
      buildContext({ signal: abortController.signal }),
      buildValidArgs(),
    );

    expect(abortController.signal.aborted).toBe(true);
    expect(createOrUpdatePRCalls[0]?.signal).toBe(abortController.signal);
    expect(prOutcome).toEqual({
      prNumber: 82,
      prUrl: "https://github.com/acme/widgets/pull/82",
      success: true,
      updated: false,
    });
  });
});
