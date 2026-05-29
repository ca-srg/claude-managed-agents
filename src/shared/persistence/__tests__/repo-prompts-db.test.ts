import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDbModule } from "@/shared/persistence/db";
import type { RepoPromptAgent } from "@/shared/persistence/schemas";

const REPO_A = "octocat/spoon-knife";
const REPO_B = "octocat/hello-world";
const PARENT: RepoPromptAgent = "parent";
const CHILD: RepoPromptAgent = "child";
const BODY_A = "Repo A parent prompt revision A".padEnd(20, " ");
const BODY_B = "Repo A parent prompt revision B".padEnd(20, " ");

type DbModule = ReturnType<typeof createDbModule>;

describe("repo prompt repository DB functions", () => {
  let dbModule: DbModule;

  beforeEach(() => {
    dbModule = createDbModule(":memory:");
    dbModule.initDb();
  });

  afterEach(() => {
    dbModule.close();
  });

  test("getRepoPrompt returns null when no override is configured", () => {
    expect(dbModule.getRepoPrompt(REPO_A, PARENT)).toBeNull();
    expect(dbModule.getRepoPromptRevisions(REPO_A, PARENT)).toEqual([]);
  });

  test("saveRepoPromptRevision creates a new override and returns a positive revision", () => {
    const result = dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_A,
      repo: REPO_A,
      source: "edit",
    });

    expect(result.isNoChange).toBe(false);
    expect(result.revisionId > 0).toBe(true);

    const stored = dbModule.getRepoPrompt(REPO_A, PARENT);
    expect(stored).toMatchObject({
      agent: PARENT,
      body: BODY_A,
      currentRevisionId: result.revisionId,
      repo: REPO_A,
    });
    expect(dbModule.getRepoPromptRevisions(REPO_A, PARENT)).toHaveLength(1);
    expect(dbModule.getRepoPromptRevisions(REPO_A, PARENT)[0]?.source).toBe("edit");
  });

  test("saveRepoPromptRevision is keyed by (repo, agent) and does not bleed across keys", () => {
    dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_A,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.saveRepoPromptRevision({
      agent: CHILD,
      body: BODY_B,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_A,
      repo: REPO_B,
      source: "edit",
    });

    expect(dbModule.getRepoPrompt(REPO_A, PARENT)?.body).toBe(BODY_A);
    expect(dbModule.getRepoPrompt(REPO_A, CHILD)?.body).toBe(BODY_B);
    expect(dbModule.getRepoPrompt(REPO_B, PARENT)?.body).toBe(BODY_A);
    expect(dbModule.getRepoPrompt(REPO_B, CHILD)).toBeNull();
  });

  test("saving the same body returns isNoChange without creating a new revision", () => {
    const first = dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_A,
      repo: REPO_A,
      source: "edit",
    });
    const second = dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_A,
      repo: REPO_A,
      source: "edit",
    });

    expect(second).toEqual({ isNoChange: true, revisionId: first.revisionId });
    expect(dbModule.getRepoPromptRevisions(REPO_A, PARENT)).toHaveLength(1);
  });

  test("CRLF normalize stores LF body and treats it as identical content", () => {
    const crlf = "first repo override line\r\nsecond override line\rthird override line";
    const normalized = "first repo override line\nsecond override line\nthird override line";

    const saved = dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: crlf,
      repo: REPO_A,
      source: "edit",
    });
    const duplicate = dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: normalized,
      repo: REPO_A,
      source: "edit",
    });

    expect(duplicate).toEqual({ isNoChange: true, revisionId: saved.revisionId });
    expect(dbModule.getRepoPrompt(REPO_A, PARENT)?.body).toBe(normalized);
  });

  test("restoreRepoPromptToRevision appends a new revision with source 'restore'", () => {
    const first = dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_A,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_B,
      repo: REPO_A,
      source: "edit",
    });

    const restored = dbModule.restoreRepoPromptToRevision(REPO_A, PARENT, first.revisionId);

    expect(restored.alreadyCurrent).toBe(false);
    expect(restored.newRevisionId > first.revisionId).toBe(true);
    expect(dbModule.getRepoPrompt(REPO_A, PARENT)?.body).toBe(BODY_A);
    expect(dbModule.getRepoPromptRevisions(REPO_A, PARENT)[0]).toMatchObject({
      body: BODY_A,
      id: restored.newRevisionId,
      source: "restore",
    });
    expect(dbModule.getRepoPromptRevisions(REPO_A, PARENT)).toHaveLength(3);
  });

  test("restoring an unknown revision throws", () => {
    dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_A,
      repo: REPO_A,
      source: "edit",
    });

    expect(() => dbModule.restoreRepoPromptToRevision(REPO_A, PARENT, 9999)).toThrow();
  });

  test("restoring a revision belonging to a different (repo, agent) throws", () => {
    const repoBSaved = dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_B,
      repo: REPO_B,
      source: "edit",
    });
    dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_A,
      repo: REPO_A,
      source: "edit",
    });

    expect(() =>
      dbModule.restoreRepoPromptToRevision(REPO_A, PARENT, repoBSaved.revisionId),
    ).toThrow();
  });

  test("deleteRepoPrompt removes the override and all of its revisions", () => {
    dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_A,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_B,
      repo: REPO_A,
      source: "edit",
    });

    const result = dbModule.deleteRepoPrompt(REPO_A, PARENT);
    expect(result).toEqual({ deleted: true });
    expect(dbModule.getRepoPrompt(REPO_A, PARENT)).toBeNull();
    expect(dbModule.getRepoPromptRevisions(REPO_A, PARENT)).toEqual([]);

    const noop = dbModule.deleteRepoPrompt(REPO_A, PARENT);
    expect(noop).toEqual({ deleted: false });
  });

  test("listRepoPromptOverrides returns one entry per (repo, agent) with revision counts", () => {
    dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_A,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.saveRepoPromptRevision({
      agent: PARENT,
      body: BODY_B,
      repo: REPO_A,
      source: "edit",
    });
    dbModule.saveRepoPromptRevision({
      agent: CHILD,
      body: BODY_A,
      repo: REPO_B,
      source: "edit",
    });

    const all = dbModule.listRepoPromptOverrides();
    expect(all).toHaveLength(2);
    const repoA = all.find((row) => row.repo === REPO_A && row.agent === PARENT);
    expect(repoA?.revisionCount).toBe(2);

    const onlyRepoA = dbModule.listRepoPromptOverrides({ repo: REPO_A });
    expect(onlyRepoA).toHaveLength(1);
    expect(onlyRepoA[0]?.repo).toBe(REPO_A);
  });

  test("invalid bodies are rejected (empty or too long)", () => {
    expect(() =>
      dbModule.saveRepoPromptRevision({
        agent: PARENT,
        body: "",
        repo: REPO_A,
        source: "edit",
      }),
    ).toThrow();
    expect(() =>
      dbModule.saveRepoPromptRevision({
        agent: PARENT,
        body: "x".repeat(102_401),
        repo: REPO_A,
        source: "edit",
      }),
    ).toThrow();
  });

  test("repo slug must match owner/name", () => {
    expect(() =>
      dbModule.saveRepoPromptRevision({
        agent: PARENT,
        body: BODY_A,
        repo: "not-a-slug",
        source: "edit",
      }),
    ).toThrow();
  });

  test("agent must be parent or child", () => {
    expect(() =>
      dbModule.saveRepoPromptRevision({
        // biome-ignore lint/suspicious/noExplicitAny: testing runtime validation
        agent: "neither" as any,
        body: BODY_A,
        repo: REPO_A,
        source: "edit",
      }),
    ).toThrow();
  });
});
