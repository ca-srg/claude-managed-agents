import type { Logger } from "pino";

import { GENERIC_CHILD_AGENT_PROMPT, GENERIC_PARENT_AGENT_PROMPT } from "@/shared/prompts/defaults";

export type LoadAgentPromptsDeps = {
  db: {
    getPrompt: (key: "parent.system" | "child.system") => { body: string } | null;
  };
  logger: Pick<Logger, "warn" | "info">;
};

export async function loadAgentSystemPrompts(
  deps: LoadAgentPromptsDeps,
): Promise<{ parent: string; child: string }> {
  let parent = GENERIC_PARENT_AGENT_PROMPT;
  let child = GENERIC_CHILD_AGENT_PROMPT;

  try {
    const parentRow = deps.db.getPrompt("parent.system");
    if (parentRow && parentRow.body.length > 0) {
      parent = parentRow.body;
    }
  } catch (err) {
    deps.logger.warn({ err }, "failed to load parent.system from DB; using source default");
  }

  try {
    const childRow = deps.db.getPrompt("child.system");
    if (childRow && childRow.body.length > 0) {
      child = childRow.body;
    }
  } catch (err) {
    deps.logger.warn({ err }, "failed to load child.system from DB; using source default");
  }

  return { parent, child };
}
