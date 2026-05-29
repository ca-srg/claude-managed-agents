import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createDbModule } from "@/shared/persistence/db";
import type { EditablePromptKey } from "@/shared/persistence/schemas";

const PARENT_KEY: EditablePromptKey = "parent.system";
const CHILD_KEY: EditablePromptKey = "child.system";
const BODY_A = "Parent system prompt revision A";
const BODY_B = "Parent system prompt revision B";

type DbModule = ReturnType<typeof createDbModule>;
type PromptSnapshot = NonNullable<ReturnType<DbModule["getPrompt"]>>;

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function readPrompt(dbModule: DbModule, key: EditablePromptKey = PARENT_KEY): PromptSnapshot {
  const prompt = dbModule.getPrompt(key);

  if (prompt === null) {
    throw new Error(`Expected prompt ${key} to exist`);
  }

  return prompt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

describe("prompt repository DB functions", () => {
  let dbModule: DbModule;

  beforeEach(() => {
    dbModule = createDbModule(":memory:");
    dbModule.initDb();
  });

  afterEach(() => {
    dbModule.close();
  });

  test("seedPromptIfMissing is idempotent and preserves the first body", () => {
    expect(dbModule.seedPromptIfMissing(PARENT_KEY, BODY_A)).toEqual({ seeded: true });
    expect(dbModule.seedPromptIfMissing(PARENT_KEY, BODY_B)).toEqual({ seeded: false });

    expect(readPrompt(dbModule)).toMatchObject({
      body: BODY_A,
      promptKey: PARENT_KEY,
    });
    expect(dbModule.getPromptRevisions(PARENT_KEY)).toHaveLength(1);
    expect(dbModule.getPromptRevisions(PARENT_KEY)[0]?.source).toBe("seed");
  });

  test("savePromptRevision with a different body creates a new current revision", () => {
    dbModule.seedPromptIfMissing(PARENT_KEY, BODY_A);
    const before = readPrompt(dbModule);

    const saved = dbModule.savePromptRevision({ body: BODY_B, key: PARENT_KEY, source: "edit" });

    expect(saved.isNoChange).toBe(false);
    expect(saved.revisionId > before.currentRevisionId).toBe(true);
    expect(readPrompt(dbModule)).toMatchObject({
      body: BODY_B,
      currentRevisionId: saved.revisionId,
    });
    expect(dbModule.getPromptRevisions(PARENT_KEY).map((revision) => revision.source)).toEqual([
      "edit",
      "seed",
    ]);
  });

  test("no.change current body returns current revision without inserting or updating", async () => {
    const first = dbModule.savePromptRevision({ body: BODY_A, key: PARENT_KEY, source: "edit" });
    const before = readPrompt(dbModule);

    await sleep(5);

    const second = dbModule.savePromptRevision({ body: BODY_A, key: PARENT_KEY, source: "edit" });
    const after = readPrompt(dbModule);

    expect(second).toEqual({ isNoChange: true, revisionId: first.revisionId });
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.currentRevisionId).toBe(first.revisionId);
    expect(dbModule.getPromptRevisions(PARENT_KEY)).toHaveLength(1);
  });

  test("past duplicate body creates a new revision when current differs", () => {
    const first = dbModule.savePromptRevision({ body: BODY_A, key: PARENT_KEY, source: "edit" });
    dbModule.savePromptRevision({ body: BODY_B, key: PARENT_KEY, source: "edit" });

    const third = dbModule.savePromptRevision({ body: BODY_A, key: PARENT_KEY, source: "edit" });

    expect(third.isNoChange).toBe(false);
    expect(third.revisionId > first.revisionId).toBe(true);
    expect(readPrompt(dbModule)).toMatchObject({
      body: BODY_A,
      currentRevisionId: third.revisionId,
    });
    expect(dbModule.getPromptRevisions(PARENT_KEY)).toHaveLength(3);
  });

  test("allowDuplicateBody true bypasses the no-change check", () => {
    const first = dbModule.savePromptRevision({ body: BODY_A, key: PARENT_KEY, source: "edit" });

    const second = dbModule.savePromptRevision(
      { body: BODY_A, key: PARENT_KEY, source: "edit" },
      { allowDuplicateBody: true },
    );

    expect(second.isNoChange).toBe(false);
    expect(second.revisionId > first.revisionId).toBe(true);
    expect(readPrompt(dbModule).currentRevisionId).toBe(second.revisionId);
    expect(dbModule.getPromptRevisions(PARENT_KEY)).toHaveLength(2);
  });

  test("restore past revision appends new revision with source restore", () => {
    const first = dbModule.savePromptRevision({ body: BODY_A, key: PARENT_KEY, source: "edit" });
    dbModule.savePromptRevision({ body: BODY_B, key: PARENT_KEY, source: "edit" });

    const restored = dbModule.restorePromptToRevision(PARENT_KEY, first.revisionId);

    expect(restored.alreadyCurrent).toBe(false);
    expect(restored.newRevisionId > first.revisionId).toBe(true);
    expect(readPrompt(dbModule)).toMatchObject({
      body: BODY_A,
      currentRevisionId: restored.newRevisionId,
    });
    expect(dbModule.getPromptRevisions(PARENT_KEY)[0]).toMatchObject({
      body: BODY_A,
      id: restored.newRevisionId,
      source: "restore",
    });
    expect(dbModule.getPromptRevisions(PARENT_KEY)).toHaveLength(3);
  });

  test("restore alreadyCurrent when target body is already current", () => {
    const saved = dbModule.savePromptRevision({ body: BODY_A, key: PARENT_KEY, source: "edit" });

    const restored = dbModule.restorePromptToRevision(PARENT_KEY, saved.revisionId);

    expect(restored).toEqual({ alreadyCurrent: true, newRevisionId: saved.revisionId });
    expect(dbModule.getPromptRevisions(PARENT_KEY)).toHaveLength(1);
  });

  test("restore non-existent revision_id throws", () => {
    dbModule.savePromptRevision({ body: BODY_A, key: PARENT_KEY, source: "edit" });

    expect(() => dbModule.restorePromptToRevision(PARENT_KEY, 999)).toThrow();
  });

  test("restore revision_id from a different key throws", () => {
    dbModule.savePromptRevision({ body: BODY_A, key: PARENT_KEY, source: "edit" });
    const childRevision = dbModule.savePromptRevision({
      body: "Child system prompt revision A",
      key: CHILD_KEY,
      source: "edit",
    });

    expect(() => dbModule.restorePromptToRevision(PARENT_KEY, childRevision.revisionId)).toThrow();
  });

  test("CRLF normalize stores LF body and hashes the normalized content", () => {
    const crlfBody = "First prompt line\r\nSecond prompt line\rThird prompt line";
    const normalizedBody = "First prompt line\nSecond prompt line\nThird prompt line";

    const saved = dbModule.savePromptRevision({ body: crlfBody, key: PARENT_KEY, source: "edit" });
    const duplicate = dbModule.savePromptRevision({
      body: normalizedBody,
      key: PARENT_KEY,
      source: "edit",
    });
    const revision = dbModule.getPromptRevision(PARENT_KEY, saved.revisionId);

    expect(duplicate).toEqual({ isNoChange: true, revisionId: saved.revisionId });
    expect(readPrompt(dbModule).body).toBe(normalizedBody);
    expect(revision?.body).toBe(normalizedBody);
    expect(revision?.bodySha256).toBe(sha256(normalizedBody));
  });

  test("invalid input throws zod errors for empty and too long bodies", () => {
    expect(() =>
      dbModule.savePromptRevision({ body: "", key: PARENT_KEY, source: "edit" }),
    ).toThrow();
    expect(() =>
      dbModule.savePromptRevision({ body: "x".repeat(102_401), key: PARENT_KEY, source: "edit" }),
    ).toThrow();
  });
});
