import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { type LockOptions, lock, unlock } from "proper-lockfile";

import { RUN_LOCK, STATE_FILE } from "@/shared/constants";
import { RunOriginSchema } from "@/shared/run-origin";
import type { AgentState, RunState } from "@/shared/types";

const require = createRequire(import.meta.url);

type AtomicWriteOptions = {
  chown?: { gid: number; uid: number } | false;
  encoding?: BufferEncoding | null;
  fsync?: boolean;
  mode?: number | false;
  tmpfileCreated?: (tmpfile: string) => unknown;
};

type AtomicWriter = (filePath: string, data: string, options?: AtomicWriteOptions) => Promise<void>;

type StateModuleDependencies = {
  cwd: () => string;
  lock: typeof lock;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  unlock: typeof unlock;
  writeFileAtomic: AtomicWriter;
};

export type AcquireRunLockOptions = Pick<LockOptions, "onCompromised" | "retries" | "stale">;

export const DEFAULT_RUN_LOCK_STALE_MS = 10 * 60 * 1000;

const writeFileAtomic = require("write-file-atomic") as AtomicWriter;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isAgentState(value: unknown): value is AgentState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.parentAgentId === "string" &&
    typeof value.parentAgentVersion === "number" &&
    typeof value.childAgentId === "string" &&
    typeof value.childAgentVersion === "number" &&
    typeof value.environmentId === "string" &&
    typeof value.definitionHash === "string" &&
    typeof value.createdAt === "string"
  );
}

function isRunSubIssue(value: unknown): value is RunState["subIssues"][number] {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.taskId === "string" &&
    typeof value.issueId === "number" &&
    typeof value.issueNumber === "number"
  );
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
  if (typeof value === "undefined") {
    return true;
  }

  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRunState(value: unknown): value is RunState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.runId === "string" &&
    (typeof value.issueNumber === "number" || value.issueNumber === null) &&
    (typeof value.origin === "undefined" || RunOriginSchema.safeParse(value.origin).success) &&
    typeof value.repo === "string" &&
    typeof value.branch === "string" &&
    typeof value.startedAt === "string" &&
    Array.isArray(value.subIssues) &&
    value.subIssues.every((subIssue) => isRunSubIssue(subIssue)) &&
    isStringArray(value.sessionIds) &&
    (typeof value.prUrl === "undefined" || typeof value.prUrl === "string") &&
    (typeof value.vaultId === "undefined" || typeof value.vaultId === "string") &&
    isOptionalPositiveInteger(value.pid)
  );
}

function isErrorWithCode(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatStateJson(state: AgentState | RunState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function invalidStateError(filePath: string, label: string): Error {
  return new Error(`Invalid ${label} in ${filePath}`);
}

export function createStateModule(overrides: Partial<StateModuleDependencies> = {}) {
  const dependencies: StateModuleDependencies = {
    cwd: () => process.cwd(),
    lock,
    mkdir,
    readFile,
    unlock,
    writeFileAtomic,
    ...overrides,
  };

  function resolveFromWorkingDirectory(relativePath: string): string {
    return resolve(dependencies.cwd(), relativePath);
  }

  function runStatePath(runId: string): string {
    return resolveFromWorkingDirectory(join(dirname(STATE_FILE), `run-${runId}.json`));
  }

  async function ensureStateDirectory(filePath: string): Promise<void> {
    await dependencies.mkdir(dirname(filePath), { recursive: true });
  }

  async function readJsonState<T>(
    filePath: string,
    label: string,
    validateState: (value: unknown) => value is T,
  ): Promise<T | null> {
    try {
      const fileContents = await dependencies.readFile(filePath, "utf8");
      const parsedState: unknown = JSON.parse(fileContents);

      if (!validateState(parsedState)) {
        throw invalidStateError(filePath, label);
      }

      return parsedState;
    } catch (error) {
      if (isErrorWithCode(error) && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  async function writeJsonState(filePath: string, state: AgentState | RunState): Promise<void> {
    await ensureStateDirectory(filePath);
    await dependencies.writeFileAtomic(filePath, formatStateJson(state), {
      encoding: "utf8",
    });
  }

  async function readAgentState(): Promise<AgentState | null> {
    return readJsonState(resolveFromWorkingDirectory(STATE_FILE), "agent state", isAgentState);
  }

  async function writeAgentState(state: AgentState): Promise<void> {
    if (!isAgentState(state)) {
      throw invalidStateError(resolveFromWorkingDirectory(STATE_FILE), "agent state");
    }

    await writeJsonState(resolveFromWorkingDirectory(STATE_FILE), state);
  }

  async function readRunState(runId: string): Promise<RunState | null> {
    return readJsonState(runStatePath(runId), `run state for ${runId}`, isRunState);
  }

  async function writeRunState(runId: string, state: RunState): Promise<void> {
    const filePath = runStatePath(runId);

    if (!isRunState(state) || state.runId !== runId) {
      throw invalidStateError(filePath, `run state for ${runId}`);
    }

    await writeJsonState(filePath, state);
  }

  async function acquireRunLock(options: AcquireRunLockOptions = {}): Promise<void> {
    const lockPath = resolveFromWorkingDirectory(RUN_LOCK);
    await ensureStateDirectory(lockPath);
    const lockOptions: LockOptions = {
      realpath: false,
      retries: options.retries ?? 0,
      stale: options.stale ?? DEFAULT_RUN_LOCK_STALE_MS,
    };

    if (options.onCompromised) {
      lockOptions.onCompromised = options.onCompromised;
    }

    await dependencies.lock(lockPath, lockOptions);
  }

  async function releaseRunLock(): Promise<void> {
    await dependencies.unlock(resolveFromWorkingDirectory(RUN_LOCK), {
      realpath: false,
    });
  }

  return {
    acquireRunLock,
    readAgentState,
    readRunState,
    releaseRunLock,
    writeAgentState,
    writeRunState,
  };
}

const defaultStateModule = createStateModule();

export const {
  acquireRunLock,
  readAgentState,
  readRunState,
  releaseRunLock,
  writeAgentState,
  writeRunState,
} = defaultStateModule;
