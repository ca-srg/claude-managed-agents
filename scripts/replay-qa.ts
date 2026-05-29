#!/usr/bin/env bun

import process from "node:process";

type Writable = {
  write(chunk: string): void;
};

export type Scenario = {
  taskId: string;
  describe: string;
  run(): Promise<{ pass: boolean; message: string }>;
};

const DEFAULT_SCENARIOS: ReadonlyArray<Scenario> = [];

export type ReplayQaOptions = {
  scenarios?: ReadonlyArray<Scenario>;
  stderr?: Writable;
  stdout?: Writable;
};

export function parseReplayQaArgs(argv: readonly string[]): {
  firstScenarioOnly: boolean;
} {
  return {
    firstScenarioOnly: argv.includes("--first-scenario-only"),
  };
}

export function selectReplayQaScenarios(
  scenarios: ReadonlyArray<Scenario>,
  options: { firstScenarioOnly: boolean },
): Scenario[] {
  if (!options.firstScenarioOnly) {
    return [...scenarios];
  }

  const firstScenarioByTask = new Set<string>();

  return scenarios.filter((scenario) => {
    if (firstScenarioByTask.has(scenario.taskId)) {
      return false;
    }

    firstScenarioByTask.add(scenario.taskId);
    return true;
  });
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runReplayQa(
  argv: readonly string[] = process.argv,
  options: ReplayQaOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const scenarios = options.scenarios ?? DEFAULT_SCENARIOS;
  const args = parseReplayQaArgs(argv.slice(2));
  const selectedScenarios = selectReplayQaScenarios(scenarios, args);

  let passCount = 0;

  for (const scenario of selectedScenarios) {
    try {
      const scenarioOutcome = await scenario.run();
      if (!scenarioOutcome.pass) {
        stderr.write(`SCENARIO_FAIL (${scenario.taskId}: ${scenarioOutcome.message})\n`);
        return 1;
      }

      passCount += 1;
    } catch (error) {
      stderr.write(`SCENARIO_FAIL (${scenario.taskId}: ${messageFromUnknown(error)})\n`);
      return 1;
    }
  }

  stdout.write(`ALL_SCENARIOS_PASS (${passCount}/${selectedScenarios.length})\n`);
  return 0;
}

if (import.meta.main) {
  runReplayQa()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      process.stderr.write(`${messageFromUnknown(error)}\n`);
      process.exit(1);
    });
}
