import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

import { createDbModule } from "@/shared/persistence/db";
import { childSystemPromptHasRequiredRules } from "@/shared/prompts/defaults";
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

const SEEDED_PROMPT_KEYS: PromptKey[] = ["parent.system", "child.system"];
const RUNTIME_PROMPT_KEYS: PromptKey[] = ["parent.runtime", "child.runtime"];

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

function getRuntimeRevisionCount(db: TestDatabase): number {
  const row = db
    .query<{ runtimeCount: number }>(
      "SELECT COUNT(*) AS runtimeCount FROM prompt_revisions WHERE prompt_key IN ('parent.runtime', 'child.runtime')",
    )
    .get();

  if (row == null) {
    throw new Error("Failed to count runtime prompt revisions");
  }

  return row.runtimeCount;
}

describe("seedDefaultPrompts", () => {
  test("seeds editable default prompts once and is idempotent", async () => {
    const { dbModule, getDb } = createCapturedDbModule();
    const { infoCalls, logger } = createLogger();

    try {
      dbModule.initDb();

      const first = await seedDefaultPrompts({ db: dbModule, logger });

      expect(first.seeded).toEqual(SEEDED_PROMPT_KEYS);
      expect(SEEDED_PROMPT_KEYS.map((key) => dbModule.getPrompt(key)?.promptKey)).toEqual(
        SEEDED_PROMPT_KEYS,
      );

      for (const key of RUNTIME_PROMPT_KEYS) {
        expect(dbModule.getPrompt(key)).toBeNull();
      }

      const second = await seedDefaultPrompts({ db: dbModule, logger });

      expect(second.seeded).toEqual([]);
      expect(getSeedRevisionCount(getDb())).toBe(2);
      expect(infoCalls).toHaveLength(1);
    } finally {
      dbModule.close();
    }
  });

  test("removes stale runtime prompt rows seeded by older versions", async () => {
    const { dbModule, getDb } = createCapturedDbModule();
    const { logger } = createLogger();

    try {
      dbModule.initDb();
      dbModule.seedPromptIfMissing("parent.runtime", "Stale parent runtime template body");
      dbModule.seedPromptIfMissing("child.runtime", "Stale child runtime template body");

      await seedDefaultPrompts({ db: dbModule, logger });

      for (const key of RUNTIME_PROMPT_KEYS) {
        expect(dbModule.getPrompt(key)).toBeNull();
      }
      expect(getRuntimeRevisionCount(getDb())).toBe(0);
    } finally {
      dbModule.close();
    }
  });

  test("upgrades existing child.system prompts missing blocker/auth-retry rules", async () => {
    const { dbModule } = createCapturedDbModule();
    const { logger } = createLogger();

    try {
      dbModule.initDb();
      dbModule.seedPromptIfMissing("child.system", "Custom child prompt without blocker rules");

      await seedDefaultPrompts({ db: dbModule, logger });

      const upgraded = dbModule.getPrompt("child.system");
      expect(upgraded?.body).toContain("Custom child prompt without blocker rules");
      expect(upgraded?.body).toContain("MCP/API authentication failures:");
      expect(upgraded?.body).toContain('"status": "blocked"');
      expect(upgraded?.body).toContain("`error.type` set to `unresolvable_instructions`");
      expect(childSystemPromptHasRequiredRules(upgraded?.body ?? "")).toBe(true);

      const revisionCountAfterUpgrade = dbModule.getPromptRevisions("child.system").length;
      await seedDefaultPrompts({ db: dbModule, logger });
      expect(dbModule.getPromptRevisions("child.system")).toHaveLength(revisionCountAfterUpgrade);
    } finally {
      dbModule.close();
    }
  });
});
