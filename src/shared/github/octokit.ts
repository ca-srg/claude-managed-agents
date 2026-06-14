import { readFileSync } from "node:fs";

import type { EndpointDefaults } from "@octokit/types";
import { Octokit } from "octokit";
import type { Logger } from "pino";

import { GITHUB_API_VERSION } from "@/shared/constants";

type CreateGitHubClientOptions = {
  logger?: Logger;
};

type PackageManifest = {
  version: string;
};

const packageManifest = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as PackageManifest;
const userAgent = `maestro/${packageManifest.version}`;

function createThrottleHandler(limitName: string, logger?: Logger) {
  return (
    retryAfter: number,
    requestOptions: Required<EndpointDefaults>,
    _octokit: Octokit,
    retryCount: number,
  ): boolean => {
    logger?.warn(
      `${limitName} for ${requestOptions.method} ${requestOptions.url}; retryAfter=${retryAfter}; retryCount=${retryCount}`,
    );

    return retryCount === 0;
  };
}

export function createGitHubClient(token: string, opts: CreateGitHubClientOptions = {}): Octokit {
  if (!token?.trim()) {
    throw new Error("GitHub authorization token is required");
  }

  const octokit = new Octokit({
    auth: token,
    request: {
      headers: {
        "x-github-api-version": GITHUB_API_VERSION,
      },
    },
    throttle: {
      onRateLimit: createThrottleHandler("GitHub rate limit detected", opts.logger),
      onSecondaryRateLimit: createThrottleHandler(
        "GitHub secondary rate limit detected",
        opts.logger,
      ),
    },
    userAgent,
  });

  octokit.request.endpoint.DEFAULTS.headers["x-github-api-version"] = GITHUB_API_VERSION;

  return octokit;
}
