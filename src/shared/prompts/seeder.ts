import type { Logger } from "pino";

import {
  childSystemPromptHasRequiredRules,
  ensureChildSystemPromptRequiredRules,
  GENERIC_CHILD_AGENT_PROMPT,
  GENERIC_PARENT_AGENT_PROMPT,
} from "@/shared/prompts/defaults";

export type PromptKey = "parent.system" | "child.system" | "parent.runtime" | "child.runtime";
type EditablePromptKey = "parent.system" | "child.system";

export type SeedDeps = {
  db: {
    deletePrompt: (key: PromptKey) => { deleted: boolean };
    getPrompt: (key: PromptKey) => { body: string } | null;
    savePromptRevision: (input: {
      body: string;
      key: EditablePromptKey;
      source: "edit" | "seed";
    }) => { isNoChange: boolean; revisionId: number };
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

  const childPrompt = deps.db.getPrompt("child.system");
  const upgraded: PromptKey[] = [];
  if (childPrompt !== null && !childSystemPromptHasRequiredRules(childPrompt.body)) {
    const result = deps.db.savePromptRevision({
      body: ensureChildSystemPromptRequiredRules(childPrompt.body),
      key: "child.system",
      source: "seed",
    });

    if (!result.isNoChange) {
      upgraded.push("child.system");
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

  if (upgraded.length > 0) {
    deps.logger.info(
      { upgraded },
      "upgraded system prompts with required blocker/auth-retry rules",
    );
  }

  if (removed.length > 0) {
    deps.logger.info({ removed }, "removed stale runtime prompt rows");
  }

  return { seeded };
}
