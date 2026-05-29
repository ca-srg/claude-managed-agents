import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { type CreateAppOptions, createApp } from "@/features/dashboard/server";
import type { RepositoryChatAnthropicClient } from "@/features/repo-chat/handler";
import { createDbModule } from "@/shared/persistence/db";
import type { SessionClient, SessionResult } from "@/shared/session";
import type { RunState } from "@/shared/types";

type DbModule = ReturnType<typeof createDbModule>;

const openDbs: DbModule[] = [];

const PROCESSED_AT = "2026-04-27T00:00:00.000Z";

function createEmptySessionUsage(): SessionResult["usage"] {
  return {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    inputTokens: 0,
    modelRequestCount: 0,
    outputTokens: 0,
  };
}

function createIdleEvent(
  id: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.status_idle" }> {
  return {
    id,
    processed_at: PROCESSED_AT,
    stop_reason: { type: "end_turn" },
    type: "session.status_idle",
  };
}

function createAgentMessageEvent(
  id: string,
  text: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "agent.message" }> {
  return {
    content: [{ text, type: "text" }],
    id,
    processed_at: PROCESSED_AT,
    type: "agent.message",
  };
}

function asyncIterableOf<TEvent>(events: ReadonlyArray<TEvent>): AsyncIterable<TEvent> {
  return {
    [Symbol.asyncIterator]() {
      let cursorIndex = 0;
      return {
        async next(): Promise<IteratorResult<TEvent>> {
          if (cursorIndex >= events.length) {
            return { done: true, value: undefined };
          }
          const nextEvent = events[cursorIndex];
          cursorIndex += 1;
          if (typeof nextEvent === "undefined") {
            return { done: true, value: undefined };
          }
          return { done: false, value: nextEvent };
        },
        async return(): Promise<IteratorResult<TEvent>> {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function createFakeSessionClient(opts: {
  history?: ReadonlyArray<BetaManagedAgentsSessionEvent>;
  live?: ReadonlyArray<BetaManagedAgentsStreamSessionEvents>;
}): SessionClient {
  return {
    beta: {
      sessions: {
        events: {
          list() {
            return asyncIterableOf(opts.history ?? []);
          },
          async send() {
            return { ok: true };
          },
          async stream() {
            return asyncIterableOf(opts.live ?? []);
          },
        },
      },
    },
  };
}

function createFakeRepositoryChatClient(opts: {
  assistantText: string;
  sessionId?: string;
}): RepositoryChatAnthropicClient {
  const sessionId = opts.sessionId ?? "sesn-repo-chat-1";

  return {
    beta: {
      agents: {
        async create() {
          return { id: "agent-repo-chat", version: 1 };
        },
        async update() {
          return { id: "agent-repo-chat", version: 2 };
        },
      },
      environments: {
        async create() {
          return { id: "env-repo-chat" };
        },
        async update(id: string) {
          return { id };
        },
      },
      sessions: {
        async create() {
          return { id: sessionId };
        },
        async delete() {
          return { ok: true };
        },
        events: {
          list() {
            return asyncIterableOf([
              createAgentMessageEvent("evt-repo-chat-assistant", opts.assistantText),
            ]);
          },
          async send() {
            return { ok: true };
          },
          async stream() {
            return asyncIterableOf([]);
          },
        },
      },
    },
  } as RepositoryChatAnthropicClient;
}

function createFakeGitHubAuth(): NonNullable<CreateAppOptions["githubAuth"]> {
  return {
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
  } as unknown as NonNullable<CreateAppOptions["githubAuth"]>;
}

function createRepoChatForm(message: string): URLSearchParams {
  const formData = new URLSearchParams();
  formData.append("message", message);
  formData.append("includeSettings", "on");
  formData.append("includeMcp", "on");
  formData.append("includeRepository", "on");
  formData.append("includeRecentRuns", "on");
  return formData;
}

function createRunState(overrides: Partial<RunState> = {}): RunState {
  return {
    branch: "agent/issue-42/fix-login-flow",
    issueNumber: 42,
    repo: "acme/widgets",
    runId: "run-1",
    sessionIds: [],
    startedAt: "2026-04-24T10:00:00.000Z",
    subIssues: [],
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

function createAppWithSeededDb(
  seed?: (db: DbModule) => void,
  appOpts: Partial<Omit<CreateAppOptions, "db">> = {},
) {
  const db = createDbModule(":memory:");
  openDbs.push(db);
  db.initDb();
  seed?.(db);
  return { app: createApp({ db, ...appOpts }), db };
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe("createApp", () => {
  test("GET / returns 200 HTML containing repositories", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState());
    });

    const response = await app.request("/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('href="/repos/acme/widgets"');
  });

  test("GET / returns empty state when no runs exist", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("No runs yet");
  });

  test("GET /repositories returns 200 HTML containing repositories", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState());
    });

    const response = await app.request("/repositories");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('href="/repos/acme/widgets"');
  });

  test("GET /runs returns 200 HTML containing all runs", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-all-1" }));
      db.insertRun(createRunState({ repo: "acme/other", runId: "run-all-2" }));
    });

    const response = await app.request("/runs");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("run-all-");
    expect(body).toContain("acme/widgets");
    expect(body).toContain("acme/other");
  });

  test("GET /runs shows failed run error payload message", async () => {
    const failureMessage = [
      "Parent issue #21985 is closed.",
      "Action to fix: reopen the parent issue or choose an open issue number.",
    ].join("\n");
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-failed-list" }));
      db.setRunStatus("run-failed-list", "failed");
      db.insertRunEvent({
        id: "evt-failed-list-error",
        kind: "error",
        payload: { message: failureMessage, type: "preflight_failed" },
        runId: "run-failed-list",
        ts: "2026-04-24T10:01:00.000Z",
      });
    });

    const response = await app.request("/runs");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Parent issue #21985 is closed.");
    expect(body).toContain(
      "Action to fix: reopen the parent issue or choose an open issue number.",
    );
  });

  test("GET /runs reads failed run failure from bounded event tail", async () => {
    const { app, db } = createAppWithSeededDb((seedDb) => {
      seedDb.insertRun(createRunState({ runId: "run-failed-tail" }));
      seedDb.setRunStatus("run-failed-tail", "failed");

      for (let index = 0; index < 75; index += 1) {
        seedDb.insertRunEvent({
          id: `evt-failed-tail-${index.toString().padStart(3, "0")}`,
          kind: "log",
          payload: { message: `prior event ${index}` },
          runId: "run-failed-tail",
          ts: `2026-04-24T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
        });
      }

      seedDb.insertRunEvent({
        id: "evt-failed-tail-999",
        kind: "error",
        payload: { message: "Failure near the tail", type: "preflight_failed" },
        runId: "run-failed-tail",
        ts: "2026-04-24T11:00:00.000Z",
      });
    });
    const originalListRunEvents = db.listRunEvents;
    const listRunEventsCalls: Parameters<DbModule["listRunEvents"]>[0][] = [];
    db.listRunEvents = (opts) => {
      listRunEventsCalls.push(opts);
      return originalListRunEvents(opts);
    };

    const response = await app.request("/runs");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Failure near the tail");
    expect(listRunEventsCalls).toEqual([{ limit: 50, order: "desc", runId: "run-failed-tail" }]);
  });

  test("GET /assets/dashboard.css serves static assets from the configured directory", async () => {
    const staticAssetsDir = await mkdtemp(join(tmpdir(), "dashboard-assets-"));
    const css = ".dashboard { color: red; }\n";

    try {
      await writeFile(join(staticAssetsDir, "dashboard.css"), css);

      const { app } = createAppWithSeededDb(undefined, { staticAssetsDir });
      const response = await app.request("/assets/dashboard.css");
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain("text/css");
      expect(body).toBe(css);
    } finally {
      await rm(staticAssetsDir, { force: true, recursive: true });
    }
  });

  test("GET /repos/:owner/:name returns runs for that repo", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(
        createRunState({
          branch: "agent/issue-42/foo",
          subIssues: [{ issueId: 101, issueNumber: 43, taskId: "task-1" }],
        }),
      );
      db.setRunStatus("run-1", "running");
      db.insertRun(
        createRunState({
          repo: "acme/other",
          runId: "run-other",
          startedAt: "2026-04-24T11:00:00.000Z",
        }),
      );
    });

    const response = await app.request("/repos/acme/widgets");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("agent/issue-42/foo");
    expect(body).toContain("#42");
    expect(body).toContain("in-progress");
    expect(body).toContain('class="px-4 py-3 font-mono text-neutral-900">1</td>');
    expect(body).not.toContain("run-other");
  });

  test("GET /repos/:owner/:name returns empty state for unknown repos", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/repos/acme/widgets");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("No runs for acme/widgets");
  });

  test("GET /repos/:owner/:name/chat returns repository chat composer", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/repos/acme/widgets/chat");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Repository chat");
    expect(body).toContain('action="/repos/acme/widgets/chat"');
    expect(body).toContain('name="message"');
    expect(body).toContain("Context included");
  });

  test("POST /repos/:owner/:name/chat persists fallback messages when chat is unconfigured", async () => {
    const { app, db } = createAppWithSeededDb();

    const response = await app.request("/repos/acme/widgets/chat", {
      method: "POST",
      body: createRepoChatForm("How is this repository configured?"),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      redirect: "manual",
    });

    const threads = db.listRepoChatThreads("acme/widgets");
    expect(response.status).toBe(302);
    expect(threads).toHaveLength(1);
    expect(response.headers.get("Location")).toBe(
      `/repos/acme/widgets/chat?thread=${threads[0]?.id}`,
    );

    const messages = db.listRepoChatMessages(threads[0]?.id ?? "missing");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.content).toBe("How is this repository configured?");
    expect(messages[0]?.sessionId).toBeNull();
    expect(messages[1]?.content).toContain("Managed Agents chat is unavailable");
    expect(messages[1]?.sessionId).toBeNull();
  });

  test("POST /repos/:owner/:name/chat stores fake Managed Agents response", async () => {
    const chatSessionId = "sesn-repo-chat-fake";
    let runSessionCalls = 0;
    const { app, db } = createAppWithSeededDb(undefined, {
      githubAuth: createFakeGitHubAuth(),
      repoChat: {
        anthropicClient: createFakeRepositoryChatClient({
          assistantText: "Fake Managed Agents answer",
          sessionId: chatSessionId,
        }),
        ensureEnvironment: async () => ({
          created: true,
          environmentId: "env-repo-chat",
          hash: "repo-chat-env-hash",
        }),
        ensureEnvironmentForRepo: async () => ({
          created: true,
          environmentId: "env-repo-chat",
          hash: "repo-chat-env-hash",
          updated: false,
        }),
        ensureMcpCredentials: async () => [],
        ensureVault: async () => ({ managedByUs: false, vaultId: "vault-repo-chat" }),
        releaseVault: async () => {},
        runSession: async () => {
          runSessionCalls += 1;
          return createSessionResult({ sessionId: chatSessionId });
        },
      },
    });

    const response = await app.request("/repos/acme/widgets/chat", {
      method: "POST",
      body: createRepoChatForm("Please inspect the dashboard context."),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      redirect: "manual",
    });

    const threads = db.listRepoChatThreads("acme/widgets");
    expect(response.status).toBe(302);
    expect(threads).toHaveLength(1);
    expect(response.headers.get("Location")).toBe(
      `/repos/acme/widgets/chat?thread=${threads[0]?.id}`,
    );
    expect(runSessionCalls).toBe(1);

    const messages = db.listRepoChatMessages(threads[0]?.id ?? "missing");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.content).toBe("Please inspect the dashboard context.");
    expect(messages[1]?.content).toBe("Fake Managed Agents answer");
    expect(messages[1]?.sessionId).toBe(chatSessionId);
  });

  test("GET /runs/:runId returns run detail", async () => {
    const { app } = createAppWithSeededDb((db) => {
      const run = createRunState({
        runId: "run-detail-1",
        sessionIds: ["session-1"],
        subIssues: [{ issueId: 101, issueNumber: 43, taskId: "task-1" }],
      });

      db.insertRun(run);
      db.insertSession(
        run.runId,
        createSessionResult({
          sessionId: "session-1",
        }),
      );
    });

    const response = await app.request("/runs/run-detail-1");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("session metrics");
    expect(body).toContain("sub issues (1)");
    expect(body).toContain("task-1");
  });

  test("GET /runs/:runId shows failed run error payload message and type", async () => {
    const failureMessage = [
      "Parent issue #21985 is closed.",
      "Action to fix: reopen the parent issue or choose an open issue number.",
    ].join("\n");
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-failed-detail" }));
      db.setRunStatus("run-failed-detail", "failed");
      db.insertRunEvent({
        id: "evt-failed-detail-error",
        kind: "error",
        payload: { message: failureMessage, type: "preflight_failed" },
        runId: "run-failed-detail",
        ts: "2026-04-24T10:01:00.000Z",
      });
    });

    const response = await app.request("/runs/run-failed-detail");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Parent issue #21985 is closed.");
    expect(body).toContain(
      "Action to fix: reopen the parent issue or choose an open issue number.",
    );
    expect(body).toContain("preflight_failed");
  });

  test("GET /runs/:runId shows aborted complete error payload message and type", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-aborted-detail" }));
      db.setRunStatus("run-aborted-detail", "aborted");
      db.insertRunEvent({
        id: "evt-aborted-detail-complete",
        kind: "complete",
        payload: {
          aborted: true,
          error: { message: "Run was cancelled by operator", type: "operator_abort" },
          status: "aborted",
          timedOut: false,
        },
        runId: "run-aborted-detail",
        ts: "2026-04-24T10:01:00.000Z",
      });
    });

    const response = await app.request("/runs/run-aborted-detail");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Run was cancelled by operator");
    expect(body).toContain("operator_abort");
  });

  test("GET /runs/:runId/live returns live view with EventSource script", async () => {
    const { app } = createAppWithSeededDb((db) => {
      const run = createRunState({
        runId: "run-live-1",
        sessionIds: ["session-1"],
        subIssues: [{ issueId: 101, issueNumber: 43, taskId: "task-1" }],
      });

      db.insertRun(run);
    });

    const response = await app.request("/runs/run-live-1/live");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("live run");
    expect(body).toContain("run-live-1");
    expect(body).toContain("EventSource('/api/runs/' + encodeURIComponent(runId) + '/events')");
    expect(body).toContain("addEventListener('phase'");
    expect(body).toContain("addEventListener('session'");
    expect(body).toContain("addEventListener('subIssue'");
    expect(body).toContain("addEventListener('log'");
    expect(body).toContain("addEventListener('complete'");
    expect(body).toContain("addEventListener('error'");
  });

  test("GET /runs/:runId/live shows stop button when persisted status is running", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-live-2" }));
      db.setRunStatus("run-live-2", "running");
    });

    const response = await app.request("/runs/run-live-2/live");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('action="/api/runs/run-live-2/stop"');
    expect(body).toContain("stop this run");
    expect(body).toContain('style="display:block"');
    expect(body).toContain('id="run-status-badge"');
  });

  test("GET /runs/:runId/live hides stop button and shows PR URL when status is completed", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(
        createRunState({
          prUrl: "https://github.com/acme/widgets/pull/1",
          runId: "run-live-3",
        }),
      );
      db.setRunStatus("run-live-3", "completed");
    });

    const response = await app.request("/runs/run-live-3/live");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('style="display:none"');
    expect(body).toContain('id="pr-url-container"');
    expect(body).toContain('style="display:flex"');
    expect(body).toContain("acme/widgets/pull/1");
  });

  test("GET /runs/:runId/live returns 404 for unknown run", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/runs/nonexistent/live");
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Not Found");
    expect(body).toContain("nonexistent");
    expect(body).toContain("not found");
  });

  test("GET /runs/nonexistent returns 404", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/runs/nonexistent");
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Not Found");
    expect(body).toContain("nonexistent");
    expect(body).toContain("not found");
  });

  test("GET /unknown-path returns 404 with Not Found page", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/random/path");
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Not Found");
    expect(body).toContain("/random/path");
    expect(body).toContain("not found");
    expect(body).toContain("back to repositories");
  });

  test("GET /runs/new returns form HTML with all 5 fields", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/runs/new");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('name="issue"');
    expect(body).toContain('name="repo"');
    expect(body).toContain('name="dryRun"');
    expect(body).toContain('name="vaultId"');
    expect(body).toContain('name="configPath"');
  });

  test("POST /runs/new with valid body redirects to /runs/:id/live", async () => {
    const { app } = createAppWithSeededDb(undefined, {
      runQueue: {
        enqueue: () => ({ position: 1, runId: "run-new-1" }),
      },
    });

    const formData = new URLSearchParams();
    formData.append("issue", "42");
    formData.append("repo", "acme/widgets");
    formData.append("dryRun", "on");

    const response = await app.request("/runs/new", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      redirect: "manual",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/runs/run-new-1/live");
  });

  test("POST /runs/new with invalid body returns 400 with inline error", async () => {
    const { app } = createAppWithSeededDb(undefined, {
      runQueue: {
        enqueue: () => ({ position: 1, runId: "run-new-2" }),
      },
    });

    const formData = new URLSearchParams();
    formData.append("repo", "acme/widgets");

    const response = await app.request("/runs/new", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Issue number must be a positive integer.");
    expect(body).not.toContain("Expected number, received nan");
    expect(body).toContain('value="acme/widgets"');
  });

  test("POST /runs/new localizes validation errors", async () => {
    const { app } = createAppWithSeededDb(undefined, {
      runQueue: {
        enqueue: () => ({ position: 1, runId: "run-new-3" }),
      },
    });

    const formData = new URLSearchParams();
    formData.append("repo", "not-a-slug");

    const response = await app.request("/runs/new", {
      method: "POST",
      body: formData,
      headers: {
        "Accept-Language": "ja",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("Issue 番号は正の整数である必要があります");
    expect(body).toContain("リポジトリは owner/repository 形式で入力してください");
    expect(body).not.toContain("Expected number, received nan");
  });

  test("POST /runs/new without runQueue dep returns 503", async () => {
    const { app } = createAppWithSeededDb();

    const formData = new URLSearchParams();
    formData.append("issue", "42");
    formData.append("repo", "acme/widgets");

    const response = await app.request("/runs/new", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("runQueue is not configured for this dashboard");
  });

  test("GET /locale/:locale localizes unsupported locale errors", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/locale/fr", {
      headers: {
        "Accept-Language": "ja",
      },
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("サポートされていないロケール");
    expect(body).toContain("fr");
    expect(body).not.toContain("unsupported locale");
  });

  test("GET /mcp-servers hides unsupported confirmation-based policy", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/mcp-servers");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('name="permissionPolicy"');
    expect(body).toContain("always_allow");
    expect(body).not.toContain("always_ask");
  });

  test("POST /mcp-servers rejects unsupported confirmation-based policy", async () => {
    const { app, db } = createAppWithSeededDb();
    const formData = new URLSearchParams();
    formData.append("name", "linear");
    formData.append("url", "https://linear.example.com/mcp");
    formData.append("tokenEnvName", "LINEAR_TOKEN");
    formData.append("permissionPolicy", "always_ask");
    formData.append("enabled", "on");

    const response = await app.request("/mcp-servers", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("until tool confirmations are implemented");
    expect(db.getMcpServerByName("linear")).toBeNull();
  });

  test("POST /mcp-servers allows a remote server without token env", async () => {
    const { app, db } = createAppWithSeededDb();
    const formData = new URLSearchParams();
    formData.append("name", "public-docs");
    formData.append("url", "https://public-docs.example.com/mcp");
    formData.append("permissionPolicy", "always_allow");
    formData.append("enabled", "on");

    const response = await app.request("/mcp-servers", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/mcp-servers?notice=added");
    expect(db.getMcpServerByName("public-docs")?.tokenEnvName).toBe("");
  });

  test("POST /mcp-servers localizes invalid MCP form errors", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/mcp-servers", {
      method: "POST",
      body: new URLSearchParams(),
      headers: {
        "Accept-Language": "ja",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("MCP サーバーフォームの送信内容が不正です");
    expect(body).not.toContain("Invalid MCP server form submission");
  });

  test("POST /mcp-servers localizes unsupported permission policy errors", async () => {
    const { app } = createAppWithSeededDb();
    const formData = new URLSearchParams();
    formData.append("name", "linear");
    formData.append("url", "https://linear.example.com/mcp");
    formData.append("tokenEnvName", "LINEAR_TOKEN");
    formData.append("permissionPolicy", "always_ask");
    formData.append("enabled", "on");

    const response = await app.request("/mcp-servers", {
      method: "POST",
      body: formData,
      headers: {
        "Accept-Language": "ja",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("MCP 権限ポリシー");
    expect(body).toContain("利用できません");
  });

  test("POST /mcp-servers/:id rejects unsupported confirmation-based policy", async () => {
    const { app, db } = createAppWithSeededDb((db) => {
      db.createMcpServer({
        name: "linear",
        permissionPolicy: "always_allow",
        tokenEnvName: "LINEAR_TOKEN",
        url: "https://linear.example.com/mcp",
      });
    });
    const server = db.getMcpServerByName("linear");
    if (server === null) {
      throw new Error("expected test MCP server");
    }

    const formData = new URLSearchParams();
    formData.append("name", "linear");
    formData.append("url", "https://linear.example.com/mcp");
    formData.append("tokenEnvName", "LINEAR_TOKEN");
    formData.append("permissionPolicy", "always_ask");
    formData.append("enabled", "on");

    const response = await app.request(`/mcp-servers/${server.id}`, {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("until tool confirmations are implemented");
    expect(db.getMcpServerById(server.id)?.permissionPolicy).toBe("always_allow");
  });

  test("POST /mcp-servers/:id allows clearing token env", async () => {
    const { app, db } = createAppWithSeededDb((db) => {
      db.createMcpServer({
        name: "linear",
        tokenEnvName: "LINEAR_TOKEN",
        url: "https://linear.example.com/mcp",
      });
    });
    const server = db.getMcpServerByName("linear");
    if (server === null) {
      throw new Error("expected test MCP server");
    }

    const formData = new URLSearchParams();
    formData.append("name", server.name);
    formData.append("url", server.url);
    formData.append("tokenEnvName", "");
    formData.append("permissionPolicy", server.permissionPolicy);
    formData.append("enabled", "on");

    const response = await app.request(`/mcp-servers/${server.id}`, {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/mcp-servers/${server.id}?notice=updated`);
    expect(db.getMcpServerById(server.id)?.tokenEnvName).toBe("");
  });

  test("POST /mcp-servers/:id localizes duplicate-name update errors", async () => {
    const { app, db } = createAppWithSeededDb((db) => {
      db.createMcpServer({
        name: "linear",
        tokenEnvName: "LINEAR_TOKEN",
        url: "https://linear.example.com/mcp",
      });
      db.createMcpServer({
        name: "notion",
        tokenEnvName: "NOTION_TOKEN",
        url: "https://notion.example.com/mcp",
      });
    });
    const server = db.getMcpServerByName("notion");
    if (server === null) {
      throw new Error("expected test MCP server");
    }

    const formData = new URLSearchParams();
    formData.append("name", "linear");
    formData.append("url", server.url);
    formData.append("tokenEnvName", server.tokenEnvName);
    formData.append("permissionPolicy", server.permissionPolicy);
    formData.append("enabled", "on");

    const response = await app.request(`/mcp-servers/${server.id}`, {
      method: "POST",
      body: formData,
      headers: {
        "Accept-Language": "ja",
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("同じ名前の MCP サーバーがすでに存在します");
    expect(body).not.toContain('mcp server "linear" already exists');
    expect(db.getMcpServerById(server.id)?.name).toBe("notion");
  });

  test("POST /mcp-servers/:id rejects disabling builtin GitHub MCP via detail update", async () => {
    const { app, db } = createAppWithSeededDb();
    const server = db.getMcpServerByName("github");
    if (server === null) {
      throw new Error("expected builtin GitHub MCP server");
    }

    const formData = new URLSearchParams();
    formData.append("name", server.name);
    formData.append("url", server.url);
    formData.append("tokenEnvName", server.tokenEnvName);
    formData.append("permissionPolicy", "always_allow");

    const response = await app.request(`/mcp-servers/${server.id}`, {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("builtin GitHub MCP server cannot be disabled");
    expect(db.getMcpServerById(server.id)?.enabled).toBe(true);
  });

  test("POST /mcp-servers/:id/disable rejects builtin GitHub MCP", async () => {
    const { app, db } = createAppWithSeededDb();
    const server = db.getMcpServerByName("github");
    if (server === null) {
      throw new Error("expected builtin GitHub MCP server");
    }

    const response = await app.request(`/mcp-servers/${server.id}/disable`, {
      method: "POST",
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("builtin GitHub MCP server cannot be disabled");
    expect(db.getMcpServerById(server.id)?.enabled).toBe(true);
  });

  test("GET /runs/:runId/sessions/:sessionId/events/stream returns 404 for unknown run", async () => {
    const anthropicClient = createFakeSessionClient({});
    const { app } = createAppWithSeededDb(undefined, { anthropicClient });

    const response = await app.request("/runs/nonexistent/sessions/sesn-1/events/stream");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect((body as { error: string }).error).toContain("nonexistent");
  });

  test("GET /runs/:runId/sessions/:sessionId/events/stream returns 404 when session is not part of run", async () => {
    const anthropicClient = createFakeSessionClient({});
    const { app } = createAppWithSeededDb(
      (db) => {
        db.insertRun(
          createRunState({
            runId: "run-stream-1",
            sessionIds: ["sesn-known"],
          }),
        );
        db.insertSession("run-stream-1", createSessionResult({ sessionId: "sesn-known" }));
      },
      { anthropicClient },
    );

    const response = await app.request("/runs/run-stream-1/sessions/sesn-other/events/stream");
    const body = await response.json();

    expect(response.status).toBe(404);
    expect((body as { error: string }).error).toContain("sesn-other");
    expect((body as { error: string }).error).toContain("run-stream-1");
  });

  test("GET /runs/:runId/sessions/:sessionId/events/stream returns 503 when no anthropic client is configured", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(
        createRunState({
          runId: "run-stream-2",
          sessionIds: ["sesn-1"],
        }),
      );
      db.insertSession("run-stream-2", createSessionResult({ sessionId: "sesn-1" }));
    });

    const response = await app.request("/runs/run-stream-2/sessions/sesn-1/events/stream");
    const body = await response.json();

    expect(response.status).toBe(503);
    expect((body as { error: string }).error).toContain("live tail unavailable");
  });

  test("GET /runs/:runId/sessions/:sessionId/events/stream streams SSE events ending with idle", async () => {
    const anthropicClient = createFakeSessionClient({
      history: [createAgentMessageEvent("evt-h-1", "history hello")],
      live: [createAgentMessageEvent("evt-l-1", "live hello"), createIdleEvent("evt-idle")],
    });
    const { app } = createAppWithSeededDb(
      (db) => {
        db.insertRun(
          createRunState({
            runId: "run-stream-3",
            sessionIds: ["sesn-tail"],
          }),
        );
        db.insertSession("run-stream-3", createSessionResult({ sessionId: "sesn-tail" }));
      },
      { anthropicClient },
    );

    const response = await app.request("/runs/run-stream-3/sessions/sesn-tail/events/stream");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("Cache-Control")).toContain("no-cache");

    const text = await response.text();
    const dataLines = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { phase: string });
    const phases = dataLines.map((line) => line.phase);

    expect(phases).toContain("history");
    expect(phases).toContain("live");
    expect(phases[phases.length - 1]).toBe("end");
  });

  test("GET /runs/:runId returns liveTailEnabled=true UI elements when client is configured", async () => {
    const anthropicClient = createFakeSessionClient({});
    const { app } = createAppWithSeededDb(
      (db) => {
        db.insertRun(
          createRunState({
            runId: "run-stream-4",
            sessionIds: ["sesn-tail"],
            subIssues: [{ issueId: 101, issueNumber: 43, taskId: "task-1" }],
          }),
        );
        db.insertSession("run-stream-4", createSessionResult({ sessionId: "sesn-tail" }));
      },
      { anthropicClient },
    );

    const response = await app.request("/runs/run-stream-4");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("live tail");
    expect(body).toContain('data-live-tail-session="sesn-tail"');
    expect(body).not.toContain("ANTHROPIC_API_KEY was not configured");
  });

  test("GET /runs/:runId without anthropic client shows live tail unavailable notice", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(
        createRunState({
          runId: "run-stream-5",
          sessionIds: ["sesn-tail"],
          subIssues: [{ issueId: 101, issueNumber: 43, taskId: "task-1" }],
        }),
      );
      db.insertSession("run-stream-5", createSessionResult({ sessionId: "sesn-tail" }));
    });

    const response = await app.request("/runs/run-stream-5");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("live tail");
    expect(body).toContain("ANTHROPIC_API_KEY was not configured");
  });

  test("GET /runs/:runId shows stop button when persisted status is running", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-stop-1" }));
      db.setRunStatus("run-stop-1", "running");
    });

    const response = await app.request("/runs/run-stop-1");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('action="/api/runs/run-stop-1/stop"');
    expect(body).toContain("stop this run");
  });

  test("GET /runs/:runId hides stop button when persisted status is completed", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-stop-2" }));
      db.setRunStatus("run-stop-2", "completed");
    });

    const response = await app.request("/runs/run-stop-2");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain('action="/api/runs/run-stop-2/stop"');
  });

  test("GET /runs/:runId hides stop button when run already has a PR url", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(
        createRunState({
          prUrl: "https://github.com/acme/widgets/pull/1",
          runId: "run-stop-3",
        }),
      );
      db.setRunStatus("run-stop-3", "completed");
    });

    const response = await app.request("/runs/run-stop-3");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain('action="/api/runs/run-stop-3/stop"');
  });

  test("GET /runs/:runId?stop=stopped ignores legacy stop notice query", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-stop-4" }));
    });

    const response = await app.request("/runs/run-stop-4?stop=stopped");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("stop-notice-success");
    expect(body).not.toContain("orchestrator process exited");
  });

  test("GET /runs/:runId?stop=still_running_after_signal ignores legacy stop notice query", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-stop-5" }));
    });

    const response = await app.request("/runs/run-stop-5?stop=still_running_after_signal");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("stop-notice-error");
    expect(body).not.toContain("did not exit after SIGTERM");
  });

  // --- GitHub Issue auto-trigger management ---

  test("GET /repos/:owner/:name renders trigger section with default mention/label when not configured", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState());
    });

    const response = await app.request("/repos/acme/widgets");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("GitHub Issue auto-trigger");
    expect(body).toContain("Not polled yet");
    expect(body).toContain('action="/polled-repos"');
    expect(body).toContain('value="acme/widgets"');
    expect(body).toContain("@bot run");
    expect(body).toContain("agent-run");
  });

  test("GET /repos/:owner/:name reflects polled+enabled state with pause and remove actions", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState());
      db.addPolledRepository("acme/widgets");
    });

    const response = await app.request("/repos/acme/widgets");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Polling active");
    expect(body).toContain('action="/repos/acme/widgets/trigger/disable"');
    expect(body).toContain('action="/repos/acme/widgets/trigger/remove"');
    expect(body).toContain("Pause polling");
    expect(body).toContain("Remove from polled list");
  });

  test("GET /repos/:owner/:name reflects paused state with resume and remove actions", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState());
      db.addPolledRepository("acme/widgets");
      db.setPolledRepositoryEnabled("acme/widgets", false);
    });

    const response = await app.request("/repos/acme/widgets");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("Polling paused");
    expect(body).toContain('action="/repos/acme/widgets/trigger/enable"');
    expect(body).toContain('action="/repos/acme/widgets/trigger/remove"');
    expect(body).toContain("Resume polling");
  });

  test("GET /repositories shows polled-only repos that have no runs yet", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.addPolledRepository("acme/freshly-watched");
    });

    const response = await app.request("/repositories");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('href="/repos/acme/freshly-watched"');
    expect(body).toContain("polled");
  });

  test("GET /repositories distinguishes paused polled repos with the warning badge label", async () => {
    const { app } = createAppWithSeededDb((db) => {
      db.insertRun(createRunState({ runId: "run-paused-1" }));
      db.addPolledRepository("acme/widgets");
      db.setPolledRepositoryEnabled("acme/widgets", false);
    });

    const response = await app.request("/repositories");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("polled (paused)");
  });

  test("GET /repositories renders the add polled repository form with default trigger labels", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/repositories");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('action="/polled-repos"');
    expect(body).toContain("Watch a repository for auto-trigger");
    expect(body).toContain('placeholder="acme/widgets"');
  });

  test("POST /polled-repos with new slug adds repo and redirects to detail page", async () => {
    const { app, db } = createAppWithSeededDb();

    const formData = new URLSearchParams();
    formData.append("repo", "acme/widgets");

    const response = await app.request("/polled-repos", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/repos/acme/widgets?trigger=added");
    const polled = db.getPolledRepository("acme/widgets");
    expect(polled?.enabled).toBe(true);
  });

  test("POST /polled-repos for an existing repo redirects with trigger=exists without flipping enabled", async () => {
    const { app, db } = createAppWithSeededDb((db) => {
      db.addPolledRepository("acme/widgets");
      db.setPolledRepositoryEnabled("acme/widgets", false);
    });

    const formData = new URLSearchParams();
    formData.append("repo", "acme/widgets");

    const response = await app.request("/polled-repos", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/repos/acme/widgets?trigger=exists");
    // The "add" action is intentionally idempotent and does NOT re-enable a
    // disabled repo — that requires the explicit enable route.
    expect(db.getPolledRepository("acme/widgets")?.enabled).toBe(false);
  });

  test("POST /polled-repos with invalid slug returns 400", async () => {
    const { app } = createAppWithSeededDb();

    const formData = new URLSearchParams();
    formData.append("repo", "not-a-slug");

    const response = await app.request("/polled-repos", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("Bad Request");
    expect(body).toContain("not-a-slug");
  });

  test("POST /polled-repos with empty repo returns 400", async () => {
    const { app } = createAppWithSeededDb();

    const formData = new URLSearchParams();
    formData.append("repo", "");

    const response = await app.request("/polled-repos", {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    expect(response.status).toBe(400);
  });

  test("POST /repos/:owner/:name/trigger/enable re-enables a disabled polled repo", async () => {
    const { app, db } = createAppWithSeededDb((db) => {
      db.addPolledRepository("acme/widgets");
      db.setPolledRepositoryEnabled("acme/widgets", false);
    });

    const response = await app.request("/repos/acme/widgets/trigger/enable", {
      method: "POST",
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/repos/acme/widgets?trigger=enabled");
    expect(db.getPolledRepository("acme/widgets")?.enabled).toBe(true);
  });

  test("POST /repos/:owner/:name/trigger/enable returns 404 when repo is not polled", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/repos/acme/widgets/trigger/enable", {
      method: "POST",
    });
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).toContain("not in the polled list");
  });

  test("POST /repos/:owner/:name/trigger/disable pauses a polled repo without removing dedupe history", async () => {
    const { app, db } = createAppWithSeededDb((db) => {
      db.addPolledRepository("acme/widgets");
    });

    const response = await app.request("/repos/acme/widgets/trigger/disable", {
      method: "POST",
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/repos/acme/widgets?trigger=disabled");
    const polled = db.getPolledRepository("acme/widgets");
    expect(polled).not.toBeNull();
    expect(polled?.enabled).toBe(false);
  });

  test("POST /repos/:owner/:name/trigger/disable returns 404 when repo is not polled", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/repos/acme/widgets/trigger/disable", {
      method: "POST",
    });

    expect(response.status).toBe(404);
  });

  test("POST /repos/:owner/:name/trigger/remove deletes the polled row idempotently", async () => {
    const { app, db } = createAppWithSeededDb((db) => {
      db.addPolledRepository("acme/widgets");
    });

    const first = await app.request("/repos/acme/widgets/trigger/remove", {
      method: "POST",
      redirect: "manual",
    });
    expect(first.status).toBe(302);
    expect(first.headers.get("Location")).toBe("/repos/acme/widgets?trigger=removed");
    expect(db.getPolledRepository("acme/widgets")).toBeNull();

    // Idempotent: removing a repo that is no longer polled still redirects
    // back to the detail page rather than 404'ing the user.
    const second = await app.request("/repos/acme/widgets/trigger/remove", {
      method: "POST",
      redirect: "manual",
    });
    expect(second.status).toBe(302);
    expect(second.headers.get("Location")).toBe("/repos/acme/widgets?trigger=removed");
  });

  test("POST /repos/:owner/:name/trigger/{enable,disable,remove} 404s for malformed slugs", async () => {
    const { app } = createAppWithSeededDb();

    // The persistence RepoSlugSchema rejects names that start or end with
    // punctuation (`.`/`-`/`_`) — those should be surfaced as 404s before
    // any DB lookup runs.
    for (const action of ["enable", "disable", "remove"] as const) {
      const response = await app.request(`/repos/.bad-owner/-bad-name/trigger/${action}`, {
        method: "POST",
      });
      expect(response.status).toBe(404);
    }
  });

  test("POST /runs/:runId/stop forwards legacy stop posts to the API endpoint", async () => {
    const { app } = createAppWithSeededDb();

    const response = await app.request("/runs/missing/stop", {
      method: "POST",
      redirect: "manual",
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/api/runs/missing/stop");
  });
});
