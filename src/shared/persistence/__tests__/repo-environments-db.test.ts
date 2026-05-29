import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDbModule } from "@/shared/persistence/db";
import type { RepoEnvironmentPackages } from "@/shared/persistence/schemas";

const REPO_A = "octocat/spoon-knife";
const REPO_B = "octocat/hello-world";
const EMPTY_PACKAGES: RepoEnvironmentPackages = {
  apt: [],
  cargo: [],
  gem: [],
  go: [],
  npm: [],
  pip: [],
};
const PACKAGES_A = packageSet({ npm: ["typescript"], pip: ["pytest"] });
const PACKAGES_B = packageSet({ apt: ["curl"], cargo: ["ripgrep"] });

type DbModule = ReturnType<typeof createDbModule>;

function packageSet(overrides: Partial<RepoEnvironmentPackages> = {}): RepoEnvironmentPackages {
  return {
    ...EMPTY_PACKAGES,
    ...overrides,
  };
}

describe("repo environment repository DB functions", () => {
  let dbModule: DbModule;

  beforeEach(() => {
    dbModule = createDbModule(":memory:");
    dbModule.initDb();
  });

  afterEach(() => {
    dbModule.close();
  });

  test("getRepoEnvironment returns null when nothing configured", () => {
    expect(dbModule.getRepoEnvironment(REPO_A)).toBeNull();
    expect(dbModule.getRepoEnvironmentRevisions(REPO_A)).toEqual([]);
  });

  test("saveRepoEnvironmentRevision creates a new override with null Anthropic state", () => {
    const result = dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_A,
      source: "edit",
    });

    expect(result.isNoChange).toBe(false);
    expect(result.revisionId > 0).toBe(true);

    const stored = dbModule.getRepoEnvironment(REPO_A);
    expect(stored).toMatchObject({
      currentRevisionId: result.revisionId,
      definitionHash: null,
      environmentId: null,
      packages: PACKAGES_A,
      repo: REPO_A,
    });
    expect(dbModule.getRepoEnvironmentRevision(REPO_A, result.revisionId)?.packages).toEqual(
      PACKAGES_A,
    );
    expect(dbModule.getRepoEnvironmentRevisions(REPO_A)).toHaveLength(1);
    expect(dbModule.getRepoEnvironmentRevisions(REPO_A)[0]?.source).toBe("edit");
  });

  test("saveRepoEnvironmentRevision is keyed by repo and does not bleed across repos", () => {
    dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_B,
      repo: REPO_B,
      source: "edit",
    });

    expect(dbModule.getRepoEnvironment(REPO_A)?.packages).toEqual(PACKAGES_A);
    expect(dbModule.getRepoEnvironment(REPO_B)?.packages).toEqual(PACKAGES_B);
  });

  test("saving identical packages returns isNoChange without creating a new revision", () => {
    const first = dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_A,
      source: "edit",
    });
    const second = dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_A,
      source: "edit",
    });

    expect(second).toEqual({ isNoChange: true, revisionId: first.revisionId });
    expect(dbModule.getRepoEnvironmentRevisions(REPO_A)).toHaveLength(1);
  });

  test("different array ordering is treated as identical content", () => {
    const first = dbModule.saveRepoEnvironmentRevision({
      packages: packageSet({ npm: ["zod", "typescript"] }),
      repo: REPO_A,
      source: "edit",
    });
    const second = dbModule.saveRepoEnvironmentRevision({
      packages: packageSet({ npm: ["typescript", "zod"] }),
      repo: REPO_A,
      source: "edit",
    });

    expect(second).toEqual({ isNoChange: true, revisionId: first.revisionId });
    expect(dbModule.getRepoEnvironment(REPO_A)?.packages).toEqual(
      packageSet({ npm: ["typescript", "zod"] }),
    );
    expect(dbModule.getRepoEnvironmentRevisions(REPO_A)).toHaveLength(1);
  });

  test("restoreRepoEnvironmentToRevision appends a new revision with source 'restore'", () => {
    const first = dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_B,
      repo: REPO_A,
      source: "edit",
    });

    const restored = dbModule.restoreRepoEnvironmentToRevision(REPO_A, first.revisionId);

    expect(restored.alreadyCurrent).toBe(false);
    expect(restored.newRevisionId > first.revisionId).toBe(true);
    expect(dbModule.getRepoEnvironment(REPO_A)?.packages).toEqual(PACKAGES_A);
    expect(dbModule.getRepoEnvironmentRevisions(REPO_A)[0]).toMatchObject({
      id: restored.newRevisionId,
      packages: PACKAGES_A,
      source: "restore",
    });
    expect(dbModule.getRepoEnvironmentRevisions(REPO_A)).toHaveLength(3);
  });

  test("restoring an unknown revision throws", () => {
    dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_A,
      source: "edit",
    });

    expect(() => dbModule.restoreRepoEnvironmentToRevision(REPO_A, 9999)).toThrow();
  });

  test("restoring a revision belonging to a different repo throws", () => {
    const repoBSaved = dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_B,
      repo: REPO_B,
      source: "edit",
    });
    dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_A,
      source: "edit",
    });

    expect(() =>
      dbModule.restoreRepoEnvironmentToRevision(REPO_A, repoBSaved.revisionId),
    ).toThrow();
  });

  test("deleteRepoEnvironment removes the override and all of its revisions", () => {
    dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_B,
      repo: REPO_A,
      source: "edit",
    });

    const result = dbModule.deleteRepoEnvironment(REPO_A);
    expect(result).toEqual({ deleted: true });
    expect(dbModule.getRepoEnvironment(REPO_A)).toBeNull();
    expect(dbModule.getRepoEnvironmentRevisions(REPO_A)).toEqual([]);

    const noop = dbModule.deleteRepoEnvironment(REPO_A);
    expect(noop).toEqual({ deleted: false });
  });

  test("listRepoEnvironmentOverrides returns one entry per repo with revision counts", () => {
    dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_B,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_B,
      source: "edit",
    });

    const all = dbModule.listRepoEnvironmentOverrides();
    expect(all).toHaveLength(2);
    const repoA = all.find((row) => row.repo === REPO_A);
    expect(repoA?.revisionCount).toBe(2);

    const onlyRepoA = dbModule.listRepoEnvironmentOverrides({ repo: REPO_A });
    expect(onlyRepoA).toHaveLength(1);
    expect(onlyRepoA[0]?.repo).toBe(REPO_A);
  });

  test("invalid packages are rejected", () => {
    expect(() =>
      dbModule.saveRepoEnvironmentRevision({
        packages: packageSet({ npm: ["bad package"] }),
        repo: REPO_A,
        source: "edit",
      }),
    ).toThrow();
    expect(() =>
      dbModule.saveRepoEnvironmentRevision({
        packages: packageSet({ pip: Array.from({ length: 201 }, (_, index) => `pkg${index}`) }),
        repo: REPO_A,
        source: "edit",
      }),
    ).toThrow();
    expect(() =>
      dbModule.saveRepoEnvironmentRevision({
        packages: { ...EMPTY_PACKAGES, brew: ["wget"] } as Partial<RepoEnvironmentPackages>,
        repo: REPO_A,
        source: "edit",
      }),
    ).toThrow();
  });

  test("repo slug must match owner/name", () => {
    expect(() =>
      dbModule.saveRepoEnvironmentRevision({
        packages: PACKAGES_A,
        repo: "not-a-slug",
        source: "edit",
      }),
    ).toThrow();
  });

  test("setRepoEnvironmentAnthropicState updates state without changing current revision", () => {
    const saved = dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_A,
      source: "edit",
    });

    dbModule.setRepoEnvironmentAnthropicState(REPO_A, {
      definitionHash: "definition-hash-a",
      environmentId: "env-a",
    });

    expect(dbModule.getRepoEnvironment(REPO_A)).toMatchObject({
      currentRevisionId: saved.revisionId,
      definitionHash: "definition-hash-a",
      environmentId: "env-a",
    });
  });

  test("setRepoEnvironmentAnthropicState throws when no row exists", () => {
    expect(() =>
      dbModule.setRepoEnvironmentAnthropicState(REPO_A, {
        definitionHash: "definition-hash-a",
        environmentId: "env-a",
      }),
    ).toThrow();
  });

  test("saveRepoEnvironmentRevision preserves existing Anthropic state", () => {
    dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.setRepoEnvironmentAnthropicState(REPO_A, {
      definitionHash: "definition-hash-a",
      environmentId: "env-a",
    });
    const saved = dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_B,
      repo: REPO_A,
      source: "edit",
    });

    expect(dbModule.getRepoEnvironment(REPO_A)).toMatchObject({
      currentRevisionId: saved.revisionId,
      definitionHash: "definition-hash-a",
      environmentId: "env-a",
      packages: PACKAGES_B,
    });
  });

  test("restoreRepoEnvironmentToRevision preserves existing Anthropic state", () => {
    const first = dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_A,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.saveRepoEnvironmentRevision({
      packages: PACKAGES_B,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.setRepoEnvironmentAnthropicState(REPO_A, {
      definitionHash: "definition-hash-a",
      environmentId: "env-a",
    });

    dbModule.restoreRepoEnvironmentToRevision(REPO_A, first.revisionId);

    expect(dbModule.getRepoEnvironment(REPO_A)).toMatchObject({
      definitionHash: "definition-hash-a",
      environmentId: "env-a",
      packages: PACKAGES_A,
    });
  });
});
