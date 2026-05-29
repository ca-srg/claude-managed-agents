import { describe, expect, test } from "bun:test";
import pino from "pino";

import type { Config } from "@/shared/config";
import {
  BUILTIN_GITHUB_MCP_NAME,
  BUILTIN_GITHUB_MCP_TOKEN_ENV,
  GITHUB_MCP_URL,
  LINEAR_MCP_URL,
} from "@/shared/constants";
import type { McpServer } from "@/shared/persistence/db";
import type { SessionResult } from "@/shared/session";
import type { RunEvent, RunPhase, RunState, RunStatus } from "@/shared/types";
import { createFakeAnthropicSessions } from "../../../../test/fixtures/fake-anthropic-sessions";
import { type RunExecutionDb, type RunExecutionDeps, runIssueOrchestration } from "../handler";

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
      parent: "claude-opus-4-7",
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

function createDeferred<TValue>() {
  let resolve!: (value: TValue | PromiseLike<TValue>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function createToolHandlerContext() {
  const controller = new AbortController();
  return { signal: controller.signal };
}

function createRunningSessionDeleteError(): Error & {
  error: { error: { message: string; type: string }; type: string };
  status: number;
} {
  return Object.assign(new Error("Cannot delete session while it is running"), {
    error: {
      error: {
        message:
          "Cannot delete session while it is running. " +
          "Send an interrupt event or wait for the session to complete.",
        type: "invalid_request_error",
      },
      type: "error",
    },
    status: 400,
  });
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
    seedPromptIfMissing: () => ({ seeded: false }),
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
  const calls: Array<{
    event: Parameters<NonNullable<RunExecutionDeps["runEvents"]>["emit"]>[1];
    runId: string;
  }> = [];
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
  } satisfies NonNullable<RunExecutionDeps["runEvents"]>;

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
    acquireRunLock: async () => {
      callLog.push("acquireRunLock");
    },
    anthropicClient,
    buildChildPrompt: ((_args) => "child prompt") as RunExecutionDeps["buildChildPrompt"],
    buildParentPrompt: ((args) =>
      `Parent prompt for #${args.parentIssueNumber}`) as RunExecutionDeps["buildParentPrompt"],
    db: db.db,
    ensureAgents: (async () => {
      callLog.push("ensureAgents");
      return {
        childAgentId: "agt-child",
        childAgentVersion: 1,
        definitionHash: "hash-agents",
        parentAgentId: "agt-parent",
        parentAgentVersion: 1,
      };
    }) as RunExecutionDeps["ensureAgents"],
    ensureEnvironment: (async () => {
      callLog.push("ensureEnvironment");
      return {
        created: true,
        environmentId: "env-1",
        hash: "hash-env",
      };
    }) as RunExecutionDeps["ensureEnvironment"],
    ensureEnvironmentForRepo: (async () => {
      callLog.push("ensureEnvironmentForRepo");
      return {
        created: false,
        environmentId: "env_repo",
        hash: "repo-hash",
        updated: false,
      };
    }) as RunExecutionDeps["ensureEnvironmentForRepo"],
    ensureMcpCredentials: (async () => {
      callLog.push("ensureMcpCredentials");
      return [];
    }) as RunExecutionDeps["ensureMcpCredentials"],
    ensureVault: (async () => {
      callLog.push("ensureVault");
      return {
        managedByUs: true,
        vaultId: "vault-1",
      };
    }) as RunExecutionDeps["ensureVault"],
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
    readAgentState: async () => null,
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
    releaseRunLock: async () => {
      callLog.push("releaseRunLock");
    },
    releaseVault: (async () => {
      callLog.push("releaseVault");
    }) as RunExecutionDeps["releaseVault"],
    runPreflight: (async () => {
      callLog.push("runPreflight");
      return {
        anthropic: {
          checked: true,
        },
        github: {
          defaultBranch: "main",
          permissions: {},
        },
      };
    }) as RunExecutionDeps["runPreflight"],
    runSession: (async (_client, options) => {
      callLog.push("runSession");
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
    callLog,
    db: db.calls,
    deps,
    fakeAnthropic,
  };
}

describe("runIssueOrchestration", () => {
  test("dry-run returns decompositionPlan without calling Anthropic", async () => {
    const runEvents = createRunEventsSpy();
    const harness = createHarness({ db: undefined, runEvents: runEvents.runEvents });

    const result = await runIssueOrchestration(
      { dryRun: true, issue: 42, repo: "owner/name", runId: "run-dry" },
      harness.deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        aborted: false,
        runId: "run-dry",
        status: "completed",
        timedOut: false,
      }),
    );
    expect(result.decompositionPlan).toEqual(
      expect.objectContaining({
        branch: "agent/issue-42/fix-login-flow",
        commitStyle: "conventional",
        maxSubIssues: 10,
        repo: "owner/name",
      }),
    );
    expect(harness.fakeAnthropic.calls.creates).toEqual([]);
    expect(harness.fakeAnthropic.calls.sends).toEqual([]);
    expect(harness.fakeAnthropic.calls.streamCalls).toEqual([]);
    expect(harness.callLog).not.toContain("ensureEnvironment");
    expect(harness.callLog).not.toContain("ensureEnvironmentForRepo");
    expect(harness.callLog).not.toContain("runSession");
    expect(
      runEvents.calls.filter(
        (call) => call.event.kind === "complete" || call.event.kind === "error",
      ),
    ).toEqual([]);
  });

  test("dry-run uses GitHub-only preflight and skips DB prompt loading", async () => {
    const harness = createHarness({ anthropicClient: undefined });
    const preflightCalls: Parameters<RunExecutionDeps["runPreflight"]>[0][] = [];
    let seedCalls = 0;
    let loadCalls = 0;
    harness.deps.runPreflight = (async (input) => {
      preflightCalls.push(input);
      return {
        anthropic: { checked: false, skipped: true },
        github: { defaultBranch: "main", permissions: {} },
      };
    }) as RunExecutionDeps["runPreflight"];
    harness.deps.seedAgentPrompts = (async () => {
      seedCalls += 1;
      return { seeded: [] };
    }) as RunExecutionDeps["seedAgentPrompts"];
    harness.deps.loadAgentPrompts = (async () => {
      loadCalls += 1;
      return { child: "unused child", parent: "unused parent" };
    }) as RunExecutionDeps["loadAgentPrompts"];

    const result = await runIssueOrchestration(
      { dryRun: true, issue: 42, repo: "owner/name", runId: "run-dry-prompts" },
      harness.deps,
    );

    expect(result.status).toBe("completed");
    expect(result.decompositionPlan).toEqual(
      expect.objectContaining({
        branch: "agent/issue-42/fix-login-flow",
        commitStyle: "conventional",
        maxSubIssues: 10,
        repo: "owner/name",
      }),
    );
    expect(preflightCalls).toHaveLength(1);
    expect(preflightCalls[0]?.skipAnthropicCheck).toBe(true);
    expect(preflightCalls[0]?.anthropicClient).toBeUndefined();
    expect(seedCalls).toBe(0);
    expect(loadCalls).toBe(0);
    expect(harness.db.runs).toEqual([]);
    expect(harness.fakeAnthropic.calls.creates).toEqual([]);
  });

  test("full run syncs run state, session placeholders, and sessions to DB", async () => {
    const harness = createHarness({
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

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-db-sync" },
      harness.deps,
    );

    expect(result.status).toBe("completed");
    expect(harness.db.runs.at(0)?.sessionIds).toEqual([]);
    expect(harness.db.runs.some((run) => run.sessionIds.includes("sess-1"))).toBe(true);
    expect(harness.db.runs.some((run) => run.subIssues[0]?.taskId === "task-1")).toBe(true);
    expect(harness.db.runs.at(-1)?.prUrl).toBe("https://github.com/owner/name/pull/12");
    expect(harness.db.sessionPlaceholders.map((entry) => entry.sessionId)).toEqual(["sess-1"]);
    expect(harness.db.sessions.map((entry) => entry.session.sessionId)).toEqual(["sess-1"]);
    expect(harness.db.statuses.at(-1)).toEqual({ runId: "run-db-sync", status: "completed" });
  });

  test("DB prompt loading forwards edited system prompts to agent registry", async () => {
    const promptCallOrder: string[] = [];
    let ensureAgentsInput: Parameters<RunExecutionDeps["ensureAgents"]>[1] | undefined;
    const harness = createHarness({
      ensureAgents: (async (_client, input) => {
        promptCallOrder.push("ensureAgents");
        ensureAgentsInput = input;
        return {
          childAgentId: "agt-child",
          childAgentVersion: 1,
          definitionHash: "hash-agents",
          parentAgentId: "agt-parent",
          parentAgentVersion: 1,
        };
      }) as RunExecutionDeps["ensureAgents"],
      loadAgentPrompts: (async () => {
        promptCallOrder.push("load");
        return {
          child: "edited child system prompt",
          parent: "edited parent system prompt",
        };
      }) as RunExecutionDeps["loadAgentPrompts"],
      seedAgentPrompts: (async () => {
        promptCallOrder.push("seed");
        return { seeded: ["parent.system"] };
      }) as RunExecutionDeps["seedAgentPrompts"],
    });

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-prompts" },
      harness.deps,
    );

    expect(result.status).toBe("completed");
    expect(promptCallOrder).toEqual(["seed", "load", "ensureAgents"]);
    expect(ensureAgentsInput?.parentPrompt).toBe("edited parent system prompt");
    expect(ensureAgentsInput?.childPrompt).toBe("edited child system prompt");
    expect(ensureAgentsInput?.parentCustomTools).toEqual(harness.deps.parentCustomTools);
  });

  test("repo context is loaded and included in the parent prompt", async () => {
    const loadCalls: Array<{ owner: string; ref: string; repo: string }> = [];
    const harness = createHarness({
      buildParentPrompt: ((args) =>
        `Parent prompt for #${args.parentIssueNumber}\n${args.repoContext ?? ""}`) as RunExecutionDeps["buildParentPrompt"],
      formatRepoContext: ((context, baseBranch) =>
        `## Repository-level context\nbase branch ${baseBranch}\n${context.files
          .map((file) => `${file.path}: ${file.content}`)
          .join("\n")}`) as RunExecutionDeps["formatRepoContext"],
      loadRepoContext: (async (_octokit, owner, repo, ref) => {
        loadCalls.push({ owner, ref, repo });
        return {
          files: [{ content: "Use Bun and Biome.", path: "CLAUDE.md" }],
        };
      }) as RunExecutionDeps["loadRepoContext"],
    });

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-repo-context" },
      harness.deps,
    );

    const sentEvent = harness.fakeAnthropic.calls.sends[0]?.params.events?.[0];
    if (sentEvent?.type !== "user.message") {
      throw new Error("expected parent prompt user message event");
    }
    const sentContent = sentEvent.content[0];
    if (sentContent?.type !== "text") {
      throw new Error("expected parent prompt text event");
    }

    expect(result.status).toBe("completed");
    expect(loadCalls).toEqual([{ owner: "owner", ref: "main", repo: "name" }]);
    expect(sentContent.text).toContain("## Repository-level context");
    expect(sentContent.text).toContain("CLAUDE.md: Use Bun and Biome.");
  });

  test("repo context loading failure does not abort the run", async () => {
    let loadCalls = 0;
    const harness = createHarness({
      loadRepoContext: (async () => {
        loadCalls += 1;
        throw new Error("contents unavailable");
      }) as RunExecutionDeps["loadRepoContext"],
    });

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-repo-context-fail" },
      harness.deps,
    );

    const sentEvent = harness.fakeAnthropic.calls.sends[0]?.params.events?.[0];
    if (sentEvent?.type !== "user.message") {
      throw new Error("expected parent prompt user message event");
    }
    const sentContent = sentEvent.content[0];
    if (sentContent?.type !== "text") {
      throw new Error("expected parent prompt text event");
    }

    expect(result.status).toBe("completed");
    expect(loadCalls).toBe(1);
    expect(sentContent.text).toContain("Parent prompt for #42");
    expect(sentContent.text).not.toContain("Repository-level context");
  });

  test("credential setup failure releases the vault before creating sessions", async () => {
    const harness = createHarness({
      ensureMcpCredentials: (async () => {
        harness.callLog.push("ensureMcpCredentials");
        throw new Error("credential setup failed");
      }) as RunExecutionDeps["ensureMcpCredentials"],
    });

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-credential-fail" },
      harness.deps,
    );

    expect(result.status).toBe("failed");
    expect(result.errored?.message).toBe("credential setup failed");
    expect(harness.fakeAnthropic.calls.creates).toEqual([]);
    expect(harness.callLog).toContain("releaseVault");
  });

  test("credential setup failure releases credentials created before the failure", async () => {
    const releaseVaultCalls: Array<Parameters<RunExecutionDeps["releaseVault"]>[1]> = [];
    const harness = createHarness({
      ensureMcpCredentials: (async (_client, context) => {
        harness.callLog.push("ensureMcpCredentials");
        context.onCredentialEnsured?.({
          credentialId: "vcrd_partial",
          managedByUs: true,
          mcpServerUrl: "https://linear.example.com/mcp/",
        });
        throw new Error("credential setup failed");
      }) as RunExecutionDeps["ensureMcpCredentials"],
      releaseVault: (async (_client, context) => {
        harness.callLog.push("releaseVault");
        releaseVaultCalls.push(structuredClone(context));
      }) as RunExecutionDeps["releaseVault"],
    });

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-partial-credential-fail" },
      harness.deps,
    );

    expect(result.status).toBe("failed");
    expect(result.errored?.message).toBe("credential setup failed");
    expect(releaseVaultCalls).toHaveLength(1);
    expect(releaseVaultCalls[0]?.credentials).toEqual([
      { credentialId: "vcrd_partial", managed: true },
    ]);
  });

  test("configured vault can reuse MCP credentials without local token env", async () => {
    const tokenEnvName = "MISSING_CONFIGURED_VAULT_MCP_TOKEN";
    const previousToken = process.env[tokenEnvName];
    delete process.env[tokenEnvName];
    const mcpServer: McpServer = {
      createdAt: "2026-04-23T00:00:00.000Z",
      enabled: true,
      id: 2,
      isBuiltin: false,
      name: "linear",
      permissionPolicy: "always_allow",
      tokenEnvName,
      updatedAt: "2026-04-23T00:00:00.000Z",
      url: "https://linear.example.com/mcp/",
    };
    const ensureMcpCredentialInputs: unknown[] = [];
    const harness = createHarness({
      ensureMcpCredentials: (async (_client, context) => {
        harness.callLog.push("ensureMcpCredentials");
        ensureMcpCredentialInputs.push(...context.servers);
        return [
          {
            credentialId: "vcrd_existing_linear",
            managedByUs: false,
            mcpServerUrl: mcpServer.url,
          },
        ];
      }) as RunExecutionDeps["ensureMcpCredentials"],
      ensureVault: (async () => {
        harness.callLog.push("ensureVault");
        return {
          managedByUs: false,
          vaultId: "vault-configured",
        };
      }) as RunExecutionDeps["ensureVault"],
    });
    const db = harness.deps.db;
    if (db === undefined) {
      throw new Error("expected mock DB");
    }
    harness.deps.db = {
      ...db,
      listMcpServers: () => [mcpServer],
    };

    try {
      const result = await runIssueOrchestration(
        {
          dryRun: false,
          issue: 42,
          repo: "owner/name",
          runId: "run-configured-vault-reuse",
          vaultId: "vault-configured",
        },
        harness.deps,
      );

      if (result.status !== "completed") {
        throw new Error(result.errored?.message ?? `unexpected status ${result.status}`);
      }
      expect(ensureMcpCredentialInputs).toEqual([
        {
          mcpServerUrl: "https://linear.example.com/mcp/",
          name: "linear",
        },
      ]);
    } finally {
      if (typeof previousToken === "string") {
        process.env[tokenEnvName] = previousToken;
      } else {
        delete process.env[tokenEnvName];
      }
    }
  });

  test("configured vault can reuse a blank-env Linear MCP credential", async () => {
    const linearMcpServer: McpServer = {
      createdAt: "2026-04-23T00:00:00.000Z",
      enabled: true,
      id: 2,
      isBuiltin: false,
      name: "linear",
      permissionPolicy: "always_allow",
      tokenEnvName: "",
      updatedAt: "2026-04-23T00:00:00.000Z",
      url: LINEAR_MCP_URL,
    };
    const ensureMcpCredentialInputs: unknown[] = [];
    const harness = createHarness({
      ensureMcpCredentials: (async (_client, context) => {
        harness.callLog.push("ensureMcpCredentials");
        ensureMcpCredentialInputs.push(...context.servers);
        return [
          {
            credentialId: "vcrd_existing_linear_oauth",
            managedByUs: false,
            mcpServerUrl: linearMcpServer.url,
          },
        ];
      }) as RunExecutionDeps["ensureMcpCredentials"],
      ensureVault: (async () => {
        harness.callLog.push("ensureVault");
        return {
          managedByUs: false,
          vaultId: "vault-configured-linear",
        };
      }) as RunExecutionDeps["ensureVault"],
    });
    const db = harness.deps.db;
    if (db === undefined) {
      throw new Error("expected mock DB");
    }
    harness.deps.db = {
      ...db,
      listMcpServers: () => [linearMcpServer],
    };

    const result = await runIssueOrchestration(
      {
        dryRun: false,
        linearIssue: "ENG-123",
        origin: "linear_issue",
        repo: "owner/name",
        runId: "run-configured-vault-linear-reuse",
        vaultId: "vault-configured-linear",
      },
      harness.deps,
    );

    if (result.status !== "completed") {
      throw new Error(result.errored?.message ?? `unexpected status ${result.status}`);
    }
    expect(ensureMcpCredentialInputs).toEqual([
      {
        mcpServerUrl: LINEAR_MCP_URL,
        name: "linear",
      },
    ]);
  });

  test("managed vault rejects Linear-origin runs when Linear MCP token env is blank", async () => {
    const linearMcpServer: McpServer = {
      createdAt: "2026-04-23T00:00:00.000Z",
      enabled: true,
      id: 2,
      isBuiltin: false,
      name: "linear",
      permissionPolicy: "always_allow",
      tokenEnvName: "",
      updatedAt: "2026-04-23T00:00:00.000Z",
      url: LINEAR_MCP_URL,
    };
    const harness = createHarness({
      ensureAgents: (async () => {
        throw new Error("ensureAgents should not be called");
      }) as RunExecutionDeps["ensureAgents"],
    });
    const db = harness.deps.db;
    if (db === undefined) {
      throw new Error("expected mock DB");
    }
    harness.deps.db = {
      ...db,
      listMcpServers: () => [linearMcpServer],
    };

    const result = await runIssueOrchestration(
      {
        dryRun: false,
        linearIssue: "ENG-123",
        origin: "linear_issue",
        repo: "owner/name",
        runId: "run-managed-vault-linear-missing-token-env",
      },
      harness.deps,
    );

    expect(result.status).toBe("failed");
    expect(result.errored?.type).toBe("linear_mcp_token_missing");
    expect(result.errored?.message).toContain("managed vault");
    expect(result.errored?.message).toContain("pre-provisioned Linear MCP credential");
    expect(harness.callLog).toContain("runPreflight");
    expect(harness.callLog).not.toContain("ensureEnvironment");
    expect(harness.callLog).not.toContain("ensureVault");
  });

  test("managed vault skips credentials for unauthenticated MCP servers", async () => {
    const publicMcpServer: McpServer = {
      createdAt: "2026-04-23T00:00:00.000Z",
      enabled: true,
      id: 2,
      isBuiltin: false,
      name: "public-docs",
      permissionPolicy: "always_allow",
      tokenEnvName: "",
      updatedAt: "2026-04-23T00:00:00.000Z",
      url: "https://public-docs.example.com/mcp/",
    };
    const ensureMcpCredentialInputs: unknown[] = [];
    const harness = createHarness({
      ensureMcpCredentials: (async (_client, context) => {
        harness.callLog.push("ensureMcpCredentials");
        ensureMcpCredentialInputs.push(...context.servers);
        return [];
      }) as RunExecutionDeps["ensureMcpCredentials"],
    });
    const db = harness.deps.db;
    if (db === undefined) {
      throw new Error("expected mock DB");
    }
    harness.deps.db = {
      ...db,
      listMcpServers: () => [publicMcpServer],
    };

    const result = await runIssueOrchestration(
      {
        dryRun: false,
        issue: 42,
        repo: "owner/name",
        runId: "run-public-mcp",
      },
      harness.deps,
    );

    if (result.status !== "completed") {
      throw new Error(result.errored?.message ?? `unexpected status ${result.status}`);
    }
    expect(ensureMcpCredentialInputs).toEqual([]);
    expect(harness.callLog).toContain("ensureMcpCredentials");
  });

  test("disabled builtin GitHub MCP fails before agent registration", async () => {
    const disabledBuiltin: McpServer = {
      createdAt: "2026-04-23T00:00:00.000Z",
      enabled: false,
      id: 1,
      isBuiltin: true,
      name: BUILTIN_GITHUB_MCP_NAME,
      permissionPolicy: "always_allow",
      tokenEnvName: BUILTIN_GITHUB_MCP_TOKEN_ENV,
      updatedAt: "2026-04-23T00:00:00.000Z",
      url: GITHUB_MCP_URL,
    };
    const harness = createHarness({
      ensureAgents: (async () => {
        throw new Error("ensureAgents should not be called");
      }) as RunExecutionDeps["ensureAgents"],
    });
    const db = harness.deps.db;
    if (db === undefined) {
      throw new Error("expected mock DB");
    }
    harness.deps.db = {
      ...db,
      listMcpServers: (options) => (options?.enabledOnly ? [] : [disabledBuiltin]),
    };

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-disabled-github-mcp" },
      harness.deps,
    );

    expect(result.status).toBe("failed");
    expect(result.errored?.message).toBe(
      "Built-in GitHub MCP server must be enabled before agent registration",
    );
  });

  test("mid-session failure drains cleanup in LIFO order", async () => {
    const harness = createHarness({
      runSession: (async () => {
        harness.callLog.push("runSession");
        throw new Error("session failed");
      }) as RunExecutionDeps["runSession"],
    });
    const sessions = harness.deps.anthropicClient?.beta.sessions;
    if (sessions === undefined) {
      throw new Error("expected fake Anthropic sessions client");
    }
    const deleteSession = sessions.delete.bind(sessions);
    sessions.delete = (async (sessionId) => {
      harness.callLog.push("deleteSession");
      return await deleteSession(sessionId);
    }) as typeof sessions.delete;

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-session-fail" },
      harness.deps,
    );
    const cleanupOrder = harness.callLog.filter((entry) =>
      ["runSession", "deleteSession", "releaseVault", "releaseRunLock"].includes(entry),
    );

    expect(result.status).toBe("failed");
    expect(cleanupOrder).toEqual(["runSession", "deleteSession", "releaseVault", "releaseRunLock"]);
  });

  test("cleanup interrupts and retries when session delete sees a running session", async () => {
    const harness = createHarness({
      runSession: (async () => {
        harness.callLog.push("runSession");
        throw new Error("session failed");
      }) as RunExecutionDeps["runSession"],
    });
    const sessions = harness.deps.anthropicClient?.beta.sessions;
    if (sessions === undefined) {
      throw new Error("expected fake Anthropic sessions client");
    }
    const deleteSession = sessions.delete.bind(sessions);
    let deleteAttempts = 0;
    sessions.delete = (async (sessionId) => {
      deleteAttempts += 1;
      harness.callLog.push(`deleteSession:${deleteAttempts}`);
      if (deleteAttempts === 1) {
        throw createRunningSessionDeleteError();
      }

      return await deleteSession(sessionId);
    }) as typeof sessions.delete;

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-session-delete-running" },
      harness.deps,
    );
    const cleanupOrder = harness.callLog.filter(
      (entry) =>
        entry === "runSession" ||
        entry.startsWith("deleteSession") ||
        entry === "releaseVault" ||
        entry === "releaseRunLock",
    );
    const interruptSend = harness.fakeAnthropic.calls.sends.find((send) =>
      send.params.events.some((event) => event.type === "user.interrupt"),
    );

    expect(result.status).toBe("failed");
    expect(cleanupOrder).toEqual([
      "runSession",
      "deleteSession:1",
      "deleteSession:2",
      "releaseVault",
      "releaseRunLock",
    ]);
    expect(interruptSend?.sessionId).toBe("sess-1");
  });

  test("SQLite insertRun failures do not abort a successful run", async () => {
    const harness = createHarness();
    const db = harness.deps.db;
    if (db === undefined) {
      throw new Error("expected mock DB");
    }
    harness.deps.db = {
      ...db,
      insertRun: () => {
        throw new Error("sqlite down");
      },
    };

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-insert-fail" },
      harness.deps,
    );

    expect(result.status).toBe("completed");
    expect(result.prUrl).toBe("https://github.com/owner/name/pull/12");
    expect(harness.db.sessions.map((entry) => entry.session.sessionId)).toEqual(["sess-1"]);
    expect(harness.db.statuses.at(-1)).toEqual({ runId: "run-insert-fail", status: "completed" });
  });

  test("observers.onPhase is called for each phase transition", async () => {
    const harness = createHarness({
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
    const phases: RunPhase[] = [];
    const subIssueEvents: Array<{ kind: "created" | "updated"; payload: unknown }> = [];
    const sessionEvents: Array<{ kind: string; payload?: unknown; sessionId: string }> = [];

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-observers" },
      harness.deps,
      {
        onPhase: (phase) => phases.push(phase),
        onSession: (event) => sessionEvents.push(event),
        onSubIssue: (event) => subIssueEvents.push(event),
      },
    );

    expect(result.status).toBe("completed");
    expect(phases).toEqual([
      "preflight",
      "environment",
      "lock",
      "vault",
      "session_start",
      "decomposition",
      "child_execution",
      "finalize_pr",
      "cleanup",
    ]);
    expect(subIssueEvents).toHaveLength(1);
    expect(subIssueEvents[0]?.kind).toBe("created");
    expect(sessionEvents.map((event) => `${event.sessionId}:${event.kind}`)).toEqual([
      "sess-1:created",
      "sess-1:prompt_sent",
      "sess-1:thread_created",
      "sess-1:completed",
    ]);
  });

  test("AbortSignal firing mid-run returns aborted status", async () => {
    const abortController = new AbortController();
    const runSessionStarted = createDeferred<void>();
    const harness = createHarness({
      runSession: (async (_client, options) => {
        runSessionStarted.resolve();
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });

        return buildSessionResult({
          aborted: true,
          idleReached: false,
          sessionId: options.sessionId,
        });
      }) as RunExecutionDeps["runSession"],
      signal: abortController.signal,
    });

    const runPromise = runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-abort" },
      harness.deps,
    );

    await runSessionStarted.promise;
    abortController.abort();
    const result = await runPromise;

    expect(result.aborted).toBe(true);
    expect(result.status).toBe("aborted");
    expect(harness.db.statuses.at(-1)).toEqual({ runId: "run-abort", status: "aborted" });
  });

  test("preflight failure returns failed result instead of throwing", async () => {
    const runEvents = createRunEventsSpy();
    const harness = createHarness({
      runEvents: runEvents.runEvents,
      runPreflight: (async () => {
        throw new Error("preflight denied");
      }) as RunExecutionDeps["runPreflight"],
    });

    const result = await runIssueOrchestration(
      { dryRun: false, issue: 42, repo: "owner/name", runId: "run-preflight-fail" },
      harness.deps,
    );

    expect(result.status).toBe("failed");
    expect(result.aborted).toBe(false);
    expect(result.errored).toEqual({
      message: "preflight denied",
      type: "preflight_failed",
    });
    expect(
      runEvents.calls.filter(
        (call) => call.event.kind === "complete" || call.event.kind === "error",
      ),
    ).toEqual([]);
  });

  describe("error paths", () => {
    test("error path: preflight failure marks run as failed", async () => {
      const harness = createHarness({
        runPreflight: (async () => {
          throw new Error("preflight permission denied");
        }) as RunExecutionDeps["runPreflight"],
      });

      const result = await runIssueOrchestration(
        { dryRun: false, issue: 42, repo: "owner/name", runId: "run-error-preflight" },
        harness.deps,
      );

      expect(result.status).toBe("failed");
      expect(result.errored).toEqual({
        message: "preflight permission denied",
        type: "preflight_failed",
      });
      expect(harness.db.statuses.at(-1)).toEqual({
        runId: "run-error-preflight",
        status: "failed",
      });
      expect(harness.callLog).not.toContain("acquireRunLock");
    });

    test("error path: vault setup failure releases lock", async () => {
      const harness = createHarness({
        ensureVault: (async () => {
          harness.callLog.push("ensureVault");
          throw new Error("vault setup failed");
        }) as RunExecutionDeps["ensureVault"],
      });

      const result = await runIssueOrchestration(
        { dryRun: false, issue: 42, repo: "owner/name", runId: "run-error-vault" },
        harness.deps,
      );

      expect(result.status).toBe("failed");
      expect(result.errored?.message).toBe("vault setup failed");
      expect(harness.callLog).toContain("acquireRunLock");
      expect(harness.callLog).toContain("releaseRunLock");
      expect(harness.callLog).not.toContain("releaseVault");
      expect(harness.fakeAnthropic.calls.creates).toEqual([]);
      expect(harness.db.statuses.at(-1)).toEqual({
        runId: "run-error-vault",
        status: "failed",
      });
    });

    test("error path: pre-aborted session signal sets status to aborted", async () => {
      const abortController = new AbortController();
      abortController.abort();
      const harness = createHarness({ signal: abortController.signal });

      const result = await runIssueOrchestration(
        { dryRun: false, issue: 42, repo: "owner/name", runId: "run-error-pre-aborted" },
        harness.deps,
      );

      expect(result.aborted).toBe(true);
      expect(result.status).toBe("aborted");
      expect(result.errored).toEqual({
        message: "Run orchestration was aborted",
        type: "aborted",
      });
      expect(harness.callLog).not.toContain("ensureEnvironment");
      expect(harness.callLog).not.toContain("ensureEnvironmentForRepo");
      expect(harness.callLog).not.toContain("acquireRunLock");
      expect(harness.db.statuses.at(-1)).toEqual({
        runId: "run-error-pre-aborted",
        status: "aborted",
      });
    });
  });
});
