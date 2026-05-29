import { describe, expect, it } from "bun:test";

import { GENERIC_CHILD_AGENT_PROMPT, GENERIC_PARENT_AGENT_PROMPT } from "@/shared/prompts/defaults";
import { type LoadAgentPromptsDeps, loadAgentSystemPrompts } from "@/shared/prompts/loader";

type PromptKey = "parent.system" | "child.system";

function createFakeLogger(): {
  logger: LoadAgentPromptsDeps["logger"];
  warnCalls: unknown[][];
} {
  const warnCalls: unknown[][] = [];

  return {
    logger: {
      info: () => {},
      warn: (...args: unknown[]) => {
        warnCalls.push(args);
      },
    },
    warnCalls,
  };
}

describe("loadAgentSystemPrompts", () => {
  it("DB hit|hit returns DB-stored system prompt bodies", async () => {
    const { logger, warnCalls } = createFakeLogger();
    const db: LoadAgentPromptsDeps["db"] = {
      getPrompt: (key) => ({
        body: key === "parent.system" ? "parent from db" : "child from db",
      }),
    };

    await expect(loadAgentSystemPrompts({ db, logger })).resolves.toEqual({
      child: "child from db",
      parent: "parent from db",
    });
    expect(warnCalls).toEqual([]);
  });

  it("fallback|throw uses source defaults when DB rows are empty", async () => {
    const { logger, warnCalls } = createFakeLogger();
    const db: LoadAgentPromptsDeps["db"] = {
      getPrompt: () => null,
    };

    await expect(loadAgentSystemPrompts({ db, logger })).resolves.toEqual({
      child: GENERIC_CHILD_AGENT_PROMPT,
      parent: GENERIC_PARENT_AGENT_PROMPT,
    });
    expect(warnCalls).toEqual([]);
  });

  it("fallback|throw for parent failure and still loads child from DB", async () => {
    const { logger, warnCalls } = createFakeLogger();
    const parentError = new Error("parent read failed");
    const db: LoadAgentPromptsDeps["db"] = {
      getPrompt: (key: PromptKey) => {
        if (key === "parent.system") {
          throw parentError;
        }

        return { body: "child survived" };
      },
    };

    await expect(loadAgentSystemPrompts({ db, logger })).resolves.toEqual({
      child: "child survived",
      parent: GENERIC_PARENT_AGENT_PROMPT,
    });
    expect(warnCalls.length).toBe(1);
    expect(warnCalls[0]?.[0]).toEqual({ err: parentError });
    expect(warnCalls[0]?.[1]).toBe("failed to load parent.system from DB; using source default");
  });

  it("fallback|throw when both prompt reads fail and emits two warns", async () => {
    const { logger, warnCalls } = createFakeLogger();
    const parentError = new Error("parent read failed");
    const childError = new Error("child read failed");
    const db: LoadAgentPromptsDeps["db"] = {
      getPrompt: (key: PromptKey) => {
        throw key === "parent.system" ? parentError : childError;
      },
    };

    await expect(loadAgentSystemPrompts({ db, logger })).resolves.toEqual({
      child: GENERIC_CHILD_AGENT_PROMPT,
      parent: GENERIC_PARENT_AGENT_PROMPT,
    });
    expect(warnCalls.length).toBe(2);
    expect(warnCalls[0]?.[0]).toEqual({ err: parentError });
    expect(warnCalls[0]?.[1]).toBe("failed to load parent.system from DB; using source default");
    expect(warnCalls[1]?.[0]).toEqual({ err: childError });
    expect(warnCalls[1]?.[1]).toBe("failed to load child.system from DB; using source default");
  });
});
