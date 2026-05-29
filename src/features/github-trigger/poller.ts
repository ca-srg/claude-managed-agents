import type { Logger } from "pino";

import {
  detectCommentTrigger,
  detectLabelTrigger,
  type IssueCommentLike,
  type IssueEventLike,
} from "@/features/github-trigger/detector";
import {
  dedupeKeyOf,
  type GithubTriggerCandidate,
  type GithubTriggerConfig,
  type GithubTriggerSource,
} from "@/features/github-trigger/schemas";

/**
 * Subset of Octokit's `rest.issues` surface that the poller actually uses.
 *
 * Defining this shape locally lets tests substitute a fake without depending
 * on Octokit's heavy generic types. The real Octokit client satisfies this
 * interface structurally for the parameters we pass.
 */
export type IssuesListClient = {
  listCommentsForRepo: (params: {
    direction?: "asc" | "desc";
    owner: string;
    per_page?: number;
    repo: string;
    since?: string;
    sort?: "created" | "updated";
  }) => Promise<{ data: IssueCommentLike[] }>;
  listEventsForRepo: (params: {
    owner: string;
    per_page?: number;
    repo: string;
  }) => Promise<{ data: IssueEventLike[] }>;
};

export type IssuesClientLike = {
  rest: { issues: IssuesListClient };
};

/**
 * Database surface required by the poller. A subset of `createDbModule`'s
 * public API to make wiring and testing explicit.
 */
export type GithubTriggerDb = {
  hasProcessedTriggerSource: (dedupeKey: string) => boolean;
  /**
   * Returns the WebUI-managed list of repositories that should currently be
   * polled. The poller calls this at the top of every cycle so adds/removes
   * surface in at most one interval.
   */
  listPolledRepositories: (opts?: { enabledOnly?: boolean }) => Array<{ repo: string }>;
  markTriggerSourceProcessed: (input: {
    dedupeKey: string;
    issueNumber: number;
    repo: string;
    runId: string | null;
    source: GithubTriggerSource;
    sourceId: string;
  }) => void;
};

export type GithubTriggerEnqueue = (input: { issue: number; repo: string }) => {
  position: number;
  runId: string;
};

export type GithubTriggerPollerDeps = {
  client?: IssuesClientLike;
  config: GithubTriggerConfig;
  db: GithubTriggerDb;
  enqueue: GithubTriggerEnqueue;
  /**
   * Optional initial `since` cursor per repo. Defaults to the poller start
   * time minus `intervalMs` so the first cycle picks up events from the
   * previous interval window.
   */
  initialSince?: Date;
  logger?: Logger;
  /** Injection seam for tests that want deterministic timestamps. */
  now?: () => Date;
  resolveClient?: (repo: { owner: string; repo: string }) => Promise<IssuesClientLike>;
  /** Injection seam for tests that want to control sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type PollSummary = {
  /** Number of trigger candidates successfully enqueued in this cycle. */
  enqueued: number;
  /** Number of repositories whose poll attempt threw. */
  errors: number;
  /** Number of trigger candidates considered (including dedupe hits). */
  matched: number;
};

export type GithubTriggerPoller = {
  /** Runs a single poll cycle against the configured repositories. */
  pollOnce: () => Promise<PollSummary>;
  start: () => void;
  stop: () => Promise<void>;
};

const DEFAULT_PER_PAGE = 100;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };

    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function splitRepo(repo: string): { owner: string; repoName: string } {
  const slashIndex = repo.indexOf("/");
  if (slashIndex <= 0 || slashIndex === repo.length - 1) {
    throw new Error(`invalid repo slug: ${repo}`);
  }

  return {
    owner: repo.slice(0, slashIndex),
    repoName: repo.slice(slashIndex + 1),
  };
}

function parseEventTimestamp(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function createGithubTriggerPoller(deps: GithubTriggerPollerDeps): GithubTriggerPoller {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const lastSinceByRepo = new Map<string, Date>();
  const startTime = now();
  const baselineSince = deps.initialSince ?? new Date(startTime.getTime() - deps.config.intervalMs);

  let started = false;
  let abortController: AbortController | undefined;
  let loopPromise: Promise<void> | undefined;

  /**
   * Reconciles the in-memory `lastSinceByRepo` cursor map with the active
   * repo set fetched from the DB at the start of each cycle. Newly added
   * repos pick up `baselineSinceFor` so the first cycle has bounded scope;
   * removed repos drop their cursor so memory does not grow unbounded if a
   * repo is added/removed many times.
   */
  function reconcileRepoCursors(activeRepos: string[], cycleStartedAt: Date): void {
    const active = new Set(activeRepos);
    for (const repo of activeRepos) {
      if (!lastSinceByRepo.has(repo)) {
        const fallback = new Date(cycleStartedAt.getTime() - deps.config.intervalMs);
        // Use the longer-back baseline if the poller is still in its first
        // few cycles so freshly added repos don't miss recent events.
        lastSinceByRepo.set(
          repo,
          baselineSince.getTime() < fallback.getTime() ? baselineSince : fallback,
        );
      }
    }
    for (const repo of [...lastSinceByRepo.keys()]) {
      if (!active.has(repo)) {
        lastSinceByRepo.delete(repo);
      }
    }
  }

  function tryEnqueue(candidate: GithubTriggerCandidate): boolean {
    const dedupeKey = dedupeKeyOf(candidate);
    if (deps.db.hasProcessedTriggerSource(dedupeKey)) {
      deps.logger?.debug(
        {
          dedupeKey,
          issueNumber: candidate.issueNumber,
          repo: candidate.repo,
          source: candidate.source,
        },
        "github trigger dedupe hit; skipping",
      );
      return false;
    }

    let runId: string | null = null;

    try {
      const enqueueResult = deps.enqueue({
        issue: candidate.issueNumber,
        repo: candidate.repo,
      });
      runId = enqueueResult.runId;
      deps.logger?.info(
        {
          issueNumber: candidate.issueNumber,
          position: enqueueResult.position,
          reason: candidate.reason,
          repo: candidate.repo,
          runId,
          source: candidate.source,
        },
        "github trigger enqueued run",
      );
    } catch (err) {
      deps.logger?.warn(
        { err, issueNumber: candidate.issueNumber, repo: candidate.repo, source: candidate.source },
        "github trigger enqueue failed",
      );
      // Persist dedupe even on enqueue failure so the same comment/event is
      // not retried indefinitely; the failure is already surfaced through
      // the logger and operators can intervene.
    }

    deps.db.markTriggerSourceProcessed({
      dedupeKey,
      issueNumber: candidate.issueNumber,
      repo: candidate.repo,
      runId,
      source: candidate.source,
      sourceId: candidate.sourceId,
    });

    return runId !== null;
  }

  async function pollRepo(repo: string, cycleStartedAt: Date): Promise<PollSummary> {
    const { owner, repoName } = splitRepo(repo);
    const client = deps.resolveClient
      ? await deps.resolveClient({ owner, repo: repoName })
      : deps.client;
    if (!client) {
      throw new Error("GitHub trigger poller requires client or resolveClient");
    }
    const issuesClient = client.rest.issues;
    const since = lastSinceByRepo.get(repo) ?? baselineSince;
    const sinceIso = since.toISOString();

    let matched = 0;
    let enqueued = 0;

    const commentResp = await issuesClient.listCommentsForRepo({
      direction: "asc",
      owner,
      per_page: DEFAULT_PER_PAGE,
      repo: repoName,
      since: sinceIso,
      sort: "created",
    });

    for (const comment of commentResp.data) {
      const candidate = detectCommentTrigger(comment, { botMention: deps.config.botMention });
      if (candidate === null) {
        continue;
      }

      matched += 1;
      if (tryEnqueue(candidate)) {
        enqueued += 1;
      }
    }

    const eventResp = await issuesClient.listEventsForRepo({
      owner,
      per_page: DEFAULT_PER_PAGE,
      repo: repoName,
    });

    for (const event of eventResp.data) {
      const eventTimestamp = parseEventTimestamp(event.created_at);
      // The repository issue events endpoint doesn't accept `since`, so we
      // filter client-side. Treat events without a timestamp as eligible to
      // avoid silently dropping data; dedupe will protect against replays.
      if (eventTimestamp !== null && eventTimestamp.getTime() < since.getTime()) {
        continue;
      }

      const candidate = detectLabelTrigger(event, { triggerLabel: deps.config.triggerLabel }, repo);
      if (candidate === null) {
        continue;
      }

      matched += 1;
      if (tryEnqueue(candidate)) {
        enqueued += 1;
      }
    }

    lastSinceByRepo.set(repo, cycleStartedAt);

    return { enqueued, errors: 0, matched };
  }

  async function pollOnce(): Promise<PollSummary> {
    const cycleStartedAt = now();
    const summary: PollSummary = { enqueued: 0, errors: 0, matched: 0 };
    const activeRepos = deps.db
      .listPolledRepositories({ enabledOnly: true })
      .map((row) => row.repo);

    reconcileRepoCursors(activeRepos, cycleStartedAt);

    for (const repo of activeRepos) {
      try {
        const repoSummary = await pollRepo(repo, cycleStartedAt);
        summary.enqueued += repoSummary.enqueued;
        summary.matched += repoSummary.matched;
      } catch (err) {
        summary.errors += 1;
        deps.logger?.warn({ err, repo }, "github trigger poll failed for repo");
      }
    }

    return summary;
  }

  async function loop(signal: AbortSignal): Promise<void> {
    while (started && !signal.aborted) {
      try {
        await pollOnce();
      } catch (err) {
        deps.logger?.error({ err }, "github trigger pollOnce threw");
      }

      if (!started || signal.aborted) {
        return;
      }

      await sleep(deps.config.intervalMs, signal);
    }
  }

  function start(): void {
    if (started) {
      return;
    }

    started = true;
    abortController = new AbortController();
    const signal = abortController.signal;
    deps.logger?.info(
      {
        botMention: deps.config.botMention,
        intervalMs: deps.config.intervalMs,
        triggerLabel: deps.config.triggerLabel,
      },
      "github trigger poller started",
    );
    loopPromise = loop(signal).catch((err) => {
      deps.logger?.error({ err }, "github trigger poller loop crashed");
    });
  }

  async function stop(): Promise<void> {
    if (!started) {
      return;
    }

    started = false;
    abortController?.abort();
    if (loopPromise !== undefined) {
      await loopPromise;
      loopPromise = undefined;
    }
    deps.logger?.info("github trigger poller stopped");
  }

  return {
    pollOnce,
    start,
    stop,
  };
}
