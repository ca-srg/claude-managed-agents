import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

import { createDbModule } from "@/shared/persistence/db";
import type { PromptKey, SeedDeps } from "@/shared/prompts/seeder";
import { seedDefaultPrompts } from "@/shared/prompts/seeder";

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

const PROMPT_KEYS: PromptKey[] = [
  "parent.system",
  "child.system",
  "parent.runtime",
  "child.runtime",
];

function createCapturedDbModule(): {
  dbModule: ReturnType<typeof createDbModule>;
  getDb: () => TestDatabase;
} {
  let capturedDb: TestDatabase | null = null;
  const dbModule = createDbModule(":memory:", {
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

function createLogger(): { infoCalls: unknown[][]; logger: SeedDeps["logger"] } {
  const infoCalls: unknown[][] = [];
  const logger = {
    info: (...args: unknown[]) => {
      infoCalls.push(args);
    },
    warn: () => undefined,
  } satisfies SeedDeps["logger"];

  return { infoCalls, logger };
}

function getSeedRevisionCount(db: TestDatabase): number {
  const row = db
    .query<{ seedCount: number }>(
      "SELECT COUNT(*) AS seedCount FROM prompt_revisions WHERE source = 'seed'",
    )
    .get();

  if (row == null) {
    throw new Error("Failed to count seed prompt revisions");
  }

  return row.seedCount;
}

describe("seedDefaultPrompts", () => {
  test("seeds all default prompts once and is idempotent", async () => {
    const { dbModule, getDb } = createCapturedDbModule();
    const { infoCalls, logger } = createLogger();

    try {
      dbModule.initDb();

      const first = await seedDefaultPrompts({ db: dbModule, logger });

      expect(first.seeded).toEqual(PROMPT_KEYS);
      expect(PROMPT_KEYS.map((key) => dbModule.getPrompt(key)?.promptKey)).toEqual(PROMPT_KEYS);

      const second = await seedDefaultPrompts({ db: dbModule, logger });

      expect(second.seeded).toEqual([]);
      expect(getSeedRevisionCount(getDb())).toBe(4);
      expect(infoCalls).toHaveLength(1);
    } finally {
      dbModule.close();
    }
  });
});
