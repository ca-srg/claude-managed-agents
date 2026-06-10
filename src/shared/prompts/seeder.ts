import type { Logger } from "pino";

import { GENERIC_CHILD_AGENT_PROMPT, GENERIC_PARENT_AGENT_PROMPT } from "@/shared/prompts/defaults";

export type PromptKey = "parent.system" | "child.system" | "parent.runtime" | "child.runtime";

export type SeedDeps = {
  db: {
    deletePrompt: (key: PromptKey) => { deleted: boolean };
    seedPromptIfMissing: (key: PromptKey, defaultBody: string) => { seeded: boolean };
  };
  logger: Pick<Logger, "info" | "warn">;
};

const SEED_MAP: Array<{ key: PromptKey; body: string }> = [
  { key: "parent.system", body: GENERIC_PARENT_AGENT_PROMPT },
  { key: "child.system", body: GENERIC_CHILD_AGENT_PROMPT },
];

// Runtime templates are rendered from code and shown via getDefaultPrompt();
// older versions seeded them into the DB, where they went stale after the
// next deploy. Drop any leftover rows so nothing reads them again.
const STALE_RUNTIME_KEYS: PromptKey[] = ["parent.runtime", "child.runtime"];

export async function seedDefaultPrompts(deps: SeedDeps): Promise<{ seeded: PromptKey[] }> {
  const seeded: PromptKey[] = [];

  for (const { key, body } of SEED_MAP) {
    const result = deps.db.seedPromptIfMissing(key, body);

    if (result.seeded) {
      seeded.push(key);
    }
  }

  const removed: PromptKey[] = [];

  for (const key of STALE_RUNTIME_KEYS) {
    const result = deps.db.deletePrompt(key);

    if (result.deleted) {
      removed.push(key);
    }
  }

  if (seeded.length > 0) {
    deps.logger.info({ seeded }, "seeded default prompts");
  }

  if (removed.length > 0) {
    deps.logger.info({ removed }, "removed stale runtime prompt rows");
  }

  return { seeded };
}
