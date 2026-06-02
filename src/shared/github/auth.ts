import { createAppAuth, type InstallationAccessTokenAuthentication } from "@octokit/auth-app";
import { Octokit } from "octokit";
import type { Logger } from "pino";

import { GITHUB_API_VERSION } from "@/shared/constants";
import { createGitHubClient } from "./octokit";

export type GitHubAuthMode = "app";

export type GitHubAppAuthConfig = {
  appId: number;
  installationId?: number;
  mode: "app";
  privateKey: string;
};

export type GitHubAuthConfig = GitHubAppAuthConfig;

export type GitHubRepositoryAuthorization = {
  authMode: GitHubAuthMode;
  authorizationToken: string;
  expiresAt?: Date;
  installationId?: number;
  permissions?: Record<string, string>;
  repositorySelection?: string;
};

export type GitHubRepositoryAccess = GitHubRepositoryAuthorization & {
  octokit: Octokit;
};

export type GitHubAuthProvider = {
  resolveRepositoryAccess(owner: string, repo: string): Promise<GitHubRepositoryAccess>;
  resolveRepositoriesAccess?(
    repositories: Array<{ owner: string; repo: string }>,
  ): Promise<GitHubRepositoryAccess>;
  refreshRepositoryAccess?(owner: string, repo: string): Promise<GitHubRepositoryAccess>;
  refreshRepositoriesAccess?(
    repositories: Array<{ owner: string; repo: string }>,
  ): Promise<GitHubRepositoryAccess>;
};

type CreateGitHubAuthProviderOptions = {
  logger?: Logger;
};

type CachedInstallationToken = {
  auth: InstallationAccessTokenAuthentication;
  octokit: Octokit;
};

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

function parseExpiresAt(value: string): Date | undefined {
  const expiresAt = new Date(value);
  return Number.isNaN(expiresAt.getTime()) ? undefined : expiresAt;
}

function isFresh(auth: InstallationAccessTokenAuthentication): boolean {
  const expiresAt = parseExpiresAt(auth.expiresAt);
  if (!expiresAt) {
    return false;
  }

  return expiresAt.getTime() - Date.now() > TOKEN_REFRESH_SKEW_MS;
}

function tokenCacheKey(installationId: number, repo: string): string {
  return `${installationId}:${repo.toLowerCase()}`;
}

function multiRepositoryTokenCacheKey(
  installationId: number,
  repositories: Array<{ owner: string; repo: string }>,
): string {
  const repoKey = repositories
    .map((repository) => `${repository.owner}/${repository.repo}`.toLowerCase())
    .sort()
    .join(",");
  return `${installationId}:multi:${repoKey}`;
}

function toRepositoryAccess(
  auth: InstallationAccessTokenAuthentication,
  octokit: Octokit,
): GitHubRepositoryAccess {
  const expiresAt = parseExpiresAt(auth.expiresAt);
  return {
    authMode: "app",
    authorizationToken: auth.token,
    ...(expiresAt ? { expiresAt } : {}),
    installationId: auth.installationId,
    octokit,
    permissions: auth.permissions,
    repositorySelection: auth.repositorySelection,
  };
}

class AppGitHubAuthProvider implements GitHubAuthProvider {
  private readonly appOctokit: Octokit;
  private readonly cache = new Map<string, CachedInstallationToken>();

  constructor(
    private readonly config: GitHubAppAuthConfig,
    private readonly opts: CreateGitHubAuthProviderOptions,
  ) {
    this.appOctokit = new Octokit({
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
      },
      authStrategy: createAppAuth,
      request: {
        headers: {
          "x-github-api-version": GITHUB_API_VERSION,
        },
      },
    });
  }

  async resolveRepositoryAccess(owner: string, repo: string): Promise<GitHubRepositoryAccess> {
    return this.resolveRepositoryAccessInternal(owner, repo, false);
  }

  async refreshRepositoryAccess(owner: string, repo: string): Promise<GitHubRepositoryAccess> {
    return this.resolveRepositoryAccessInternal(owner, repo, true);
  }

  async resolveRepositoriesAccess(
    repositories: Array<{ owner: string; repo: string }>,
  ): Promise<GitHubRepositoryAccess> {
    return this.resolveRepositoriesAccessInternal(repositories, false);
  }

  async refreshRepositoriesAccess(
    repositories: Array<{ owner: string; repo: string }>,
  ): Promise<GitHubRepositoryAccess> {
    return this.resolveRepositoriesAccessInternal(repositories, true);
  }

  private async resolveRepositoryAccessInternal(
    owner: string,
    repo: string,
    refresh: boolean,
  ): Promise<GitHubRepositoryAccess> {
    const installationId =
      this.config.installationId ?? (await this.resolveInstallationId(owner, repo));
    const cacheKey = tokenCacheKey(installationId, `${owner}/${repo}`);
    const cached = this.cache.get(cacheKey);
    if (!refresh && cached && isFresh(cached.auth)) {
      return toRepositoryAccess(cached.auth, cached.octokit);
    }

    const auth = createAppAuth({
      appId: this.config.appId,
      installationId,
      privateKey: this.config.privateKey,
    });
    const installationAuth = await auth({
      installationId,
      repositoryNames: [repo],
      refresh,
      type: "installation",
    });
    const octokit = createGitHubClient(installationAuth.token, { logger: this.opts.logger });
    this.cache.set(cacheKey, { auth: installationAuth, octokit });
    return toRepositoryAccess(installationAuth, octokit);
  }

  private async resolveRepositoriesAccessInternal(
    repositories: Array<{ owner: string; repo: string }>,
    refresh: boolean,
  ): Promise<GitHubRepositoryAccess> {
    if (repositories.length === 0) {
      throw new Error("At least one GitHub repository is required");
    }

    const uniqueRepositories = Array.from(
      new Map(
        repositories.map((repository) => [
          `${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}`,
          repository,
        ]),
      ).values(),
    );
    const installationIds = await Promise.all(
      uniqueRepositories.map(
        (repository) =>
          this.config.installationId ??
          this.resolveInstallationId(repository.owner, repository.repo),
      ),
    );
    const installationId = installationIds[0];
    if (installationId === undefined) {
      throw new Error("GitHub App installation could not be resolved");
    }
    if (installationIds.some((candidate) => candidate !== installationId)) {
      throw new Error(
        "Registered repositories span multiple GitHub App installations; multi-repository runs require one installation",
      );
    }

    const cacheKey = multiRepositoryTokenCacheKey(installationId, uniqueRepositories);
    const cached = this.cache.get(cacheKey);
    if (!refresh && cached && isFresh(cached.auth)) {
      return toRepositoryAccess(cached.auth, cached.octokit);
    }

    const auth = createAppAuth({
      appId: this.config.appId,
      installationId,
      privateKey: this.config.privateKey,
    });
    const installationAuth = await auth({
      installationId,
      repositoryNames: uniqueRepositories.map((repository) => repository.repo),
      refresh,
      type: "installation",
    });
    const octokit = createGitHubClient(installationAuth.token, { logger: this.opts.logger });
    this.cache.set(cacheKey, { auth: installationAuth, octokit });
    return toRepositoryAccess(installationAuth, octokit);
  }

  private async resolveInstallationId(owner: string, repo: string): Promise<number> {
    const response = await this.appOctokit.request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo,
    });
    const data = response.data as { id?: number };
    if (typeof data.id !== "number") {
      throw new Error(`GitHub App installation for ${owner}/${repo} did not include an id`);
    }

    return data.id;
  }
}

export function createGitHubAuthProvider(
  config: GitHubAuthConfig,
  opts: CreateGitHubAuthProviderOptions = {},
): GitHubAuthProvider {
  return new AppGitHubAuthProvider(config, opts);
}
