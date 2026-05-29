import { describe, expect, test } from "bun:test";

import { createDbModule } from "@/shared/persistence/db";
import {
  CHILD_RUNTIME_TEMPLATE_SOURCE,
  GENERIC_CHILD_AGENT_PROMPT,
  GENERIC_PARENT_AGENT_PROMPT,
  PARENT_RUNTIME_TEMPLATE_SOURCE,
} from "@/shared/prompts/defaults";
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
  test("stores all seeded prompt bodies byte-equal to canonical sources", async () => {
    const dbModule = createDbModule(":memory:");

    try {
      dbModule.initDb();

      await seedDefaultPrompts({ db: dbModule, logger: createLogger() });

      expect(getPromptBody(dbModule, "parent.system")).toBe(GENERIC_PARENT_AGENT_PROMPT);
      expect(getPromptBody(dbModule, "child.system")).toBe(GENERIC_CHILD_AGENT_PROMPT);
      expect(getPromptBody(dbModule, "parent.runtime")).toBe(PARENT_RUNTIME_TEMPLATE_SOURCE);
      expect(getPromptBody(dbModule, "child.runtime")).toBe(CHILD_RUNTIME_TEMPLATE_SOURCE);
    } finally {
      dbModule.close();
    }
  });
});
