import type { Logger } from "pino";

import {
  CHILD_RUNTIME_TEMPLATE_SOURCE,
  GENERIC_CHILD_AGENT_PROMPT,
  GENERIC_PARENT_AGENT_PROMPT,
  PARENT_RUNTIME_TEMPLATE_SOURCE,
} from "@/shared/prompts/defaults";

export type PromptKey = "parent.system" | "child.system" | "parent.runtime" | "child.runtime";

export type SeedDeps = {
  db: {
    seedPromptIfMissing: (key: PromptKey, defaultBody: string) => { seeded: boolean };
  };
  logger: Pick<Logger, "info" | "warn">;
};

const SEED_MAP: Array<{ key: PromptKey; body: string }> = [
  { key: "parent.system", body: GENERIC_PARENT_AGENT_PROMPT },
  { key: "child.system", body: GENERIC_CHILD_AGENT_PROMPT },
  { key: "parent.runtime", body: PARENT_RUNTIME_TEMPLATE_SOURCE },
  { key: "child.runtime", body: CHILD_RUNTIME_TEMPLATE_SOURCE },
];

export async function seedDefaultPrompts(deps: SeedDeps): Promise<{ seeded: PromptKey[] }> {
  const seeded: PromptKey[] = [];

  for (const { key, body } of SEED_MAP) {
    const result = deps.db.seedPromptIfMissing(key, body);

    if (result.seeded) {
      seeded.push(key);
    }
  }

  if (seeded.length > 0) {
    deps.logger.info({ seeded }, "seeded default prompts");
  }

  return { seeded };
}
