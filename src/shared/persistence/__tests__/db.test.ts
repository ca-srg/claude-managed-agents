import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

import { createDbModule } from "@/shared/persistence/db";
import type { SessionResult } from "@/shared/session";
import type { RunEvent, RunState } from "@/shared/types";

type TestDatabase = {
  close(): void;
  exec(sql: string): void;
  query<Row = unknown>(
    sql: string,
  ): {
    all(...params: unknown[]): Row[];
    get(...params: unknown[]): Row | null | undefined;
    run(...params: unknown[]): unknown;
  };
  transaction<Args extends unknown[]>(callback: (...args: Args) => void): (...args: Args) => void;
};

type TestDatabaseConstructor = new (databasePath: string) => TestDatabase;

const require = createRequire(import.meta.url);
const { Database } = require("bun:sqlite") as { Database: TestDatabaseConstructor };

function createEmptySessionUsage(): SessionResult["usage"] {
  return {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    inputTokens: 0,
    modelRequestCount: 0,
    outputTokens: 0,
  };
}

function createRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    branch: "feature/task-1",
    issueNumber: 42,
    origin: {
      issueNumber: 42,
      repo: "acme/widgets",
      type: "github_issue",
      url: "https://github.com/acme/widgets/issues/42",
    },
    pid: undefined,
    repo: "acme/widgets",
    runId: "run-1",
    sessionIds: [],
    startedAt: "2026-04-24T10:00:00.000Z",
    subIssues: [
      {
        issueId: 1001,
        issueNumber: 101,
        taskId: "task-1",
      },
    ],
    ...overrides,
  };
}

function createSessionResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    aborted: false,
    durationMs: 12_345,
    errored: false,
    eventsProcessed: 25,
    idleReached: true,
    lastEventId: "evt_123",
    model: undefined,
    sessionId: "session-1",
    timedOut: false,
    toolErrors: 1,
    toolInvocations: 8,
    usage: createEmptySessionUsage(),
    ...overrides,
  };
}

function createRunEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    id: "00000000-0000-7000-8000-000000000001",
    kind: "log",
    payload: { message: "hello" },
    runId: "run-1",
    ts: "2026-04-24T10:00:01.000Z",
    ...overrides,
  };
}

describe("createDbModule", () => {
  let capturedDb: TestDatabase | null = null;
  let dbModule = createDbModule(":memory:", {
    openDatabase: (dbPath) => {
      const db = new Database(dbPath);
      capturedDb = db;
      return db;
    },
  });

  beforeEach(() => {
    capturedDb = null;
    dbModule = createDbModule(":memory:", {
      openDatabase: (dbPath) => {
        const db = new Database(dbPath);
        capturedDb = db;
        return db;
      },
    });
    dbModule.initDb();
  });

  afterEach(() => {
    dbModule.close();
    capturedDb = null;
  });

  test("initDb creates the expected tables and indexes", () => {
    const sqliteObjects = capturedDb
      ?.query<{
        name: string;
        type: string;
      }>(
        `SELECT name, type
         FROM sqlite_master
         WHERE name IN (
           'runs',
            'sessions',
            'run_events',
            'sub_issues',
            'idx_runs_repo',
            'idx_sessions_run',
            'idx_run_events_run',
            'idx_sub_issues_run'
          )
         ORDER BY type, name`,
      )
      .all();

    expect(sqliteObjects).toEqual([
      { name: "idx_run_events_run", type: "index" },
      { name: "idx_runs_repo", type: "index" },
      { name: "idx_sessions_run", type: "index" },
      { name: "idx_sub_issues_run", type: "index" },
      { name: "run_events", type: "table" },
      { name: "runs", type: "table" },
      { name: "sessions", type: "table" },
      { name: "sub_issues", type: "table" },
    ]);
  });

  test("insertRun and getRunsByRepo preserve run fields including subIssues", () => {
    const run = createRunState({
      prUrl: "https://github.com/acme/widgets/pull/9",
      runId: "run-round-trip",
      vaultId: "vault-123",
    });

    dbModule.insertRun(run);

    expect(dbModule.getRunsByRepo("acme/widgets")).toEqual([run]);
  });

  test("insertRun persists multiple subIssues", () => {
    const run = createRunState({
      runId: "run-multi-sub-issues",
      subIssues: [
        { issueId: 2001, issueNumber: 201, taskId: "task-1" },
        { issueId: 2002, issueNumber: 202, taskId: "task-2" },
        { issueId: 2003, issueNumber: 203, taskId: "task-3" },
      ],
    });

    dbModule.insertRun(run);

    expect(dbModule.getSubIssuesByRun(run.runId)).toEqual(run.subIssues);
    expect(dbModule.getRunById(run.runId)?.subIssues).toEqual(run.subIssues);
  });

  test("getRunsByRepo filters by repo and orders by startedAt descending", () => {
    dbModule.insertRun(
      createRunState({
        runId: "run-old",
        startedAt: "2026-04-24T08:00:00.000Z",
      }),
    );
    dbModule.insertRun(
      createRunState({
        runId: "run-other-repo",
        repo: "acme/other",
        startedAt: "2026-04-24T12:00:00.000Z",
      }),
    );
    dbModule.insertRun(
      createRunState({
        runId: "run-new",
        startedAt: "2026-04-24T11:00:00.000Z",
      }),
    );

    expect(dbModule.getRunsByRepo("acme/widgets").map((run) => run.runId)).toEqual([
      "run-new",
      "run-old",
    ]);
  });

  test("insertSession and getSessionsByRun preserve session fields", () => {
    const run = createRunState({ runId: "run-with-sessions" });
    const session = createSessionResult({ sessionId: "session-round-trip" });

    dbModule.insertRun(run);
    dbModule.insertSession(run.runId, session);

    expect(dbModule.getSessionsByRun(run.runId)).toEqual([session]);
    expect(dbModule.getRunById(run.runId)?.sessionIds).toEqual([session.sessionId]);
  });

  test("insertSessionPlaceholder records an in-progress session row", () => {
    const run = createRunState({ runId: "run-placeholder" });

    dbModule.insertRun(run);
    dbModule.insertSessionPlaceholder(run.runId, "session-pending");

    expect(dbModule.getRunById(run.runId)?.sessionIds).toEqual(["session-pending"]);
    expect(dbModule.getSessionsByRun(run.runId)).toEqual([
      {
        aborted: false,
        durationMs: 0,
        errored: false,
        eventsProcessed: 0,
        idleReached: false,
        lastEventId: undefined,
        model: undefined,
        sessionId: "session-pending",
        timedOut: false,
        toolErrors: 0,
        toolInvocations: 0,
        usage: createEmptySessionUsage(),
      },
    ]);
  });

  test("insertSession overwrites an existing placeholder for the same sessionId", () => {
    const run = createRunState({ runId: "run-placeholder-upsert" });
    const sessionId = "session-upsert";

    dbModule.insertRun(run);
    dbModule.insertSessionPlaceholder(run.runId, sessionId);

    const finalSession = createSessionResult({
      durationMs: 9_999,
      eventsProcessed: 42,
      idleReached: true,
      sessionId,
    });
    dbModule.insertSession(run.runId, finalSession);

    expect(dbModule.getSessionsByRun(run.runId)).toEqual([finalSession]);
    expect(dbModule.getRunById(run.runId)?.sessionIds).toEqual([sessionId]);
  });

  test("insertSubIssue and getSubIssuesByRun work standalone", () => {
    const run = createRunState({ runId: "run-standalone-sub-issue", subIssues: [] });
    const subIssue = {
      issueId: 3001,
      issueNumber: 301,
      taskId: "task-standalone",
    };

    dbModule.insertRun(run);
    dbModule.insertSubIssue(run.runId, subIssue);

    expect(dbModule.getSubIssuesByRun(run.runId)).toEqual([subIssue]);
  });

  test("insertRunEvent and listRunEvents preserve events with JSON payloads", () => {
    const run = createRunState({ runId: "run-events-round-trip" });
    const event = createRunEvent({
      id: "00000000-0000-7000-8000-000000000101",
      payload: { phase: "preflight", step: 1 },
      runId: run.runId,
    });

    dbModule.insertRun(run);
    dbModule.insertRunEvent(event);

    expect(dbModule.listRunEvents({ runId: run.runId })).toEqual([event]);
  });

  test("listRunEvents resumes after fromEventId and preserves id ordering", () => {
    const run = createRunState({ runId: "run-events-resume" });
    const events = [
      createRunEvent({ id: "00000000-0000-7000-8000-000000000201", runId: run.runId }),
      createRunEvent({ id: "00000000-0000-7000-8000-000000000202", runId: run.runId }),
      createRunEvent({ id: "00000000-0000-7000-8000-000000000203", runId: run.runId }),
    ];

    dbModule.insertRun(run);
    for (const event of events) {
      dbModule.insertRunEvent(event);
    }

    expect(dbModule.listRunEvents({ fromEventId: events[0]?.id, runId: run.runId })).toEqual([
      events[1],
      events[2],
    ]);
  });

  test("listRunEvents honors positive limits", () => {
    const run = createRunState({ runId: "run-events-limit" });
    const events = [
      createRunEvent({ id: "00000000-0000-7000-8000-000000000301", runId: run.runId }),
      createRunEvent({ id: "00000000-0000-7000-8000-000000000302", runId: run.runId }),
      createRunEvent({ id: "00000000-0000-7000-8000-000000000303", runId: run.runId }),
    ];

    dbModule.insertRun(run);
    for (const event of events) {
      dbModule.insertRunEvent(event);
    }

    expect(dbModule.listRunEvents({ limit: 2, runId: run.runId })).toEqual([events[0], events[1]]);
  });

  test("listRunEvents supports descending limits", () => {
    const run = createRunState({ runId: "run-events-desc-limit" });
    const events = [
      createRunEvent({ id: "00000000-0000-7000-8000-000000000401", runId: run.runId }),
      createRunEvent({ id: "00000000-0000-7000-8000-000000000402", runId: run.runId }),
      createRunEvent({ id: "00000000-0000-7000-8000-000000000403", runId: run.runId }),
    ];

    dbModule.insertRun(run);
    for (const event of events) {
      dbModule.insertRunEvent(event);
    }

    expect(dbModule.listRunEvents({ limit: 2, order: "desc", runId: run.runId })).toEqual([
      events[2],
      events[1],
    ]);
  });

  test("listRepositories returns unique repos with run counts and last run timestamps", () => {
    dbModule.insertRun(
      createRunState({
        repo: "acme/alpha",
        runId: "run-alpha-1",
        startedAt: "2026-04-24T09:00:00.000Z",
      }),
    );
    dbModule.insertRun(
      createRunState({
        repo: "acme/beta",
        runId: "run-beta-1",
        startedAt: "2026-04-24T11:00:00.000Z",
      }),
    );
    dbModule.insertRun(
      createRunState({
        repo: "acme/alpha",
        runId: "run-alpha-2",
        startedAt: "2026-04-24T10:00:00.000Z",
      }),
    );

    expect(dbModule.listRepositories()).toEqual([
      {
        lastRunAt: "2026-04-24T11:00:00.000Z",
        repo: "acme/beta",
        runCount: 1,
      },
      {
        lastRunAt: "2026-04-24T10:00:00.000Z",
        repo: "acme/alpha",
        runCount: 2,
      },
    ]);
  });

  test("getRunById returns null for a nonexistent run", () => {
    expect(dbModule.getRunById("missing-run")).toBeNull();
  });

  test("zod validation rejects invalid input", () => {
    expect(() =>
      dbModule.insertRun(
        createRunState({
          issueNumber: -1,
          runId: "invalid-run",
        }),
      ),
    ).toThrow();

    expect(() =>
      dbModule.insertSubIssue("run-1", {
        issueId: 1,
        issueNumber: -1,
        taskId: "task-invalid",
      }),
    ).toThrow();
  });

  test("insertRun and getRunById round-trip the pid field", () => {
    const run = createRunState({ pid: 54_321, runId: "run-with-pid" });

    dbModule.insertRun(run);

    expect(dbModule.getRunById(run.runId)?.pid).toBe(54_321);
  });

  test("insertRun overwrites the pid via on-conflict update", () => {
    const baseRun = createRunState({ pid: 1_111, runId: "run-pid-overwrite" });

    dbModule.insertRun(baseRun);
    dbModule.insertRun({ ...baseRun, pid: 2_222 });

    expect(dbModule.getRunById(baseRun.runId)?.pid).toBe(2_222);
  });

  test("initDb creates runs status and phase columns", () => {
    const columns = capturedDb
      ?.query<{
        dflt_value: string | null;
        name: string;
        notnull: number;
        type: string;
      }>("PRAGMA table_info(runs)")
      .all();

    const statusColumn = columns?.find((column) => column.name === "status");
    const phaseColumn = columns?.find((column) => column.name === "phase");

    expect(statusColumn).toMatchObject({
      dflt_value: "'queued'",
      name: "status",
      notnull: 1,
      type: "TEXT",
    });
    expect(phaseColumn).toMatchObject({
      dflt_value: null,
      name: "phase",
      notnull: 0,
      type: "TEXT",
    });
  });

  test("setRunStatus updates status and setRunPhase updates phase", () => {
    const run = createRunState({ runId: "run-status-phase" });

    dbModule.insertRun(run);
    expect(dbModule.listRuns({}).find((summary) => summary.runId === run.runId)?.status).toBe(
      "queued",
    );

    dbModule.setRunStatus(run.runId, "running");
    dbModule.setRunPhase(run.runId, "decomposition");

    expect(dbModule.listRuns({}).find((summary) => summary.runId === run.runId)).toMatchObject({
      phase: "decomposition",
      runId: run.runId,
      status: "running",
    });

    dbModule.setRunPhase(run.runId, null);
    expect(
      dbModule.listRuns({}).find((summary) => summary.runId === run.runId)?.phase,
    ).toBeUndefined();
  });

  test("getRunStatus and setRunStatusIfCurrent provide atomic status transitions", () => {
    const run = createRunState({ runId: "run-status-cas" });

    dbModule.insertRun(run);
    expect(dbModule.getRunStatus(run.runId)).toBe("queued");
    expect(dbModule.getRunStatus("missing-run")).toBeNull();

    expect(dbModule.setRunStatusIfCurrent(run.runId, "running", ["queued"])).toBe(true);
    expect(dbModule.getRunStatus(run.runId)).toBe("running");

    expect(dbModule.setRunStatusIfCurrent(run.runId, "completed", ["queued"])).toBe(false);
    expect(dbModule.getRunStatus(run.runId)).toBe("running");

    expect(dbModule.setRunStatusIfCurrent(run.runId, "failed", [])).toBe(false);
    expect(dbModule.getRunStatus(run.runId)).toBe("running");
  });

  test("resyncOrphanedRuns can exclude snapshot run ids", () => {
    dbModule.insertRun(createRunState({ runId: "run-excluded-running" }));
    dbModule.insertRun(createRunState({ runId: "run-aborted-running" }));
    dbModule.insertRun(createRunState({ runId: "run-aborted-queued" }));
    dbModule.insertRun(createRunState({ runId: "run-completed" }));
    dbModule.setRunStatus("run-excluded-running", "running");
    dbModule.setRunStatus("run-aborted-running", "running");
    dbModule.setRunStatus("run-completed", "completed");

    expect(dbModule.resyncOrphanedRuns({ excludeRunIds: ["run-excluded-running"] })).toEqual({
      aborted: 2,
    });

    expect(dbModule.getRunStatus("run-excluded-running")).toBe("running");
    expect(dbModule.getRunStatus("run-aborted-running")).toBe("aborted");
    expect(dbModule.getRunStatus("run-aborted-queued")).toBe("aborted");
    expect(dbModule.getRunStatus("run-completed")).toBe("completed");
  });

  test("listRuns filters by status and repo", () => {
    dbModule.insertRun(
      createRunState({
        repo: "a/b",
        runId: "run-a-running",
        startedAt: "2026-04-24T09:00:00.000Z",
      }),
    );
    dbModule.insertRun(
      createRunState({
        repo: "a/b",
        runId: "run-a-failed",
        startedAt: "2026-04-24T10:00:00.000Z",
      }),
    );
    dbModule.insertRun(
      createRunState({
        repo: "c/d",
        runId: "run-c-running",
        startedAt: "2026-04-24T11:00:00.000Z",
      }),
    );

    dbModule.setRunStatus("run-a-running", "running");
    dbModule.setRunStatus("run-a-failed", "failed");
    dbModule.setRunStatus("run-c-running", "running");

    expect(dbModule.listRuns({ status: "running" }).map((summary) => summary.runId)).toEqual([
      "run-c-running",
      "run-a-running",
    ]);
    expect(dbModule.listRuns({ repo: "a/b" }).map((summary) => summary.runId)).toEqual([
      "run-a-failed",
      "run-a-running",
    ]);
  });

  test("agent registry state round-trips through SQLite", () => {
    expect(dbModule.getAgentRegistryState()).toBeNull();

    dbModule.setAgentRegistryState({
      parentAgentId: "agt_parent",
      parentAgentVersion: 3,
      childAgentId: "agt_child",
      childAgentVersion: 2,
      definitionHash: "combined-hash",
      parentDefinitionHash: "parent-hash",
      childDefinitionHash: "child-hash",
      createdAt: "2026-04-24T00:00:00.000Z",
    });

    const persistedState = dbModule.getAgentRegistryState();

    expect(typeof persistedState?.updatedAt).toBe("string");
    expect(persistedState).toEqual({
      parentAgentId: "agt_parent",
      parentAgentVersion: 3,
      childAgentId: "agt_child",
      childAgentVersion: 2,
      definitionHash: "combined-hash",
      parentDefinitionHash: "parent-hash",
      childDefinitionHash: "child-hash",
      createdAt: "2026-04-24T00:00:00.000Z",
      updatedAt: persistedState?.updatedAt,
    });
  });

  test("system skill state round-trips through SQLite", () => {
    expect(dbModule.getSystemSkillState("github_operations")).toBeNull();

    dbModule.setSystemSkillState({
      contentHash: "skill-content-hash-v1",
      createdAt: "2026-04-24T00:00:00.000Z",
      key: "github_operations",
      skillId: "skill_github_ops",
      skillVersion: "1700000000000000",
    });

    const persistedState = dbModule.getSystemSkillState("github_operations");

    expect(typeof persistedState?.updatedAt).toBe("string");
    expect(persistedState).toEqual({
      contentHash: "skill-content-hash-v1",
      createdAt: "2026-04-24T00:00:00.000Z",
      key: "github_operations",
      skillId: "skill_github_ops",
      skillVersion: "1700000000000000",
      updatedAt: persistedState?.updatedAt,
    });
  });

  test("default environment state round-trips and updates in place", () => {
    expect(dbModule.getDefaultEnvironmentState()).toBeNull();

    dbModule.setDefaultEnvironmentState({
      definitionHash: "env-hash-v1",
      environmentId: "env_1",
    });
    const firstState = dbModule.getDefaultEnvironmentState();

    expect(typeof firstState?.createdAt).toBe("string");
    expect(typeof firstState?.updatedAt).toBe("string");
    expect(firstState).toEqual({
      definitionHash: "env-hash-v1",
      environmentId: "env_1",
      createdAt: firstState?.createdAt,
      updatedAt: firstState?.updatedAt,
    });

    dbModule.setDefaultEnvironmentState({
      definitionHash: "env-hash-v2",
      environmentId: "env_2",
    });

    const updatedState = dbModule.getDefaultEnvironmentState();

    expect(typeof updatedState?.updatedAt).toBe("string");
    expect(updatedState).toEqual({
      definitionHash: "env-hash-v2",
      environmentId: "env_2",
      createdAt: firstState?.createdAt,
      updatedAt: updatedState?.updatedAt,
    });
  });
});

describe("createDbModule pid migration", () => {
  test("ALTER TABLE adds pid column to legacy runs tables and existing rows return pid=undefined", () => {
    const sharedDb = new Database(":memory:");

    sharedDb.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        issue_number INTEGER,
        branch TEXT,
        started_at TEXT,
        pr_url TEXT,
        vault_id TEXT
      );
    `);

    sharedDb
      .query(
        `INSERT INTO runs (run_id, repo, issue_number, branch, started_at, pr_url, vault_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .run(
        "legacy-run",
        "acme/widgets",
        99,
        "agent/legacy",
        "2026-04-24T00:00:00.000Z",
        null,
        null,
      );

    const dbModule = createDbModule(":memory:", {
      openDatabase: () => sharedDb,
    });
    dbModule.initDb();

    try {
      const columns = sharedDb.query<{ name: string }>("PRAGMA table_info(runs)").all() as {
        name: string;
      }[];
      const columnNames = columns.map((column) => column.name);

      expect(columnNames).toContain("pid");

      const legacyRun = dbModule.getRunById("legacy-run");
      expect(legacyRun).not.toBeNull();
      expect(legacyRun?.pid).toBeUndefined();

      dbModule.insertRun(createRunState({ pid: 7_777, runId: "fresh-run" }));
      expect(dbModule.getRunById("fresh-run")?.pid).toBe(7_777);
    } finally {
      dbModule.close();
    }
  });

  test("initDb preserves active rows and explicit resync aborts them", () => {
    const sharedDb = new Database(":memory:");

    sharedDb.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        issue_number INTEGER,
        branch TEXT,
        started_at TEXT,
        pr_url TEXT,
        vault_id TEXT,
        pid INTEGER,
        status TEXT NOT NULL DEFAULT 'queued',
        phase TEXT
      );
    `);
    sharedDb
      .query(
        `INSERT INTO runs (
           run_id,
           repo,
           issue_number,
           branch,
           started_at,
           pr_url,
           vault_id,
           pid,
           status,
           phase
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .run(
        "running-run",
        "acme/widgets",
        101,
        "agent/running",
        "2026-04-24T01:00:00.000Z",
        null,
        null,
        null,
        "running",
        null,
      );
    sharedDb
      .query(
        `INSERT INTO runs (
           run_id,
           repo,
           issue_number,
           branch,
           started_at,
           pr_url,
           vault_id,
           pid,
           status,
           phase
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .run(
        "queued-run",
        "acme/widgets",
        102,
        "agent/queued",
        "2026-04-24T02:00:00.000Z",
        null,
        null,
        null,
        "queued",
        null,
      );
    sharedDb
      .query(
        `INSERT INTO runs (
           run_id,
           repo,
           issue_number,
           branch,
           started_at,
           pr_url,
           vault_id,
           pid,
           status,
           phase
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .run(
        "completed-run",
        "acme/widgets",
        103,
        "agent/completed",
        "2026-04-24T03:00:00.000Z",
        null,
        null,
        null,
        "completed",
        null,
      );

    const dbModule = createDbModule(":memory:", {
      openDatabase: () => sharedDb,
    });
    dbModule.initDb();

    try {
      const statusesAfterInit = sharedDb
        .query<{ runId: string; status: string }>(
          `SELECT run_id AS runId, status
           FROM runs
           ORDER BY run_id ASC`,
        )
        .all();

      expect(statusesAfterInit).toEqual([
        { runId: "completed-run", status: "completed" },
        { runId: "queued-run", status: "queued" },
        { runId: "running-run", status: "running" },
      ]);

      expect(dbModule.resyncOrphanedRuns()).toEqual({ aborted: 2 });

      const statusesAfterResync = sharedDb
        .query<{ runId: string; status: string }>(
          `SELECT run_id AS runId, status
           FROM runs
           ORDER BY run_id ASC`,
        )
        .all();

      expect(statusesAfterResync).toEqual([
        { runId: "completed-run", status: "completed" },
        { runId: "queued-run", status: "aborted" },
        { runId: "running-run", status: "aborted" },
      ]);
    } finally {
      dbModule.close();
    }
  });

  test("running migration twice is idempotent", () => {
    const sharedDb = new Database(":memory:");
    const firstModule = createDbModule(":memory:", {
      openDatabase: () => sharedDb,
    });
    firstModule.initDb();

    const secondModule = createDbModule(":memory:", {
      openDatabase: () => sharedDb,
    });

    expect(() => secondModule.initDb()).not.toThrow();

    sharedDb.close();
  });
});
