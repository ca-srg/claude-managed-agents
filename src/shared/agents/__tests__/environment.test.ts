import { describe, expect, test } from "bun:test";
import type {
  BetaUnrestrictedNetwork,
  EnvironmentCreateParams,
  EnvironmentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/environments";
import type { RepoEnvironmentPackages } from "@/shared/persistence/schemas";
import type { AgentState } from "@/shared/types";
import {
  buildEnvironmentDefinition,
  buildRepoEnvironmentDefinition,
  buildRepoEnvironmentName,
  ensureEnvironment,
  ensureEnvironmentForRepo,
  hashEnvironmentDefinition,
  mergeWithBasePackages,
} from "../environment";

function assertEnvironmentCreateParams(
  definition: EnvironmentCreateParams,
): EnvironmentCreateParams {
  return definition;
}

function expectUnrestrictedNetwork<T extends BetaUnrestrictedNetwork>(_value: T): void {}

type DefinitionHasLegacyNetwork = "network" extends keyof ReturnType<
  typeof buildEnvironmentDefinition
>
  ? true
  : false;
type ConfigHasLegacyNetwork = "network" extends keyof NonNullable<
  ReturnType<typeof buildEnvironmentDefinition>["config"]
>
  ? true
  : false;
type UnrestrictedHasLegacyMode = "mode" extends keyof BetaUnrestrictedNetwork ? true : false;
type UnrestrictedHasAllowMcpServers = "allow_mcp_servers" extends keyof BetaUnrestrictedNetwork
  ? true
  : false;

function expectFalse<_Value extends false>(): void {}

function containsKey(value: unknown, searchedKey: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsKey(entry, searchedKey));
  }

  if (value && typeof value === "object") {
    const recordValue = value as Record<string, unknown>;

    return Object.entries(recordValue).some(
      ([entryKey, entryValue]) => entryKey === searchedKey || containsKey(entryValue, searchedKey),
    );
  }

  return false;
}

function createAgentState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    parentAgentId: "parent-agent",
    parentAgentVersion: 1,
    childAgentId: "child-agent",
    childAgentVersion: 2,
    environmentId: "env_cached",
    definitionHash: "cached-hash",
    createdAt: "2026-04-23T00:00:00.000Z",
    ...overrides,
  };
}

function createRepoPackages(
  overrides: Partial<RepoEnvironmentPackages> = {},
): RepoEnvironmentPackages {
  return {
    apt: [],
    cargo: [],
    gem: [],
    go: [],
    npm: [],
    pip: [],
    ...overrides,
  };
}

expectFalse<DefinitionHasLegacyNetwork>();
expectFalse<ConfigHasLegacyNetwork>();
expectFalse<UnrestrictedHasLegacyMode>();
expectFalse<UnrestrictedHasAllowMcpServers>();

describe("environment", () => {
  test("buildEnvironmentDefinition returns SDK-shaped cloud config", () => {
    const definition = assertEnvironmentCreateParams(
      buildEnvironmentDefinition({ name: "custom-environment" }),
    );

    expect(definition.name).toBe("custom-environment");

    if (!definition.config) {
      throw new Error("Expected config to be defined");
    }

    expect(definition.config.type).toBe("cloud");

    if (!definition.config.networking) {
      throw new Error("Expected networking to be defined");
    }

    if (definition.config.networking.type !== "unrestricted") {
      throw new Error("Expected unrestricted networking");
    }

    expectUnrestrictedNetwork(definition.config.networking);

    if (!definition.config.packages) {
      throw new Error("Expected packages to be defined");
    }

    expect(definition.config.packages).toEqual({
      type: "packages",
      npm: ["bun"],
      apt: ["git"],
    });
  });

  test("buildEnvironmentDefinition never emits legacy network fields", () => {
    const definition = buildEnvironmentDefinition();

    if (!definition.config) {
      throw new Error("Expected config to be defined");
    }

    if (!definition.config.networking) {
      throw new Error("Expected networking to be defined");
    }

    if (definition.config.networking.type !== "unrestricted") {
      throw new Error("Expected unrestricted networking");
    }

    expect(containsKey(definition, "network")).toBe(false);
    expect(containsKey(definition, "mode")).toBe(false);
    expect(containsKey(definition, "allow_mcp_servers")).toBe(false);
  });

  test("hashEnvironmentDefinition is stable for equivalent definitions", () => {
    const firstDefinition = buildEnvironmentDefinition({ name: "stable-environment" });
    const reorderedDefinition: EnvironmentCreateParams = {
      config: {
        packages: {
          apt: ["git"],
          npm: ["bun"],
          type: "packages",
        },
        networking: { type: "unrestricted" },
        type: "cloud",
      },
      name: "stable-environment",
    };

    const firstHash = hashEnvironmentDefinition(firstDefinition);
    const secondHash = hashEnvironmentDefinition(
      buildEnvironmentDefinition({ name: "stable-environment" }),
    );
    const reorderedHash = hashEnvironmentDefinition(reorderedDefinition);

    expect(firstHash).toBe(secondHash);
    expect(firstHash).toBe(reorderedHash);
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("ensureEnvironment reuses a cached environment when the hash matches", async () => {
    const definition = buildEnvironmentDefinition();
    const definitionHash = hashEnvironmentDefinition(definition);
    let createCalls = 0;
    const client = {
      beta: {
        environments: {
          create: async (_params: EnvironmentCreateParams) => {
            createCalls += 1;

            return { id: "env_created" };
          },
        },
      },
    };

    const ensureOutcome = await ensureEnvironment(
      client,
      createAgentState({
        definitionHash,
        environmentId: "env_cached_match",
      }),
    );

    expect(ensureOutcome).toEqual({
      environmentId: "env_cached_match",
      hash: definitionHash,
      created: false,
    });
    expect(createCalls).toBe(0);
  });

  test("ensureEnvironment creates a new environment when the cache is stale", async () => {
    const createCalls: EnvironmentCreateParams[] = [];
    const client = {
      beta: {
        environments: {
          create: async (params: EnvironmentCreateParams) => {
            createCalls.push(params);

            return { id: "env_new" };
          },
        },
      },
    };

    const ensureOutcome = await ensureEnvironment(
      client,
      createAgentState({
        definitionHash: "stale-hash",
        environmentId: "env_stale",
      }),
    );
    const expectedDefinition = buildEnvironmentDefinition();
    const expectedHash = hashEnvironmentDefinition(expectedDefinition);

    expect(ensureOutcome).toEqual({
      environmentId: "env_new",
      hash: expectedHash,
      created: true,
    });
    expect(createCalls.length).toBe(1);

    const firstCreateCall = createCalls[0];

    if (!firstCreateCall) {
      throw new Error("Expected create to be called once");
    }

    expect(firstCreateCall).toEqual({
      ...expectedDefinition,
      metadata: {
        definition_hash: expectedHash,
      },
    });
  });

  test("buildRepoEnvironmentName returns a deterministic valid name", () => {
    const environmentName = buildRepoEnvironmentName("octocat/Hello-World");

    expect(environmentName).toBe("gh-iea-octocat--Hello-World");
    expect(environmentName.startsWith("gh-iea-")).toBe(true);
    expect(environmentName).not.toContain("/");
    expect(environmentName).not.toContain(" ");
    expect(environmentName.length <= 120).toBe(true);
    expect(environmentName).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  test("buildRepoEnvironmentName truncates long names with collision-safe hash suffixes", () => {
    const firstRepo = `owner/${"a".repeat(133)}x`;
    const secondRepo = `owner/${"a".repeat(133)}y`;
    const firstName = buildRepoEnvironmentName(firstRepo);
    const secondName = buildRepoEnvironmentName(secondRepo);

    expect(firstName.length).toBe(120);
    expect(secondName.length).toBe(120);
    expect(firstName).toMatch(/^gh-iea-owner--/);
    expect(secondName).toMatch(/^gh-iea-owner--/);
    expect(firstName).toMatch(/-[a-f0-9]{8}$/);
    expect(secondName).toMatch(/-[a-f0-9]{8}$/);
    expect(firstName).not.toBe(secondName);
  });

  test("buildRepoEnvironmentName rejects repo slugs rejected by RepoSlugSchema", () => {
    expect(() => buildRepoEnvironmentName("octocat/some@weird repo")).toThrow();
  });

  test("mergeWithBasePackages adds base packages to empty apt and npm arrays", () => {
    expect(mergeWithBasePackages(createRepoPackages({ apt: [], npm: [] }))).toEqual({
      type: "packages",
      apt: ["git"],
      cargo: [],
      gem: [],
      go: [],
      npm: ["bun"],
      pip: [],
    });
  });

  test("mergeWithBasePackages prepends and dedupes apt and npm packages", () => {
    expect(
      mergeWithBasePackages(createRepoPackages({ apt: ["vim", "git"], npm: ["typescript"] })),
    ).toEqual({
      type: "packages",
      apt: ["git", "vim"],
      cargo: [],
      gem: [],
      go: [],
      npm: ["bun", "typescript"],
      pip: [],
    });
  });

  test("mergeWithBasePackages keeps non-base package managers as-is", () => {
    expect(
      mergeWithBasePackages(createRepoPackages({ go: ["github.com/foo/bar@latest"] })),
    ).toEqual({
      type: "packages",
      apt: ["git"],
      cargo: [],
      gem: [],
      go: ["github.com/foo/bar@latest"],
      npm: ["bun"],
      pip: [],
    });
  });

  test("buildRepoEnvironmentDefinition returns cloud config with repo name and merged packages", () => {
    const definition = buildRepoEnvironmentDefinition({
      packages: createRepoPackages({ apt: ["vim"], npm: ["typescript"], pip: ["pytest"] }),
      repo: "a/b",
    });

    expect(definition.name).toBe("gh-iea-a--b");
    expect(definition.config).toEqual({
      type: "cloud",
      networking: { type: "unrestricted" },
      packages: {
        type: "packages",
        apt: ["git", "vim"],
        cargo: [],
        gem: [],
        go: [],
        npm: ["bun", "typescript"],
        pip: ["pytest"],
      },
    });
  });

  test("hashEnvironmentDefinition is stable for repo definitions and changes with packages", () => {
    const firstDefinition = buildRepoEnvironmentDefinition({
      packages: createRepoPackages({ apt: ["vim"] }),
      repo: "octocat/Hello-World",
    });
    const secondDefinition = buildRepoEnvironmentDefinition({
      packages: createRepoPackages({ apt: ["vim"] }),
      repo: "octocat/Hello-World",
    });
    const changedDefinition = buildRepoEnvironmentDefinition({
      packages: createRepoPackages({ apt: ["curl"] }),
      repo: "octocat/Hello-World",
    });

    expect(hashEnvironmentDefinition(firstDefinition)).toBe(
      hashEnvironmentDefinition(secondDefinition),
    );
    expect(hashEnvironmentDefinition(firstDefinition)).not.toBe(
      hashEnvironmentDefinition(changedDefinition),
    );
  });

  test("ensureEnvironmentForRepo creates when no cached Anthropic state exists", async () => {
    const packages = createRepoPackages({ apt: ["vim"] });
    const createCalls: EnvironmentCreateParams[] = [];
    const updateCalls: Array<{ id: string; params: EnvironmentUpdateParams }> = [];
    const client = {
      beta: {
        environments: {
          create: async (params: EnvironmentCreateParams) => {
            createCalls.push(params);

            return { id: "env_repo_created" };
          },
          update: async (id: string, params: EnvironmentUpdateParams) => {
            updateCalls.push({ id, params });

            return { id };
          },
        },
      },
    };
    const expectedDefinition = buildRepoEnvironmentDefinition({
      packages,
      repo: "octocat/Hello-World",
    });
    const expectedHash = hashEnvironmentDefinition(expectedDefinition);

    const ensureOutcome = await ensureEnvironmentForRepo(client, {
      cached: null,
      packages,
      repo: "octocat/Hello-World",
    });

    expect(ensureOutcome).toEqual({
      environmentId: "env_repo_created",
      hash: expectedHash,
      created: true,
      updated: false,
    });
    expect(createCalls).toEqual([
      {
        ...expectedDefinition,
        metadata: {
          definition_hash: expectedHash,
        },
      },
    ]);
    expect(updateCalls).toEqual([]);
  });

  test("ensureEnvironmentForRepo reuses cached state when the hash matches", async () => {
    const packages = createRepoPackages({ apt: ["vim"] });
    const definition = buildRepoEnvironmentDefinition({ packages, repo: "octocat/Hello-World" });
    const definitionHash = hashEnvironmentDefinition(definition);
    let createCalls = 0;
    let updateCalls = 0;
    const client = {
      beta: {
        environments: {
          create: async (_params: EnvironmentCreateParams) => {
            createCalls += 1;

            return { id: "env_repo_created" };
          },
          update: async (id: string, _params: EnvironmentUpdateParams) => {
            updateCalls += 1;

            return { id };
          },
        },
      },
    };

    const ensureOutcome = await ensureEnvironmentForRepo(client, {
      cached: { definitionHash, environmentId: "env_repo_cached" },
      packages,
      repo: "octocat/Hello-World",
    });

    expect(ensureOutcome).toEqual({
      environmentId: "env_repo_cached",
      hash: definitionHash,
      created: false,
      updated: false,
    });
    expect(createCalls).toBe(0);
    expect(updateCalls).toBe(0);
  });

  test("ensureEnvironmentForRepo updates cached environments when the hash is stale", async () => {
    const packages = createRepoPackages({ apt: ["vim"] });
    const createCalls: EnvironmentCreateParams[] = [];
    const updateCalls: Array<{ id: string; params: EnvironmentUpdateParams }> = [];
    const client = {
      beta: {
        environments: {
          create: async (params: EnvironmentCreateParams) => {
            createCalls.push(params);

            return { id: "env_repo_created" };
          },
          update: async (id: string, params: EnvironmentUpdateParams) => {
            updateCalls.push({ id, params });

            return { id };
          },
        },
      },
    };
    const expectedDefinition = buildRepoEnvironmentDefinition({
      packages,
      repo: "octocat/Hello-World",
    });
    const expectedHash = hashEnvironmentDefinition(expectedDefinition);

    const ensureOutcome = await ensureEnvironmentForRepo(client, {
      cached: { definitionHash: "stale-hash", environmentId: "env_repo_stale" },
      packages,
      repo: "octocat/Hello-World",
    });

    expect(ensureOutcome).toEqual({
      environmentId: "env_repo_stale",
      hash: expectedHash,
      created: false,
      updated: true,
    });
    expect(createCalls).toEqual([]);
    expect(updateCalls).toEqual([
      {
        id: "env_repo_stale",
        params: {
          config: expectedDefinition.config,
          metadata: {
            definition_hash: expectedHash,
          },
        },
      },
    ]);
    expect("name" in (updateCalls[0]?.params ?? {})).toBe(false);
  });

  test("repo environment package-only differences produce different hashes", () => {
    const vimDefinition = buildRepoEnvironmentDefinition({
      packages: createRepoPackages({ apt: ["vim"] }),
      repo: "octocat/Hello-World",
    });
    const curlDefinition = buildRepoEnvironmentDefinition({
      packages: createRepoPackages({ apt: ["curl"] }),
      repo: "octocat/Hello-World",
    });

    expect(hashEnvironmentDefinition(vimDefinition)).not.toBe(
      hashEnvironmentDefinition(curlDefinition),
    );
  });

  test("base packages only appear after merge and are not added to user packages", () => {
    const userPackages = createRepoPackages({ apt: ["vim"], npm: ["typescript"] });
    const definition = buildRepoEnvironmentDefinition({
      packages: userPackages,
      repo: "octocat/Hello-World",
    });

    expect(userPackages.apt).toEqual(["vim"]);
    expect(userPackages.npm).toEqual(["typescript"]);
    expect(definition.config?.packages).toEqual({
      type: "packages",
      apt: ["git", "vim"],
      cargo: [],
      gem: [],
      go: [],
      npm: ["bun", "typescript"],
      pip: [],
    });
  });
});
