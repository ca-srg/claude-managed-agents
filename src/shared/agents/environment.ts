import { createHash } from "node:crypto";

import type {
  BetaPackagesParams,
  BetaUnrestrictedNetwork,
  EnvironmentCreateParams,
  EnvironmentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/environments";

import { type RepoEnvironmentPackages, RepoSlugSchema } from "@/shared/persistence/schemas";
import type { DefaultEnvironmentState } from "@/shared/types";

const DEFAULT_ENVIRONMENT_NAME = "maestro-env";
const BASE_PACKAGES = {
  apt: ["git"] as const,
  npm: ["bun"] as const,
} as const;
const REPO_ENV_NAME_PREFIX = "maestro-";
const REPO_ENV_NAME_MAX_LEN = 120;

type EnvironmentCacheState =
  | Pick<DefaultEnvironmentState, "definitionHash" | "environmentId">
  | null
  | undefined;

type EnvironmentClient = {
  beta: {
    environments: {
      create: (params: EnvironmentCreateParams) => Promise<{ id: string }>;
    };
  };
};

type EnsureEnvironmentResult = {
  environmentId: string;
  hash: string;
  created: boolean;
};

type RepoEnvironmentClient = {
  beta: {
    environments: {
      create: (params: EnvironmentCreateParams) => Promise<{ id: string }>;
      update: (id: string, params: EnvironmentUpdateParams) => Promise<{ id: string }>;
    };
  };
};

type EnsureRepoEnvironmentInput = {
  cached: { definitionHash: string | null; environmentId: string | null } | null;
  packages: RepoEnvironmentPackages;
  repo: string;
};

type EnsureRepoEnvironmentResult = {
  environmentId: string;
  hash: string;
  created: boolean;
  updated: boolean;
};

function canonicalizeJson(jsonNode: unknown): unknown {
  if (Array.isArray(jsonNode)) {
    return jsonNode.map((arrayEntry) => canonicalizeJson(arrayEntry));
  }

  if (jsonNode && typeof jsonNode === "object") {
    const recordNode = jsonNode as Record<string, unknown>;
    const sortedEntries = Object.keys(recordNode)
      .sort()
      .map((entryKey) => [entryKey, canonicalizeJson(recordNode[entryKey])] as const);

    return Object.fromEntries(sortedEntries);
  }

  return jsonNode;
}

export function buildEnvironmentDefinition(opts?: { name?: string }): EnvironmentCreateParams {
  return {
    name: opts?.name ?? DEFAULT_ENVIRONMENT_NAME,
    config: {
      type: "cloud",
      networking: { type: "unrestricted" } as BetaUnrestrictedNetwork,
      packages: {
        type: "packages",
        npm: ["bun"],
        apt: ["git"],
      },
    },
  };
}

function sanitizeRepoEnvironmentNamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

function dedupePackageList(packages: readonly string[]): string[] {
  return [...new Set(packages)];
}

export function buildRepoEnvironmentName(repo: string): string {
  const parsedRepo = RepoSlugSchema.parse(repo);
  const [owner, name] = parsedRepo.split("/");

  if (!owner || !name) {
    throw new Error("repo must match owner/name");
  }

  const body = `${sanitizeRepoEnvironmentNamePart(owner)}--${sanitizeRepoEnvironmentNamePart(name)}`;
  const environmentName = `${REPO_ENV_NAME_PREFIX}${body}`;

  if (environmentName.length <= REPO_ENV_NAME_MAX_LEN) {
    return environmentName;
  }

  const hashSuffix = createHash("sha256").update(parsedRepo).digest("hex").slice(0, 8);
  const suffix = `-${hashSuffix}`;
  const maxBodyLength = REPO_ENV_NAME_MAX_LEN - REPO_ENV_NAME_PREFIX.length - suffix.length;

  return `${REPO_ENV_NAME_PREFIX}${body.slice(0, maxBodyLength)}${suffix}`;
}

export function mergeWithBasePackages(user: RepoEnvironmentPackages): BetaPackagesParams {
  return {
    type: "packages",
    apt: dedupePackageList([...BASE_PACKAGES.apt, ...(user.apt ?? [])]),
    cargo: user.cargo ?? [],
    gem: user.gem ?? [],
    go: user.go ?? [],
    npm: dedupePackageList([...BASE_PACKAGES.npm, ...(user.npm ?? [])]),
    pip: user.pip ?? [],
  };
}

export function buildRepoEnvironmentDefinition(input: {
  packages: RepoEnvironmentPackages;
  repo: string;
}): EnvironmentCreateParams {
  return {
    name: buildRepoEnvironmentName(input.repo),
    config: {
      type: "cloud",
      networking: { type: "unrestricted" } as BetaUnrestrictedNetwork,
      packages: mergeWithBasePackages(input.packages),
    },
  };
}

export function hashEnvironmentDefinition(definition: EnvironmentCreateParams): string {
  const canonicalDefinition = canonicalizeJson(definition);

  return createHash("sha256").update(JSON.stringify(canonicalDefinition)).digest("hex");
}

export async function ensureEnvironment(
  client: EnvironmentClient,
  state: EnvironmentCacheState,
): Promise<EnsureEnvironmentResult> {
  const definition = buildEnvironmentDefinition();
  const definitionHash = hashEnvironmentDefinition(definition);

  if (state?.environmentId && state.definitionHash === definitionHash) {
    return {
      environmentId: state.environmentId,
      hash: definitionHash,
      created: false,
    };
  }

  const createdEnvironment = await client.beta.environments.create({
    ...definition,
    metadata: {
      definition_hash: definitionHash,
    },
  });

  return {
    environmentId: createdEnvironment.id,
    hash: definitionHash,
    created: true,
  };
}

export async function ensureEnvironmentForRepo(
  client: RepoEnvironmentClient,
  input: EnsureRepoEnvironmentInput,
): Promise<EnsureRepoEnvironmentResult> {
  const definition = buildRepoEnvironmentDefinition({
    packages: input.packages,
    repo: input.repo,
  });
  const definitionHash = hashEnvironmentDefinition(definition);

  if (input.cached?.environmentId && input.cached.definitionHash === definitionHash) {
    return {
      environmentId: input.cached.environmentId,
      hash: definitionHash,
      created: false,
      updated: false,
    };
  }

  if (input.cached?.environmentId) {
    await client.beta.environments.update(input.cached.environmentId, {
      config: definition.config,
      metadata: {
        definition_hash: definitionHash,
      },
    });

    return {
      environmentId: input.cached.environmentId,
      hash: definitionHash,
      created: false,
      updated: true,
    };
  }

  const createdEnvironment = await client.beta.environments.create({
    ...definition,
    metadata: {
      definition_hash: definitionHash,
    },
  });

  return {
    environmentId: createdEnvironment.id,
    hash: definitionHash,
    created: true,
    updated: false,
  };
}
