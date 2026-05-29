import { describe, expect, test } from "bun:test";

import { runReplayQa } from "./replay-qa.ts";

type OutputBuffer = {
  text(): string;
  write(chunk: string): void;
};

function createOutputBuffer(): OutputBuffer {
  const chunks: string[] = [];

  return {
    text() {
      return chunks.join("");
    },
    write(chunk: string) {
      chunks.push(chunk);
    },
  };
}

function createScenario(
  taskId: string,
  result: { message: string; pass: boolean },
  onRun?: () => void,
) {
  return {
    describe: `${taskId} scenario`,
    async run() {
      onRun?.();
      return result;
    },
    taskId,
  };
}

describe("replay-qa runner", () => {
  test("all scenarios pass -> exit 0 with ALL_SCENARIOS_PASS marker", async () => {
    const stdout = createOutputBuffer();
    const stderr = createOutputBuffer();

    const exitCode = await runReplayQa(["bun", "scripts/replay-qa.ts"], {
      scenarios: [
        createScenario("task1", { message: "ok", pass: true }),
        createScenario("task4", { message: "ok", pass: true }),
      ],
      stderr,
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("ALL_SCENARIOS_PASS (2/2)\n");
    expect(stderr.text()).toBe("");
  });

  test("first scenario failure -> exit 1 with SCENARIO_FAIL marker", async () => {
    const executed: string[] = [];
    const stdout = createOutputBuffer();
    const stderr = createOutputBuffer();

    const exitCode = await runReplayQa(["bun", "scripts/replay-qa.ts"], {
      scenarios: [
        createScenario("task9", { message: "missing marker", pass: false }, () => {
          executed.push("task9");
        }),
        createScenario("task10", { message: "should not run", pass: true }, () => {
          executed.push("task10");
        }),
      ],
      stderr,
      stdout,
    });

    expect(exitCode).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toBe("SCENARIO_FAIL (task9: missing marker)\n");
    expect(executed).toEqual(["task9"]);
  });

  test("--first-scenario-only runs the first scenario for each task exactly once", async () => {
    const executed: string[] = [];
    const stdout = createOutputBuffer();

    const exitCode = await runReplayQa(["bun", "scripts/replay-qa.ts", "--first-scenario-only"], {
      scenarios: [
        createScenario("task1", { message: "ok", pass: true }, () => {
          executed.push("task1:first");
        }),
        createScenario("task1", { message: "ok", pass: true }, () => {
          executed.push("task1:second");
        }),
        createScenario("task2", { message: "ok", pass: true }, () => {
          executed.push("task2:first");
        }),
      ],
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).toBe("ALL_SCENARIOS_PASS (2/2)\n");
    expect(executed).toEqual(["task1:first", "task2:first"]);
  });
});
