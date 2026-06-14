import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { Octokit } from "octokit";
import pino from "pino";

import { GITHUB_API_VERSION } from "@/shared/constants";

import { createGitHubClient } from "../octokit";

type FetchResponseSpec = {
  body: unknown;
  headers?: Record<string, string>;
  status: number;
};

const packageJson = JSON.parse(
  readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
) as { version: string };

async function captureRequestHeaders(
  client: Octokit,
): Promise<Record<string, string | number | undefined>> {
  let capturedHeaders: Record<string, string | number | undefined> | undefined;

  client.hook.wrap("request", async (_request, requestOptions) => {
    capturedHeaders = { ...requestOptions.headers };
    throw new Error("stop");
  });

  await client.rest.users.getAuthenticated().catch((error: Error) => {
    expect(error.message).toBe("stop");
  });

  if (!capturedHeaders) {
    throw new Error("Expected request headers to be captured");
  }

  return capturedHeaders;
}

function createBufferedLogger() {
  const logStream = new PassThrough();
  const logLines: string[] = [];

  logStream.on("data", (chunk) => {
    logLines.push(chunk.toString());
  });

  return {
    logger: pino({ level: "warn" }, logStream),
    logLines,
  };
}

function mockFetchSequence(responseSpecs: FetchResponseSpec[]) {
  const fetchCalls: Array<{ init?: RequestInit; input: RequestInfo | URL }> = [];
  const originalFetch = globalThis.fetch;
  const remainingSpecs = [...responseSpecs];

  const mockedFetch: typeof fetch = async (input, init) => {
    fetchCalls.push({ init, input });

    const nextResponse = remainingSpecs.shift();
    if (!nextResponse) {
      throw new Error("Unexpected fetch call");
    }

    return new Response(JSON.stringify(nextResponse.body), {
      headers: {
        "content-type": "application/json",
        ...nextResponse.headers,
      },
      status: nextResponse.status,
    });
  };

  globalThis.fetch = mockedFetch;

  return {
    fetchCalls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

describe("createGitHubClient", () => {
  test("returns an Octokit instance and sends the GitHub API version header", async () => {
    const client = createGitHubClient("ghs_dummy");
    const headers = await captureRequestHeaders(client);
    const apiVersionHeader = headers["x-github-api-version"];

    if (typeof apiVersionHeader !== "string") {
      throw new Error("Expected x-github-api-version header to be a string");
    }

    expect(client).toBeInstanceOf(Octokit);
    expect(apiVersionHeader).toBe(GITHUB_API_VERSION);
  });

  test("includes the package version in the user-agent header", async () => {
    const client = createGitHubClient("ghs_dummy");
    const headers = await captureRequestHeaders(client);
    const userAgentHeader = headers["user-agent"];

    if (typeof userAgentHeader !== "string") {
      throw new Error("Expected user-agent header to be a string");
    }

    expect(userAgentHeader).toMatch(
      new RegExp(`maestro/${packageJson.version.replaceAll(".", "\\.")}`),
    );
  });

  test("retries once on rate limit responses", async () => {
    const { logger, logLines } = createBufferedLogger();
    const mockedFetch = mockFetchSequence([
      {
        body: { message: "API rate limit exceeded" },
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) - 2),
        },
        status: 403,
      },
      {
        body: { ok: true },
        status: 200,
      },
    ]);

    try {
      const client = createGitHubClient("ghs_dummy", { logger });
      const response = await client.request("GET /rate-limit-test");

      expect(response.status).toBe(200);
      expect(mockedFetch.fetchCalls).toHaveLength(2);
      expect(logLines.join("\n")).toMatch(/rate limit/i);
    } finally {
      mockedFetch.restore();
    }
  });

  test("retries once on secondary rate limit responses", async () => {
    const { logger, logLines } = createBufferedLogger();
    const mockedFetch = mockFetchSequence([
      {
        body: { message: "You have exceeded a secondary rate limit" },
        headers: {
          "retry-after": "0.001",
        },
        status: 403,
      },
      {
        body: { ok: true },
        status: 200,
      },
    ]);

    try {
      const client = createGitHubClient("ghs_dummy", { logger });
      const response = await client.request("GET /secondary-rate-limit-test");

      expect(response.status).toBe(200);
      expect(mockedFetch.fetchCalls).toHaveLength(2);
      expect(logLines.join("\n")).toMatch(/secondary rate limit/i);
    } finally {
      mockedFetch.restore();
    }
  });

  test("throws when the token is missing", () => {
    expect(() => createGitHubClient("")).toThrow("GitHub authorization token is required");
  });
});
