#!/usr/bin/env bun

import process from "node:process";

import { readRunState } from "../src/shared/state";

type CleanupVerifyClient = {
  beta: {
    sessions: {
      retrieve(sessionId: string): Promise<unknown>;
    };
    vaults: {
      retrieve(vaultId: string): Promise<unknown>;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotFoundError(error: unknown): boolean {
  return (
    (isRecord(error) && error.status === 404) ||
    (error instanceof Error && error.name === "NotFoundError")
  );
}

function messageFromUnknown(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function parseRunIdArg(argv: readonly string[]): string {
  const runIdIndex = argv.indexOf("--run-id");
  const runIdValue =
    runIdIndex >= 0 ? argv[runIdIndex + 1] : (process.env.RUN_ID?.trim() ?? undefined);

  if (!runIdValue) {
    throw new Error("Usage: bun run scripts/verify-cleanup.ts --run-id <uuid>");
  }

  return runIdValue;
}

async function expectDeleted(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }

    throw new Error(`${label} verification failed: ${messageFromUnknown(error)}`);
  }

  throw new Error(`${label} still exists`);
}

export async function runVerifyCleanup(argv: readonly string[] = process.argv): Promise<number> {
  const runId = parseRunIdArg(argv.slice(2));
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error("ANTHROPIC_API_KEY is required to verify cleanup");
  }

  const runState = await readRunState(runId);
  if (!runState) {
    throw new Error(`Run state not found for ${runId}`);
  }

  if (!runState.vaultId) {
    throw new Error(`Run ${runId} does not record a vaultId`);
  }
  const vaultId = runState.vaultId;

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropicClient = new Anthropic() as unknown as CleanupVerifyClient;

  await expectDeleted(`vault ${vaultId}`, () => anthropicClient.beta.vaults.retrieve(vaultId));
  process.stdout.write("VAULT_CLEANUP=OK\n");

  for (const sessionId of runState.sessionIds) {
    await expectDeleted(`session ${sessionId}`, () =>
      anthropicClient.beta.sessions.retrieve(sessionId),
    );
  }
  process.stdout.write("SESSION_CLEANUP=OK\n");

  return 0;
}

if (import.meta.main) {
  runVerifyCleanup()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error) => {
      process.stderr.write(`${messageFromUnknown(error)}\n`);
      process.exit(1);
    });
}
