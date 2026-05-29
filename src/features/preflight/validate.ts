import type { GitHubRepositoryAuthorization } from "@/shared/github/auth";
import { readIssue } from "@/shared/github/issues";

type HeadersRecord = Record<string, string | number | undefined>;

type GitHubApiResponse<TData = unknown> = {
  data: TData;
  headers?: HeadersRecord;
  status?: number;
};

type GitHubPreflightClient = {
  paginate: (route: string, parameters?: Record<string, unknown>) => Promise<unknown[]>;
  request: (
    route: string,
    parameters?: Record<string, unknown>,
  ) => Promise<GitHubApiResponse<unknown>>;
};

type AnthropicPreflightClient = {
  beta?: {
    agents?: {
      list: (parameters: { limit: number }) => Promise<unknown>;
    };
  };
};

type GitHubRepoRecord = {
  default_branch: string;
  permissions?: Record<string, unknown>;
};

export type PreflightResult = {
  anthropic: {
    checked: boolean;
  };
  github: {
    defaultBranch: string;
    permissions: Record<string, unknown>;
  };
};

export type GitHubPreflightAuth = Pick<
  GitHubRepositoryAuthorization,
  "authMode" | "installationId" | "permissions" | "repositorySelection"
>;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class InvalidGitHubCredentialError extends AuthError {
  constructor() {
    super(
      "GitHub credential is invalid or expired.\nAction to fix: configure a valid GitHub App installation with contents: write, issues: write, and pull_requests: write access.",
    );
    this.name = "InvalidGitHubCredentialError";
  }
}

export class RepoNotFoundError extends Error {
  constructor(owner: string, repo: string) {
    super(
      `Repository ${owner}/${repo} was not found or is not accessible with the current GitHub credential.\nAction to fix: confirm --repo is correct and that the configured GitHub App installation can access this repository.`,
    );
    this.name = "RepoNotFoundError";
  }
}

export class ParentIssueClosedError extends Error {
  constructor(issueNumber: number) {
    super(
      `Parent issue #${issueNumber} is closed.\nAction to fix: reopen the parent issue or choose an open issue number.`,
    );
    this.name = "ParentIssueClosedError";
  }
}

export class InsufficientScopesError extends AuthError {
  readonly missingScopes: string[];

  constructor(missingScopes: string[]) {
    super(
      `GitHub App installation is missing required permissions: ${missingScopes.join(", ")}.\nAction to fix: grant contents: write, issues: write, and pull_requests: write to the configured GitHub App.`,
    );
    this.missingScopes = missingScopes;
    this.name = "InsufficientScopesError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const statusValue = error.status;
  return typeof statusValue === "number" ? statusValue : undefined;
}

function assertRepoRecord(value: unknown): GitHubRepoRecord {
  if (!isRecord(value) || typeof value.default_branch !== "string") {
    throw new Error(
      "Invalid GitHub repository payload.\nAction to fix: retry after confirming the repository is accessible.",
    );
  }

  return {
    default_branch: value.default_branch,
    permissions: isRecord(value.permissions) ? value.permissions : undefined,
  };
}

function hasWritePermission(permissionValue: string | undefined): boolean {
  return ["write", "maintain", "admin"].includes(permissionValue ?? "");
}

function hasBooleanFlag(record: Record<string, unknown> | undefined, key: string): boolean {
  return record?.[key] === true;
}

function collectMissingScopes(observedPermissions: {
  appPermissions?: Record<string, string>;
  repositoryPermissions?: Record<string, unknown>;
}): string[] {
  const appPermissions = observedPermissions.appPermissions ?? {};
  const repositoryPermissions = observedPermissions.repositoryPermissions;

  const canWriteRepositoryContents =
    hasWritePermission(appPermissions.contents) || hasBooleanFlag(repositoryPermissions, "push");

  const canWriteIssues =
    hasWritePermission(appPermissions.issues) || hasBooleanFlag(repositoryPermissions, "push");

  const canWritePullRequests =
    hasWritePermission(appPermissions.pull_requests) ||
    hasBooleanFlag(repositoryPermissions, "push");

  return [
    ...(canWriteRepositoryContents ? [] : ["contents: write"]),
    ...(canWriteIssues ? [] : ["issues: write"]),
    ...(canWritePullRequests ? [] : ["pull_requests: write"]),
  ];
}

function mapReadIssueError(error: unknown, issueNumber: number): never {
  if (extractStatus(error) === 401) {
    throw new InvalidGitHubCredentialError();
  }

  if (error instanceof Error && error.message.includes("closed")) {
    throw new ParentIssueClosedError(issueNumber);
  }

  if (error instanceof Error && error.message.includes("pull request")) {
    throw new Error(
      `Issue #${issueNumber} points to a pull request instead of a parent issue.\nAction to fix: pass an issue number, not a pull request number.`,
    );
  }

  throw error;
}

export async function validateGitHubAccess(
  octokit: GitHubPreflightClient,
  owner: string,
  repo: string,
  issueN: number | undefined,
  auth: GitHubPreflightAuth,
): Promise<{ defaultBranch: string; permissions: Record<string, unknown> }> {
  let repoResponse: GitHubApiResponse<unknown>;
  try {
    repoResponse = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
  } catch (error) {
    if (extractStatus(error) === 401) {
      throw new InvalidGitHubCredentialError();
    }

    if (extractStatus(error) === 404) {
      throw new RepoNotFoundError(owner, repo);
    }

    throw error;
  }

  if (issueN !== undefined) {
    try {
      await readIssue(octokit, owner, repo, issueN);
    } catch (error) {
      mapReadIssueError(error, issueN);
    }
  }

  const repoRecord = assertRepoRecord(repoResponse.data);

  const observedPermissions = {
    appInstallationId: auth.installationId,
    appPermissions: auth.permissions,
    appRepositorySelection: auth.repositorySelection,
    authMode: auth.authMode,
    repositoryPermissions: repoRecord.permissions,
  } satisfies Record<string, unknown>;

  const missingScopes = collectMissingScopes({
    appPermissions: auth.permissions,
    repositoryPermissions: repoRecord.permissions,
  });

  if (missingScopes.length > 0) {
    throw new InsufficientScopesError(missingScopes);
  }

  return {
    defaultBranch: repoRecord.default_branch,
    permissions: observedPermissions,
  };
}

export async function validateAnthropicAccess(client: AnthropicPreflightClient): Promise<void> {
  const agentsApi = client.beta?.agents;
  if (!agentsApi) {
    throw new AuthError(
      "Anthropic client is unavailable.\nAction to fix: pass an initialized Anthropic client or set skipAnthropicCheck for dry-run mode.",
    );
  }

  try {
    await agentsApi.list({ limit: 1 });
  } catch (error) {
    if (extractStatus(error) === 401) {
      throw new AuthError(
        "Anthropic authentication is invalid or expired.\nAction to fix: set ANTHROPIC_API_KEY to a valid API key and retry.",
      );
    }

    throw error;
  }
}

export async function runPreflight(deps: {
  octokit: GitHubPreflightClient;
  anthropicClient?: AnthropicPreflightClient;
  githubAuth: GitHubPreflightAuth;
  owner: string;
  repo: string;
  issueN?: number;
  skipAnthropicCheck?: boolean;
}): Promise<PreflightResult> {
  const githubAccess = await validateGitHubAccess(
    deps.octokit,
    deps.owner,
    deps.repo,
    deps.issueN,
    deps.githubAuth,
  );

  if (deps.skipAnthropicCheck) {
    return {
      anthropic: {
        checked: false,
      },
      github: githubAccess,
    };
  }

  if (!deps.anthropicClient) {
    throw new AuthError(
      "Anthropic client is required when skipAnthropicCheck is false.\nAction to fix: pass an initialized Anthropic client or enable skipAnthropicCheck for dry-run mode.",
    );
  }

  await validateAnthropicAccess(deps.anthropicClient);

  return {
    anthropic: {
      checked: true,
    },
    github: githubAccess,
  };
}
