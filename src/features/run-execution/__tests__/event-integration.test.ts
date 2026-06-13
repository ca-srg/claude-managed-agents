import { describe, expect, test } from "bun:test";
import pino from "pino";

import type { Config } from "@/shared/config";
import type { SessionResult } from "@/shared/session";
import type { RunEvent, RunPhase, RunState, RunStatus } from "@/shared/types";
import { createFakeAnthropicSessions } from "../../../../test/fixtures/fake-anthropic-sessions";
import { type RunExecutionDb, type RunExecutionDeps, runIssueOrchestration } from "../handler";

type RunEventsModule = NonNullable<RunExecutionDeps["runEvents"]>;
type EmitRunEventInput = Parameters<RunEventsModule["emit"]>[1];
type EmitCall = {
  event: EmitRunEventInput;
  runId: string;
};

function createEmptySessionUsage(): SessionResult["usage"] {
  return {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    inputTokens: 0,
    modelRequestCount: 0,
    outputTokens: 0,
  };
}

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    commitStyle: "conventional",
    git: {
      authorEmail: "claude-agent@users.noreply.github.com",
      authorName: "claude-agent[bot]",
    },
    maxChildMinutes: 30,
    maxRunMinutes: 120,
    maxSubIssues: 10,
    models: {
      child: "claude-sonnet-4-6",
      parent: "claude-opus-4-8",
    },
    pr: {
      base: "main",
      draft: true,
    },
    ...overrides,
  };
}

function buildSessionResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    aborted: false,
    durationMs: 1,
    errored: false,
    eventsProcessed: 1,
    idleReached: true,
    lastEventId: "evt_1",
    model: undefined,
    sessionId: "sess-parent",
    timedOut: false,
    toolErrors: 0,
    toolInvocations: 0,
    usage: createEmptySessionUsage(),
    ...overrides,
  };
}

function createToolHandlerContext() {
  const controller = new AbortController();
  return { signal: controller.signal };
}

function createMockDb() {
  const calls = {
    phases: [] as Array<{ phase: RunPhase | null; runId: string }>,
    runs: [] as RunState[],
    sessionPlaceholders: [] as Array<{ runId: string; sessionId: string }>,
    sessions: [] as Array<{ runId: string; session: SessionResult }>,
    statuses: [] as Array<{ runId: string; status: RunStatus }>,
  };

  const db = {
    getDefaultEnvironmentState: () => null,
    getPrompt: () => null,
    getRepoEnvironment: () => null,
    getRepoPrompt: () => null,
    insertRun: (run: RunState) => {
      calls.runs.push(structuredClone(run));
    },
    insertSession: (runId: string, session: SessionResult) => {
      calls.sessions.push({ runId, session: structuredClone(session) });
    },
    insertSessionPlaceholder: (runId: string, sessionId: string) => {
      calls.sessionPlaceholders.push({ runId, sessionId });
    },
    listMcpServers: () => [],
    deletePrompt: () => ({ deleted: false }),
    savePromptRevision: () => ({ isNoChange: true, revisionId: 1 }),
    seedPromptIfMissing: () => ({ seeded: false }),
    setDefaultEnvironmentState: () => {},
    setRepoEnvironmentAnthropicState: () => {},
    setRunPhase: (runId: string, phase: RunPhase | null) => {
      calls.phases.push({ phase, runId });
    },
    setRunStatus: (runId: string, status: RunStatus) => {
      calls.statuses.push({ runId, status });
    },
  } satisfies RunExecutionDb;

  return { calls, db };
}

function createRunEventsSpy() {
  const calls: EmitCall[] = [];
  let eventCount = 0;

  const runEvents = {
    emit(runId, event) {
      eventCount += 1;
      calls.push({ event, runId });

      return {
        id: `run-event-${eventCount}`,
        kind: event.kind,
        payload: event.payload,
        runId,
        ts: `2026-04-28T00:00:${eventCount.toString().padStart(2, "0")}.000Z`,
      } satisfies RunEvent;
    },
  } satisfies RunEventsModule;

  return { calls, runEvents };
}

function createHarness(overrides: Partial<RunExecutionDeps> = {}) {
  const fakeAnthropic = createFakeAnthropicSessions({ streamScripts: [] });
  const db = createMockDb();
  const logger = pino({ level: "silent" });
  const callLog: string[] = [];
  const anthropicClient = fakeAnthropic.client as unknown as NonNullable<
    RunExecutionDeps["anthropicClient"]
  >;

  const deps: RunExecutionDeps = {
    acquireRunLock: async () => {},
    anthropicClient,
    buildParentPrompt: ((args) =>
      `Parent prompt for #${args.parentIssueNumber}`) as RunExecutionDeps["buildParentPrompt"],
    db: db.db,
    ensureAgents: (async () => ({
      childAgentId: "agt-child",
      childAgentVersion: 1,
      definitionHash: "hash-agents",
      parentAgentId: "agt-parent",
      parentAgentVersion: 1,
    })) as RunExecutionDeps["ensureAgents"],
    ensureEnvironment: (async () => ({
      created: true,
      environmentId: "env-1",
      hash: "hash-env",
    })) as RunExecutionDeps["ensureEnvironment"],
    ensureEnvironmentForRepo: (async () => {
      callLog.push("ensureEnvironmentForRepo");
      return {
        created: false,
        environmentId: "env_repo",
        hash: "repo-hash",
        updated: false,
      };
    }) as RunExecutionDeps["ensureEnvironmentForRepo"],
    ensureMcpCredentials: (async () => []) as RunExecutionDeps["ensureMcpCredentials"],
    ensureVault: (async () => ({
      managedByUs: true,
      vaultId: "vault-1",
    })) as RunExecutionDeps["ensureVault"],
    githubAuth: {
      resolveRepositoryAccess: async () => ({
        authMode: "app",
        authorizationToken: "ghs_test_installation_token",
        installationId: 12345,
        octokit: { token: "ghs_test_installation_token" },
        permissions: {
          contents: "write",
          issues: "write",
          pull_requests: "write",
        },
        repositorySelection: "selected",
      }),
    } as unknown as RunExecutionDeps["githubAuth"],
    handleCreateFinalPr: (async () => ({
      prNumber: 12,
      prUrl: "https://github.com/owner/name/pull/12",
      success: true,
      updated: false,
    })) as RunExecutionDeps["handleCreateFinalPr"],
    handleCreateSubIssue: (async (ctx) => {
      ctx.runState.subIssues = [{ issueId: 701, issueNumber: 43, taskId: "task-1" }];
      return {
        reused: false,
        subIssueId: 701,
        subIssueNumber: 43,
        success: true,
      };
    }) as RunExecutionDeps["handleCreateSubIssue"],
    formatRepoContext: (() => null) as RunExecutionDeps["formatRepoContext"],
    loadAgentPrompts: async () => ({
      child: "child system prompt",
      parent: "parent system prompt",
    }),
    loadConfig: async () => buildConfig(),
    loadRepoContext: (async () => ({ files: [] })) as RunExecutionDeps["loadRepoContext"],
    logger,
    parentCustomTools: [],
    readIssue: (async (_octokit, _owner, _repo, issueNumber) => ({
      issue: {
        body: "Parent issue body",
        id: 501,
        number: issueNumber,
        state: "open",
        title: "Fix login flow",
      },
      subIssues: [],
    })) as RunExecutionDeps["readIssue"],
    releaseRunLock: async () => {},
    runPreflight: (async () => ({
      anthropic: {
        checked: true,
      },
      github: {
        defaultBranch: "main",
        permissions: {},
      },
    })) as RunExecutionDeps["runPreflight"],
    runSession: (async (_client, options) => {
      await options.handlers.create_final_pr?.(
        {
          base: "main",
          body: "Ready for review",
          head: "agent/issue-42/fix-login-flow",
          parentIssueNumber: 42,
          title: "Fix login flow",
        },
        createToolHandlerContext(),
      );

      return buildSessionResult({ sessionId: options.sessionId });
    }) as RunExecutionDeps["runSession"],
    seedAgentPrompts: async () => ({ seeded: [] }),
    writeRunState: async () => {},
    ...overrides,
  };

  return {
    db: db.calls,
    deps,
    fakeAnthropic,
  };
}

function eventPayload<TPayload>(call: EmitCall): TPayload {
  return call.event.payload as TPayload;
}

describe("runIssueOrchestration run-events integration", () => {
  test("emits phase events for every user-observed phase without terminal events", async () => {
    const runEvents = createRunEventsSpy();
    const harness = createHarness({
      runEvents: runEvents.runEvents,
      runSession: (async (_client, options) => {
        await options.handlers.create_sub_issue?.(
          { body: "Sub task", title: "Sub task" },
          createToolHandlerContext(),
        );
        options.threadObserver?.onThreadCreated?.({
          agentName: "github-issue-implementer",
          sessionThreadId: "thread-1",
        });
        await options.handlers.create_final_pr?.(
          {
            base: "main",
            body: "Ready for review",
            head: "agent/issue-42/fix-login-flow",
            parentIssueNumber: 42,
            title: "Fix login flow",
          },
          createToolHandlerContext(),
        );

        return buildSessionResult({ sessionId: options.sessionId });
      }) as RunExecutionDeps["runSession"],
    });
    const observedPhases: RunPhase[] = [];

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-events-phase" },
      harness.deps,
      {
        onPhase: (phase) => observedPhases.push(phase),
      },
    );

    const phaseEvents = runEvents.calls.filter((call) => call.event.kind === "phase");
    const emittedPhases = phaseEvents.map((call) => eventPayload<{ phase: RunPhase }>(call).phase);

    expect(result.status).toBe("completed");
    expect(emittedPhases).toEqual(observedPhases);
    expect(emittedPhases).toEqual([
      "preflight",
      "environment",
      "lock",
      "vault",
      "session_start",
      "decomposition",
      "child_execution",
      "finalize_pr",
    ]);
    // session.created/prompt_sent/completed は SSE 側の動的監視で必須なので emit される
    expect(runEvents.calls.some((call) => call.event.kind === "complete")).toBe(false);
    expect(runEvents.calls.some((call) => call.event.kind === "error")).toBe(false);
  });

  test("emits session lifecycle events including thread events", async () => {
    const runEvents = createRunEventsSpy();
    const harness = createHarness({
      runEvents: runEvents.runEvents,
      runSession: (async (_client, options) => {
        options.threadObserver?.onThreadCreated?.({
          agentName: "github-issue-implementer",
          sessionThreadId: "thread-1",
        });
        await options.handlers.create_final_pr?.(
          {
            base: "main",
            body: "Ready for review",
            head: "agent/issue-42/fix-login-flow",
            parentIssueNumber: 42,
            title: "Fix login flow",
          },
          createToolHandlerContext(),
        );

        return buildSessionResult({ sessionId: options.sessionId });
      }) as RunExecutionDeps["runSession"],
    });

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-events-session-lifecycle" },
      harness.deps,
    );

    expect(result.status).toBe("completed");

    const sessionEvents = runEvents.calls
      .filter((call) => call.event.kind === "session")
      .map((call) => eventPayload<{ details?: unknown; kind: string; sessionId: string }>(call));

    const parentEvents = sessionEvents.filter((event) => event.sessionId === "sess-1");

    expect(parentEvents.map((event) => event.kind)).toEqual([
      "created",
      "prompt_sent",
      "thread_created",
      "completed",
    ]);
    expect(parentEvents[0]?.details).toEqual({ role: "parent" });
    const threadCreatedEvent = parentEvents.find((event) => event.kind === "thread_created");
    expect(threadCreatedEvent?.details).toEqual({
      agentName: "github-issue-implementer",
      role: "child",
      sessionThreadId: "thread-1",
    });
  });

  test("emits created sub-issue updates through run-events", async () => {
    const runEvents = createRunEventsSpy();
    const harness = createHarness({
      runEvents: runEvents.runEvents,
      runSession: (async (_client, options) => {
        await options.handlers.create_sub_issue?.(
          { body: "Sub task", title: "Sub task" },
          createToolHandlerContext(),
        );
        await options.handlers.create_final_pr?.(
          {
            base: "main",
            body: "Ready for review",
            head: "agent/issue-42/fix-login-flow",
            parentIssueNumber: 42,
            title: "Fix login flow",
          },
          createToolHandlerContext(),
        );

        return buildSessionResult({ sessionId: options.sessionId });
      }) as RunExecutionDeps["runSession"],
    });

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-events-sub-issue" },
      harness.deps,
    );

    const subIssueEvents = runEvents.calls.filter((call) => call.event.kind === "subIssue");
    const payload = eventPayload<{
      changeKind: "created" | "updated";
      issueId: number;
      issueNumber: number;
      repo: string;
      status: "pending";
      taskId: string;
      title?: string;
    }>(subIssueEvents[0] as EmitCall);

    expect(result.status).toBe("completed");
    expect(subIssueEvents).toHaveLength(1);
    expect(payload).toEqual({
      changeKind: "created",
      issueId: 701,
      issueNumber: 43,
      repo: "owner/name",
      status: "pending",
      taskId: "task-1",
      title: "Sub task",
    });
  });

  test("emits log events without terminal error or complete on failed runs", async () => {
    const runEvents = createRunEventsSpy();
    const harness = createHarness({
      runEvents: runEvents.runEvents,
      runPreflight: (async () => {
        throw new Error("preflight denied");
      }) as RunExecutionDeps["runPreflight"],
    });

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-events-failure" },
      harness.deps,
    );

    const logEvent = runEvents.calls.find((call) => call.event.kind === "log") as
      | EmitCall
      | undefined;
    const terminalEvents = runEvents.calls.filter(
      (call) => call.event.kind === "error" || call.event.kind === "complete",
    );

    expect(result.status).toBe("failed");
    expect(
      eventPayload<{ fields: { type: string }; level: string; msg: string }>(logEvent as EmitCall),
    ).toEqual({
      fields: expect.objectContaining({ type: "preflight_failed" }),
      level: "error",
      msg: "run orchestration failed",
    });
    expect(terminalEvents).toEqual([]);
  });

  test("completes unchanged when run-events dependency is omitted", async () => {
    const harness = createHarness();

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-events-omitted" },
      harness.deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        aborted: false,
        prUrl: "https://github.com/owner/name/pull/12",
        runId: "run-events-omitted",
        status: "completed",
        timedOut: false,
      }),
    );
  });
});
