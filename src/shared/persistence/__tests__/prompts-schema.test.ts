import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDbModule } from "@/shared/persistence/db";

type TestDatabase = {
  close(): void;
  exec(sql: string): void;
  query<Row = unknown>(
    sql: string,
  ): {
    all(...params: unknown[]): Row[];
    get(...params: unknown[]): Row | null | undefined;
    run(...params: unknown[]): unknown;
  };
  transaction<Args extends unknown[]>(callback: (...args: Args) => void): (...args: Args) => void;
};

type TestDatabaseConstructor = new (databasePath: string) => TestDatabase;

const require = createRequire(import.meta.url);
const { Database } = require("bun:sqlite") as { Database: TestDatabaseConstructor };

function createCapturedDbModule(dbPath: string): {
  dbModule: ReturnType<typeof createDbModule>;
  getDb: () => TestDatabase;
} {
  let capturedDb: TestDatabase | null = null;
  const dbModule = createDbModule(dbPath, {
    openDatabase: (databasePath) => {
      const db = new Database(databasePath);
      capturedDb = db;
      return db;
    },
  });

  return {
    dbModule,
    getDb: () => {
      if (capturedDb === null) {
        throw new Error("Database was not captured");
      }

      return capturedDb;
    },
  };
}

function createTempDbPath(): { cleanup: () => void; dbPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "prompts-schema-"));

  return {
    cleanup: () => rmSync(tempDir, { force: true, recursive: true }),
    dbPath: join(tempDir, "dashboard.db"),
  };
}

describe("prompts schema", () => {
  test("creates prompts schema and indexes", () => {
    const { dbModule, getDb } = createCapturedDbModule(":memory:");

    try {
      dbModule.initDb();
      const sqliteObjects = getDb()
        .query<{
          name: string;
          type: string;
        }>(
          `SELECT name, type
           FROM sqlite_master
           WHERE name IN (
             'prompts',
             'prompt_revisions',
             'idx_prompt_revisions_key',
             'idx_prompt_revisions_sha'
           )
           ORDER BY type, name`,
        )
        .all();

      expect(sqliteObjects).toEqual([
        { name: "idx_prompt_revisions_key", type: "index" },
        { name: "idx_prompt_revisions_sha", type: "index" },
        { name: "prompt_revisions", type: "table" },
        { name: "prompts", type: "table" },
      ]);
    } finally {
      dbModule.close();
    }
  });

  test("enables WAL journal mode for file databases", () => {
    const { cleanup, dbPath } = createTempDbPath();
    const { dbModule, getDb } = createCapturedDbModule(dbPath);

    try {
      dbModule.initDb();
      const journalMode = getDb()
        .query<{ journal_mode: string }>("PRAGMA journal_mode")
        .get()?.journal_mode;

      expect(journalMode?.toLowerCase()).toBe("wal");
    } finally {
      dbModule.close();
      cleanup();
    }
  });

  test("adds prompts schema to an existing runs database", () => {
    const { cleanup, dbPath } = createTempDbPath();

    try {
      const oldDb = new Database(dbPath);
      oldDb.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          issue_number INTEGER,
          branch TEXT,
          started_at TEXT,
          pr_url TEXT,
          vault_id TEXT
        );
        INSERT INTO runs (run_id, repo, issue_number, branch, started_at, pr_url, vault_id)
        VALUES ('run-existing', 'acme/widgets', 42, 'feature/task-1', '2026-04-24T10:00:00.000Z', NULL, NULL);
      `);
      oldDb.close();

      const { dbModule, getDb } = createCapturedDbModule(dbPath);

      try {
        dbModule.initDb();
        const db = getDb();
        const promptTable = db
          .query<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompts'",
          )
          .get();
        const existingRun = db
          .query<{ repo: string; run_id: string }>(
            "SELECT run_id, repo FROM runs WHERE run_id = 'run-existing'",
          )
          .get();

        expect(promptTable).toEqual({ name: "prompts" });
        expect(existingRun).toEqual({ run_id: "run-existing", repo: "acme/widgets" });
      } finally {
        dbModule.close();
      }
    } finally {
      cleanup();
    }
  });
});
