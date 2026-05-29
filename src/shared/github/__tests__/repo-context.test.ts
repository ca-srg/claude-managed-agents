import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { Logger } from "pino";

import { formatRepoContext, loadRepoContext } from "@/shared/github/repo-context";

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
  request: (route: string, parameters?: Record<string, unknown>) => Promise<{ data: unknown }>;
  requestCalls: RequestCall[];
};

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
    ([parameterKey]) => !placeholderKeys.includes(parameterKey),
  );

  return {
    body: bodyEntries.length > 0 ? Object.fromEntries(bodyEntries) : undefined,
    method,
    url,
  };
}

function createMockOctokit(options: { requestOutcomes?: RequestOutcome[] } = {}): MockOctokit {
  const pendingRequestOutcomes = [...(options.requestOutcomes ?? [])];
  const requestCalls: RequestCall[] = [];

  return {
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

function asLoadRepoContextOctokit(octokit: MockOctokit): Parameters<typeof loadRepoContext>[0] {
  return octokit as unknown as Parameters<typeof loadRepoContext>[0];
}

function createLoggerSpy(): { logger: Logger; warnCalls: unknown[][] } {
  const warnCalls: unknown[][] = [];

  return {
    logger: {
      warn: (...args: unknown[]) => {
        warnCalls.push(args);
      },
    } as unknown as Logger,
    warnCalls,
  };
}

function githubError(status: number, message = `GitHub error ${status}`): Error {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

function encodedContent(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

function contentFile(path: string, content: string): Record<string, unknown> {
  const name = path.split("/").pop() ?? path;

  return {
    content: encodedContent(content),
    encoding: "base64",
    name,
    path,
    type: "file",
  };
}

describe("shared github repo context", () => {
  test("aggregates all repository context files when present", async () => {
    const { logger, warnCalls } = createLoggerSpy();
    const octokit = createMockOctokit({
      requestOutcomes: [
        { data: contentFile("CLAUDE.md", "Claude instructions"), kind: "resolve" },
        { data: contentFile("AGENTS.md", "Agent instructions"), kind: "resolve" },
        {
          data: [
            { name: "z-rule.md", path: ".claude/rules/z-rule.md", type: "file" },
            { name: "a-rule.md", path: ".claude/rules/a-rule.md", type: "file" },
          ],
          kind: "resolve",
        },
        { data: contentFile(".claude/rules/a-rule.md", "Rule A"), kind: "resolve" },
        { data: contentFile(".claude/rules/z-rule.md", "Rule Z"), kind: "resolve" },
      ],
    });

    const context = await loadRepoContext(
      asLoadRepoContextOctokit(octokit),
      "acme",
      "widgets",
      "main",
      logger,
    );

    expect(context.files).toEqual([
      { content: "Claude instructions", path: "CLAUDE.md" },
      { content: "Agent instructions", path: "AGENTS.md" },
      { content: "Rule A", path: ".claude/rules/a-rule.md" },
      { content: "Rule Z", path: ".claude/rules/z-rule.md" },
    ]);
    expect(octokit.requestCalls.map((call) => call.url)).toEqual([
      "/repos/acme/widgets/contents/CLAUDE.md",
      "/repos/acme/widgets/contents/AGENTS.md",
      "/repos/acme/widgets/contents/.claude/rules",
      "/repos/acme/widgets/contents/.claude/rules/a-rule.md",
      "/repos/acme/widgets/contents/.claude/rules/z-rule.md",
    ]);
    expect(warnCalls).toEqual([]);
  });

  test("returns CLAUDE.md when it is the only existing context file", async () => {
    const { logger } = createLoggerSpy();
    const octokit = createMockOctokit({
      requestOutcomes: [
        { data: contentFile("CLAUDE.md", "Only Claude"), kind: "resolve" },
        { error: githubError(404), kind: "reject" },
        { error: githubError(404), kind: "reject" },
      ],
    });

    const context = await loadRepoContext(
      asLoadRepoContextOctokit(octokit),
      "acme",
      "widgets",
      "main",
      logger,
    );

    expect(context.files).toEqual([{ content: "Only Claude", path: "CLAUDE.md" }]);
  });

  test("returns an empty base64 file as valid repository context", async () => {
    const { logger, warnCalls } = createLoggerSpy();
    const octokit = createMockOctokit({
      requestOutcomes: [
        { data: contentFile("CLAUDE.md", ""), kind: "resolve" },
        { error: githubError(404), kind: "reject" },
        { error: githubError(404), kind: "reject" },
      ],
    });

    const context = await loadRepoContext(
      asLoadRepoContextOctokit(octokit),
      "acme",
      "widgets",
      "main",
      logger,
    );

    expect(context.files).toEqual([{ content: "", path: "CLAUDE.md" }]);
    expect(warnCalls).toEqual([]);
  });

  test("returns an empty context when every target path is missing", async () => {
    const { logger, warnCalls } = createLoggerSpy();
    const octokit = createMockOctokit({
      requestOutcomes: [
        { error: githubError(404), kind: "reject" },
        { error: githubError(404), kind: "reject" },
        { error: githubError(404), kind: "reject" },
      ],
    });

    const context = await loadRepoContext(
      asLoadRepoContextOctokit(octokit),
      "acme",
      "widgets",
      "main",
      logger,
    );

    expect(context.files).toEqual([]);
    expect(warnCalls).toEqual([]);
  });

  test("ignores non-markdown files in .claude/rules", async () => {
    const { logger } = createLoggerSpy();
    const octokit = createMockOctokit({
      requestOutcomes: [
        { error: githubError(404), kind: "reject" },
        { error: githubError(404), kind: "reject" },
        {
          data: [
            { name: "rule.txt", path: ".claude/rules/rule.txt", type: "file" },
            { name: "nested.md", path: ".claude/rules/nested.md", type: "dir" },
            { name: "rule.md", path: ".claude/rules/rule.md", type: "file" },
          ],
          kind: "resolve",
        },
        { data: contentFile(".claude/rules/rule.md", "Markdown rule"), kind: "resolve" },
      ],
    });

    const context = await loadRepoContext(
      asLoadRepoContextOctokit(octokit),
      "acme",
      "widgets",
      "main",
      logger,
    );

    expect(context.files).toEqual([{ content: "Markdown rule", path: ".claude/rules/rule.md" }]);
    expect(octokit.requestCalls.map((call) => call.url)).not.toContain(
      "/repos/acme/widgets/contents/.claude/rules/rule.txt",
    );
  });

  test("warns and skips rules when directory listing fails with a non-404 error", async () => {
    const { logger, warnCalls } = createLoggerSpy();
    const octokit = createMockOctokit({
      requestOutcomes: [
        { error: githubError(404), kind: "reject" },
        { error: githubError(404), kind: "reject" },
        { error: githubError(500), kind: "reject" },
      ],
    });

    const context = await loadRepoContext(
      asLoadRepoContextOctokit(octokit),
      "acme",
      "widgets",
      "main",
      logger,
    );

    expect(context.files).toEqual([]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[1]).toBe("failed to list repository context rules; skipping");
  });

  test("falls back to raw media type when GitHub returns encoding 'none' for large files", async () => {
    const { logger, warnCalls } = createLoggerSpy();
    const octokit = createMockOctokit({
      // loadRepoContext kicks off three parallel requests (CLAUDE.md, AGENTS.md,
      // .claude/rules) before any of them can await; the CLAUDE.md raw fallback
      // only fires after the metadata response resolves, so it lands fourth.
      requestOutcomes: [
        {
          data: {
            content: "",
            encoding: "none",
            name: "CLAUDE.md",
            path: "CLAUDE.md",
            size: 100,
            type: "file",
          },
          kind: "resolve",
        },
        { error: githubError(404), kind: "reject" },
        { error: githubError(404), kind: "reject" },
        { data: "Large Claude instructions", kind: "resolve" },
      ],
    });

    const context = await loadRepoContext(
      asLoadRepoContextOctokit(octokit),
      "acme",
      "widgets",
      "main",
      logger,
    );

    expect(context.files).toEqual([{ content: "Large Claude instructions", path: "CLAUDE.md" }]);
    expect(octokit.requestCalls.map((call) => call.url)).toEqual([
      "/repos/acme/widgets/contents/CLAUDE.md",
      "/repos/acme/widgets/contents/AGENTS.md",
      "/repos/acme/widgets/contents/.claude/rules",
      "/repos/acme/widgets/contents/CLAUDE.md",
    ]);
    expect(octokit.requestCalls[3]?.body).toMatchObject({
      mediaType: { format: "raw" },
    });
    expect(warnCalls).toEqual([]);
  });

  test("warns and skips raw fallback content that exceeds the size limit", async () => {
    const { logger, warnCalls } = createLoggerSpy();
    const oversizedRawContent = "a".repeat(2 * 1024 * 1024 + 1);
    const octokit = createMockOctokit({
      requestOutcomes: [
        {
          data: {
            content: "",
            encoding: "none",
            name: "CLAUDE.md",
            path: "CLAUDE.md",
            size: 100,
            type: "file",
          },
          kind: "resolve",
        },
        { error: githubError(404), kind: "reject" },
        { error: githubError(404), kind: "reject" },
        { data: oversizedRawContent, kind: "resolve" },
      ],
    });

    const context = await loadRepoContext(
      asLoadRepoContextOctokit(octokit),
      "acme",
      "widgets",
      "main",
      logger,
    );

    expect(context.files).toEqual([]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[1]).toBe("raw repository context file exceeds size limit; skipping");
  });

  test("warns and skips raw fallback when metadata size exceeds the limit", async () => {
    const { logger, warnCalls } = createLoggerSpy();
    const octokit = createMockOctokit({
      requestOutcomes: [
        {
          data: {
            content: "",
            encoding: "none",
            name: "CLAUDE.md",
            path: "CLAUDE.md",
            size: 5 * 1024 * 1024,
            type: "file",
          },
          kind: "resolve",
        },
        { error: githubError(404), kind: "reject" },
        { error: githubError(404), kind: "reject" },
      ],
    });

    const context = await loadRepoContext(
      asLoadRepoContextOctokit(octokit),
      "acme",
      "widgets",
      "main",
      logger,
    );

    const urls = octokit.requestCalls.map((call) => call.url);

    expect(context.files).toEqual([]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[1]).toBe("repository context file metadata exceeds size limit; skipping");
    expect(urls.filter((url) => url === "/repos/acme/widgets/contents/CLAUDE.md")).toHaveLength(1);
  });

  test("warns and skips files with unexpected encoding", async () => {
    const { logger, warnCalls } = createLoggerSpy();
    const octokit = createMockOctokit({
      requestOutcomes: [
        {
          data: {
            content: "ignored",
            encoding: "rot13",
            name: "CLAUDE.md",
            path: "CLAUDE.md",
            type: "file",
          },
          kind: "resolve",
        },
        { error: githubError(404), kind: "reject" },
        { error: githubError(404), kind: "reject" },
      ],
    });

    const context = await loadRepoContext(
      asLoadRepoContextOctokit(octokit),
      "acme",
      "widgets",
      "main",
      logger,
    );

    expect(context.files).toEqual([]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[1]).toBe("repository context file has unexpected encoding; skipping");
  });

  test("warns and skips when the raw fallback fails for a large file", async () => {
    const { logger, warnCalls } = createLoggerSpy();
    const octokit = createMockOctokit({
      requestOutcomes: [
        {
          data: {
            content: "",
            encoding: "none",
            name: "CLAUDE.md",
            path: "CLAUDE.md",
            type: "file",
          },
          kind: "resolve",
        },
        { error: githubError(404), kind: "reject" },
        { error: githubError(404), kind: "reject" },
        { error: githubError(500), kind: "reject" },
      ],
    });

    const context = await loadRepoContext(
      asLoadRepoContextOctokit(octokit),
      "acme",
      "widgets",
      "main",
      logger,
    );

    expect(context.files).toEqual([]);
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[1]).toBe("failed to load repository context file as raw; skipping");
  });

  test("decodes base64 file content as utf8", async () => {
    const { logger } = createLoggerSpy();
    const octokit = createMockOctokit({
      requestOutcomes: [
        { data: contentFile("CLAUDE.md", "日本語の指示 🚀"), kind: "resolve" },
        { error: githubError(404), kind: "reject" },
        { error: githubError(404), kind: "reject" },
      ],
    });

    const context = await loadRepoContext(
      asLoadRepoContextOctokit(octokit),
      "acme",
      "widgets",
      "main",
      logger,
    );

    expect(context.files[0]?.content).toBe("日本語の指示 🚀");
  });

  test("formatRepoContext returns null for an empty context", () => {
    expect(formatRepoContext({ files: [] }, "main")).toBeNull();
  });

  test("formatRepoContext includes the base branch and each file path", () => {
    const formatted = formatRepoContext(
      {
        files: [
          { content: "  Claude rules\n", path: "CLAUDE.md" },
          { content: "Agent rules", path: "AGENTS.md" },
          { content: "Project rule", path: ".claude/rules/project.md" },
        ],
      },
      "release/1.x",
    );

    expect(formatted).not.toBeNull();
    expect(formatted).toContain("base branch `release/1.x`");
    expect(formatted).toContain("### CLAUDE.md");
    expect(formatted).toContain("### AGENTS.md");
    expect(formatted).toContain("### .claude/rules/project.md");
    expect(formatted).toContain("Claude rules");
    expect(formatted).toContain(
      "When delegating tasks to the implementer agent, you MUST include the relevant parts",
    );
  });
});
