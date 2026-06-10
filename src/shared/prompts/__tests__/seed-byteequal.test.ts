import { describe, expect, test } from "bun:test";

import { createDbModule } from "@/shared/persistence/db";
import { GENERIC_CHILD_AGENT_PROMPT, GENERIC_PARENT_AGENT_PROMPT } from "@/shared/prompts/defaults";
import type { PromptKey, SeedDeps } from "@/shared/prompts/seeder";
import { seedDefaultPrompts } from "@/shared/prompts/seeder";

function createLogger(): SeedDeps["logger"] {
  return {
    info: () => undefined,
    warn: () => undefined,
  } satisfies SeedDeps["logger"];
}

function getPromptBody(dbModule: ReturnType<typeof createDbModule>, key: PromptKey): string {
  const prompt = dbModule.getPrompt(key);

  if (prompt === null) {
    throw new Error(`Expected prompt ${key} to exist`);
  }

  return prompt.body;
}

describe("seedDefaultPrompts byte-equal defaults", () => {
  test("stores seeded system prompt bodies byte-equal to canonical sources", async () => {
    const dbModule = createDbModule(":memory:");

    try {
      dbModule.initDb();

      await seedDefaultPrompts({ db: dbModule, logger: createLogger() });

      expect(getPromptBody(dbModule, "parent.system")).toBe(GENERIC_PARENT_AGENT_PROMPT);
      expect(getPromptBody(dbModule, "child.system")).toBe(GENERIC_CHILD_AGENT_PROMPT);
      // Runtime templates are rendered from code; they are never seeded into the DB.
      expect(dbModule.getPrompt("parent.runtime")).toBeNull();
      expect(dbModule.getPrompt("child.runtime")).toBeNull();
    } finally {
      dbModule.close();
    }
  });
});
