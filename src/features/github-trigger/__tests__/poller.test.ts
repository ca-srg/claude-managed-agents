import { afterEach, describe, expect, test } from "bun:test";

import type { IssueCommentLike, IssueEventLike } from "@/features/github-trigger/detector";
import {
  createGithubTriggerPoller,
  type GithubTriggerPollerDeps,
  type IssuesClientLike,
} from "@/features/github-trigger/poller";
import type { GithubTriggerConfig, GithubTriggerSource } from "@/features/github-trigger/schemas";
import { createDbModule } from "@/shared/persistence/db";

type DbModule = ReturnType<typeof createDbModule>;

const REPO = "acme/widgets";
const REPO_2 = "acme/gadgets";

const openDbs: DbModule[] = [];

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

function makeDb(opts: { polledRepos?: string[] } = {}): DbModule {
  const db = createDbModule(":memory:");
  db.initDb();
  for (const repo of opts.polledRepos ?? [REPO]) {
    db.addPolledRepository(repo);
  }
  openDbs.push(db);
  return db;
}

function makeConfig(overrides: Partial<GithubTriggerConfig> = {}): GithubTriggerConfig {
  return {
    botMention: "bot",
    intervalMs: 60_000,
    triggerLabel: "agent-run",
    ...overrides,
  };
}

type CommentResp = { data: IssueCommentLike[] };
type EventResp = { data: IssueEventLike[] };

type FakeClient = IssuesClientLike & {
  calls: {
    comments: Array<{ owner: string; repo: string; since?: string }>;
    events: Array<{ owner: string; repo: string }>;
  };
};

function makeClient(
  options: {
    comments?: Record<string, CommentResp[]>;
    events?: Record<string, EventResp[]>;
    failRepos?: Set<string>;
  } = {},
): FakeClient {
  const calls: FakeClient["calls"] = { comments: [], events: [] };
  const commentQueues = new Map<string, CommentResp[]>(Object.entries(options.comments ?? {}));
  const eventQueues = new Map<string, EventResp[]>(Object.entries(options.events ?? {}));
  const failures = options.failRepos ?? new Set<string>();

  function takeNextComment(key: string): CommentResp {
    const queue = commentQueues.get(key);
    const next = queue?.shift();
    return next ?? { data: [] };
  }

  function takeNextEvent(key: string): EventResp {
    const queue = eventQueues.get(key);
    const next = queue?.shift();
    return next ?? { data: [] };
  }

  return {
    calls,
    rest: {
      issues: {
        async listCommentsForRepo(params) {
          const key = `${params.owner}/${params.repo}`;
          calls.comments.push({ owner: params.owner, repo: params.repo, since: params.since });
          if (failures.has(key)) {
            throw new Error(`forced failure for ${key}`);
          }
          return takeNextComment(key);
        },
        async listEventsForRepo(params) {
          const key = `${params.owner}/${params.repo}`;
          calls.events.push({ owner: params.owner, repo: params.repo });
          if (failures.has(key)) {
            throw new Error(`forced failure for ${key}`);
          }
          return takeNextEvent(key);
        },
      },
    },
  };
}

function comment(overrides: Partial<IssueCommentLike> & { id: number }): IssueCommentLike {
  return {
    body: "@bot run",
    html_url: `https://github.com/${REPO}/issues/${42}#issuecomment-${overrides.id}`,
    issue_url: `https://api.github.com/repos/${REPO}/issues/42`,
    ...overrides,
  };
}

function labeledEvent(
  overrides: Partial<IssueEventLike> & { id: number; createdAt?: string },
): IssueEventLike {
  const { createdAt, ...rest } = overrides;
  return {
    created_at: createdAt ?? "2026-04-30T12:00:00Z",
    event: "labeled",
    issue: { number: 42, pull_request: undefined },
    label: { name: "agent-run" },
    ...rest,
  };
}

type EnqueueRecord = { issue: number; repo: string; runId: string };

function makeEnqueue(): {
  enqueue: GithubTriggerPollerDeps["enqueue"];
  records: EnqueueRecord[];
} {
  let counter = 0;
  const records: EnqueueRecord[] = [];

  const enqueue: GithubTriggerPollerDeps["enqueue"] = (input) => {
    counter += 1;
    const runId = `run-${counter}`;
    records.push({ issue: input.issue, repo: input.repo, runId });
    return { position: counter, runId };
  };

  return { enqueue, records };
}

function isProcessed(
  db: DbModule,
  source: GithubTriggerSource,
  repo: string,
  sourceId: string,
): boolean {
  return db.hasProcessedTriggerSource(`${source}:${repo}:${sourceId}`);
}

// Tests pin the polling clock so the label-event `since` filter is
// deterministic regardless of the wall clock when the suite runs.
const FIXED_INITIAL_SINCE = new Date("2026-04-30T11:00:00.000Z");
const FIXED_NOW = new Date("2026-04-30T13:00:00.000Z");

describe("createGithubTriggerPoller pollOnce", () => {
  test("enqueues comment and label triggers in a single cycle", async () => {
    const db = makeDb();
    const { enqueue, records } = makeEnqueue();
    const client = makeClient({
      comments: {
        [REPO]: [
          {
            data: [
              comment({ body: "@bot run", id: 100 }),
              comment({ body: "irrelevant comment", id: 101 }),
            ],
          },
        ],
      },
      events: {
        [REPO]: [{ data: [labeledEvent({ id: 200 })] }],
      },
    });

    const poller = createGithubTriggerPoller({
      client,
      config: makeConfig(),
      db,
      enqueue,
      initialSince: FIXED_INITIAL_SINCE,
      now: () => FIXED_NOW,
    });

    const summary = await poller.pollOnce();
    expect(summary).toEqual({ enqueued: 2, errors: 0, matched: 2 });
    expect(records).toEqual([
      { issue: 42, repo: REPO, runId: "run-1" },
      { issue: 42, repo: REPO, runId: "run-2" },
    ]);
    expect(isProcessed(db, "comment", REPO, "100")).toBe(true);
    expect(isProcessed(db, "label", REPO, "200")).toBe(true);
  });

  test("dedupes comment triggers across cycles", async () => {
    const db = makeDb();
    const { enqueue, records } = makeEnqueue();
    const client = makeClient({
      comments: {
        [REPO]: [
          { data: [comment({ id: 100 })] },
          // The fake ignores the API's `since` filter, so the same comment
          // appears in both responses and the dedupe must catch it.
          { data: [comment({ id: 100 })] },
        ],
      },
    });

    const poller = createGithubTriggerPoller({
      client,
      config: makeConfig(),
      db,
      enqueue,
      initialSince: FIXED_INITIAL_SINCE,
      now: () => FIXED_NOW,
    });

    const first = await poller.pollOnce();
    const second = await poller.pollOnce();

    expect(first).toEqual({ enqueued: 1, errors: 0, matched: 1 });
    expect(second).toEqual({ enqueued: 0, errors: 0, matched: 1 });
    expect(records).toHaveLength(1);
  });

  test("dedupes label triggers within the same cycle", async () => {
    const db = makeDb();
    const { enqueue, records } = makeEnqueue();
    const client = makeClient({
      events: {
        [REPO]: [
          {
            data: [labeledEvent({ id: 200 }), labeledEvent({ id: 200 })],
          },
        ],
      },
    });

    const poller = createGithubTriggerPoller({
      client,
      config: makeConfig(),
      db,
      enqueue,
      initialSince: FIXED_INITIAL_SINCE,
      now: () => FIXED_NOW,
    });

    const summary = await poller.pollOnce();
    expect(summary).toEqual({ enqueued: 1, errors: 0, matched: 2 });
    expect(records).toHaveLength(1);
  });

  test("filters out PR comments before enqueueing", async () => {
    const db = makeDb();
    const { enqueue, records } = makeEnqueue();
    const client = makeClient({
      comments: {
        [REPO]: [
          {
            data: [
              comment({
                html_url: `https://github.com/${REPO}/pull/42#issuecomment-1`,
                id: 100,
              }),
            ],
          },
        ],
      },
    });

    const poller = createGithubTriggerPoller({
      client,
      config: makeConfig(),
      db,
      enqueue,
    });

    const summary = await poller.pollOnce();
    expect(summary).toEqual({ enqueued: 0, errors: 0, matched: 0 });
    expect(records).toEqual([]);
  });

  test("filters labeled events older than the per-repo since cursor", async () => {
    const db = makeDb();
    const { enqueue, records } = makeEnqueue();
    const baseline = new Date("2026-04-30T12:00:00.000Z");
    const client = makeClient({
      events: {
        [REPO]: [
          {
            data: [
              // Older than baseline — should be skipped.
              labeledEvent({ createdAt: "2026-04-30T11:59:00.000Z", id: 200 }),
              // Newer than baseline — should be enqueued.
              labeledEvent({ createdAt: "2026-04-30T12:00:30.000Z", id: 201 }),
            ],
          },
        ],
      },
    });

    const poller = createGithubTriggerPoller({
      client,
      config: makeConfig(),
      db,
      enqueue,
      initialSince: baseline,
      now: () => new Date("2026-04-30T12:01:00.000Z"),
    });

    const summary = await poller.pollOnce();
    expect(summary).toEqual({ enqueued: 1, errors: 0, matched: 1 });
    expect(records).toEqual([{ issue: 42, repo: REPO, runId: "run-1" }]);
  });

  test("isolates failures so other repositories continue to poll", async () => {
    const db = makeDb({ polledRepos: [REPO, REPO_2] });
    const { enqueue, records } = makeEnqueue();
    const client = makeClient({
      comments: {
        [REPO_2]: [
          {
            data: [
              comment({ id: 300, issue_url: `https://api.github.com/repos/${REPO_2}/issues/7` }),
            ],
          },
        ],
      },
      failRepos: new Set([REPO]),
    });

    const poller = createGithubTriggerPoller({
      client,
      config: makeConfig(),
      db,
      enqueue,
    });

    const summary = await poller.pollOnce();
    expect(summary.errors).toBe(1);
    expect(summary.enqueued).toBe(1);
    expect(records).toEqual([{ issue: 7, repo: REPO_2, runId: "run-1" }]);
  });

  test("resolves a GitHub client for each polled repository", async () => {
    const db = makeDb({ polledRepos: [REPO, REPO_2] });
    const { enqueue, records } = makeEnqueue();
    const widgetsClient = makeClient({
      comments: {
        [REPO]: [{ data: [comment({ id: 100 })] }],
      },
    });
    const gadgetsClient = makeClient({
      comments: {
        [REPO_2]: [
          {
            data: [
              comment({
                html_url: `https://github.com/${REPO_2}/issues/7#issuecomment-200`,
                id: 200,
                issue_url: `https://api.github.com/repos/${REPO_2}/issues/7`,
              }),
            ],
          },
        ],
      },
    });
    const resolveCalls: Array<{ owner: string; repo: string }> = [];

    const poller = createGithubTriggerPoller({
      config: makeConfig(),
      db,
      enqueue,
      initialSince: FIXED_INITIAL_SINCE,
      now: () => FIXED_NOW,
      resolveClient: async (repoRef) => {
        resolveCalls.push(repoRef);
        return repoRef.repo === "widgets" ? widgetsClient : gadgetsClient;
      },
    });

    const summary = await poller.pollOnce();

    expect(summary).toEqual({ enqueued: 2, errors: 0, matched: 2 });
    expect(resolveCalls).toHaveLength(2);
    expect(resolveCalls).toContainEqual({ owner: "acme", repo: "widgets" });
    expect(resolveCalls).toContainEqual({ owner: "acme", repo: "gadgets" });
    const enqueuedRepos = records.map(({ issue, repo }) => ({ issue, repo }));
    expect(enqueuedRepos).toHaveLength(2);
    expect(enqueuedRepos).toContainEqual({ issue: 42, repo: REPO });
    expect(enqueuedRepos).toContainEqual({ issue: 7, repo: REPO_2 });
    expect(widgetsClient.calls.comments).toEqual([
      { owner: "acme", repo: "widgets", since: "2026-04-30T11:00:00.000Z" },
    ]);
    expect(gadgetsClient.calls.comments).toEqual([
      { owner: "acme", repo: "gadgets", since: "2026-04-30T11:00:00.000Z" },
    ]);
  });

  test("picks up newly added polled repositories on the next cycle", async () => {
    const db = makeDb({ polledRepos: [REPO] });
    const { enqueue, records } = makeEnqueue();
    const client = makeClient({
      comments: {
        [REPO_2]: [
          {
            data: [
              comment({ id: 400, issue_url: `https://api.github.com/repos/${REPO_2}/issues/9` }),
            ],
          },
        ],
      },
    });

    const poller = createGithubTriggerPoller({
      client,
      config: makeConfig(),
      db,
      enqueue,
      initialSince: FIXED_INITIAL_SINCE,
      now: () => FIXED_NOW,
    });

    const first = await poller.pollOnce();
    expect(first.matched).toBe(0);
    expect(records).toEqual([]);

    db.addPolledRepository(REPO_2);

    const second = await poller.pollOnce();
    expect(second.enqueued).toBe(1);
    expect(records).toEqual([{ issue: 9, repo: REPO_2, runId: "run-1" }]);
  });

  test("skips repositories whose trigger is disabled", async () => {
    const db = makeDb({ polledRepos: [REPO] });
    db.setPolledRepositoryEnabled(REPO, false);

    const { enqueue, records } = makeEnqueue();
    const client = makeClient({
      comments: {
        [REPO]: [{ data: [comment({ id: 500 })] }],
      },
    });

    const poller = createGithubTriggerPoller({
      client,
      config: makeConfig(),
      db,
      enqueue,
      initialSince: FIXED_INITIAL_SINCE,
      now: () => FIXED_NOW,
    });

    const summary = await poller.pollOnce();
    expect(summary).toEqual({ enqueued: 0, errors: 0, matched: 0 });
    expect(client.calls.comments).toEqual([]);
    expect(records).toEqual([]);
  });

  test("uses the previous cycle timestamp as the next since cursor", async () => {
    const db = makeDb();
    const { enqueue } = makeEnqueue();
    const client = makeClient();
    let nowCounter = 0;
    const stamps = [
      new Date("2026-04-30T12:00:00.000Z"),
      new Date("2026-04-30T12:01:00.000Z"),
      new Date("2026-04-30T12:02:00.000Z"),
    ];

    const poller = createGithubTriggerPoller({
      client,
      config: makeConfig(),
      db,
      enqueue,
      initialSince: new Date("2026-04-30T11:00:00.000Z"),
      now: () => {
        const next = stamps[Math.min(nowCounter, stamps.length - 1)];
        nowCounter += 1;
        return next ?? new Date();
      },
    });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(client.calls.comments[0]?.since).toBe("2026-04-30T11:00:00.000Z");
    // Second cycle uses the timestamp from when the first cycle started.
    expect(client.calls.comments[1]?.since).toBe("2026-04-30T12:01:00.000Z");
  });
});

describe("createGithubTriggerPoller lifecycle", () => {
  test("start runs cycles continuously until stop", async () => {
    const db = makeDb();
    const { enqueue, records } = makeEnqueue();
    const client = makeClient({
      comments: {
        [REPO]: [
          { data: [comment({ id: 100 })] },
          { data: [comment({ id: 101 })] },
          { data: [] },
          { data: [] },
        ],
      },
    });

    let resolveSecondSleep: (() => void) | undefined;
    const sleepCalls: number[] = [];

    const poller = createGithubTriggerPoller({
      client,
      config: makeConfig({ intervalMs: 1_000 }),
      db,
      enqueue,
      sleep: (ms, signal) => {
        sleepCalls.push(ms);
        return new Promise((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          if (sleepCalls.length === 1) {
            // After the first cycle, allow the loop to immediately schedule
            // the second cycle.
            resolve();
          } else {
            // Hold the loop on the second sleep so the test can stop the
            // poller deterministically.
            resolveSecondSleep = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          }
        });
      },
    });

    poller.start();
    // Wait for the loop to reach the second sleep call.
    while (resolveSecondSleep === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    await poller.stop();

    expect(records.map((r) => r.issue)).toEqual([42, 42]);
    expect(sleepCalls.every((ms) => ms === 1_000)).toBe(true);
  });

  test("stop is idempotent", async () => {
    const db = makeDb();
    const { enqueue } = makeEnqueue();
    const client = makeClient();
    const poller = createGithubTriggerPoller({
      client,
      config: makeConfig(),
      db,
      enqueue,
    });

    await poller.stop();
    await poller.stop();
  });
});
