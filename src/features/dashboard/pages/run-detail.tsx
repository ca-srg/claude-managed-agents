/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { StatCard } from "@/features/dashboard/components/stat-card";
import { StatusBadge } from "@/features/dashboard/components/status-badge";
import { t } from "@/features/dashboard/i18n";
import type { RunFailure } from "@/features/dashboard/run-failure";
import { sessionConsoleUrl } from "@/shared/constants";
import type { SessionUsageRow, UsageAggregate } from "@/shared/persistence/schemas";
import { formatTokens, formatUsd, totalTokenVolume } from "@/shared/pricing";
import { fallbackRunOrigin, originShortDisplay, originUrl } from "@/shared/run-origin";
import type { SessionResult } from "@/shared/session";
import type { RunState, RunStatus } from "@/shared/types";

export type StopNotice = {
  kind: "success" | "error" | "info";
  message: string;
};

export type RunDetailPageProps = {
  failure?: RunFailure;
  run: RunState;
  status: RunStatus;
  sessions: SessionResult[];
  sessionUsages: SessionUsageRow[];
  usageAggregate: UsageAggregate;
  liveTailEnabled?: boolean;
  stopNotice?: StopNotice;
  /** Claude Console workspace slug used to deep-link recorded sessions. */
  consoleWorkspace?: string;
};

function isRunStoppable(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

export const RunDetailPage: FC<RunDetailPageProps> = (props) => {
  const { run } = props;
  const shortRunId = run.runId.slice(0, 8);
  const liveTailEnabled = props.liveTailEnabled ?? false;
  const stoppable = isRunStoppable(props.status);
  // The first recorded session is the parent (coordinator) thread, so it is the
  // natural entry point into this run's trace on the Claude Console.
  const primarySessionId = run.sessionIds[0];
  const consoleHref =
    primarySessionId === undefined
      ? undefined
      : sessionConsoleUrl(primarySessionId, props.consoleWorkspace);
  return (
    <Layout title={`${t("run")} ${shortRunId}`} activeNav="run-detail">
      <section class="space-y-8">
        <header class="space-y-2">
          <nav class="flex items-center space-x-2 text-sm text-neutral-500">
            <a href="/" class="hover:text-neutral-900 transition-colors">
              {t("repositories")}
            </a>
            <span class="text-neutral-300">/</span>
            <a href={`/repos/${run.repo}`} class="hover:text-neutral-900 transition-colors">
              {run.repo}
            </a>
            <span class="text-neutral-300">/</span>
            <span class="font-mono font-medium text-neutral-900">{shortRunId}</span>
          </nav>
          <h1 class="text-3xl font-bold tracking-tight text-neutral-900 font-mono">
            {t("run")}{" "}
            {consoleHref ? (
              <a
                href={consoleHref}
                target="_blank"
                rel="noopener noreferrer"
                title={t("open session in Claude Console")}
                class="text-brand-600 hover:text-brand-700 hover:underline"
              >
                {shortRunId}
              </a>
            ) : (
              <span class="text-brand-600">{shortRunId}</span>
            )}
          </h1>
        </header>

        {props.stopNotice && <StopNoticeBanner notice={props.stopNotice} />}
        {props.failure && <RunFailureBanner failure={props.failure} />}

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <aside class="space-y-6 lg:col-span-1">
            <RunSummaryCard run={run} />
            <RunUsageSummaryCard usage={props.usageAggregate} />
            {stoppable && <StopRunCard runId={run.runId} />}
            <SessionMetricsSection sessions={props.sessions} sessionUsages={props.sessionUsages} />
          </aside>
          <section class="space-y-8 lg:col-span-2">
            <SubIssuesSection run={run} />
            <LiveTailSection
              enabled={liveTailEnabled}
              runId={run.runId}
              sessionIds={run.sessionIds}
            />
          </section>
        </div>
      </section>
      {liveTailEnabled && run.sessionIds.length > 0 ? <LiveTailScript /> : null}
    </Layout>
  );
};

const StopNoticeBanner: FC<{ notice: StopNotice }> = ({ notice }) => {
  const variants = {
    success: "bg-success-50 text-success-900 border-success-200",
    error: "bg-danger-50 text-danger-900 border-danger-200",
    info: "bg-info-50 text-info-900 border-info-200",
  };
  return (
    <div
      class={`p-4 rounded-lg border ${variants[notice.kind]} stop-notice-${notice.kind}`}
      role="status"
    >
      {notice.message}
    </div>
  );
};

const RunFailureBanner: FC<{ failure: RunFailure }> = ({ failure }) => (
  <div class="rounded-xl border border-danger-200 bg-danger-50 p-4 text-danger-900" role="alert">
    <div class="space-y-2">
      <div class="text-sm font-semibold">{t("failure details")}</div>
      {failure.type && (
        <dl class="flex flex-wrap items-center gap-2 text-xs">
          <dt class="font-medium text-danger-700">{t("failure type")}</dt>
          <dd class="break-words rounded-md border border-danger-200 bg-surface/70 px-2 py-0.5 font-mono text-danger-800">
            {failure.type}
          </dd>
        </dl>
      )}
      <pre class="whitespace-pre-wrap break-words font-mono text-sm leading-6">
        {failure.message}
      </pre>
    </div>
  </div>
);

const StopRunCard: FC<{ runId: string }> = ({ runId }) => (
  <div class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
    <h2 class="text-lg font-semibold text-neutral-900">{t("stop run")}</h2>
    <p class="text-sm text-neutral-500">
      {t("Requests cancellation through the run queue and waits for the run to stop.")}
    </p>
    <form method="post" action={`/api/runs/${runId}/stop`}>
      <button
        type="submit"
        class="w-full px-4 py-2 text-sm font-medium text-danger-700 bg-danger-50 border border-danger-200 rounded-md hover:bg-danger-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-danger-500 transition-colors"
      >
        {t("stop this run")}
      </button>
    </form>
  </div>
);

const RunSummaryCard: FC<{ run: RunState }> = ({ run }) => {
  const [owner, name] = run.repo.split("/");
  const origin = fallbackRunOrigin(run);
  const originHref = origin ? originUrl(origin) : undefined;
  const originLabel = origin ? originShortDisplay(origin) : "—";
  return (
    <div class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
      <h2 class="text-lg font-semibold text-neutral-900">{t("overview")}</h2>
      <dl class="space-y-3">
        <Kv
          label="runId"
          value={<code class="font-mono text-sm text-neutral-900">{run.runId}</code>}
        />
        <Kv
          label={t("repo")}
          value={
            <a
              href={`https://github.com/${run.repo}`}
              target="_blank"
              rel="noopener noreferrer"
              class="font-mono text-sm text-brand-600 hover:text-brand-700"
            >
              {owner}/{name}
            </a>
          }
        />
        <Kv
          label={t("origin")}
          value={
            originHref ? (
              <a
                href={originHref}
                target="_blank"
                rel="noopener noreferrer"
                class="font-mono text-sm text-brand-600 hover:text-brand-700"
              >
                {originLabel}
              </a>
            ) : (
              <span class="font-mono text-sm text-neutral-400">—</span>
            )
          }
        />
        <Kv
          label={t("branch")}
          value={<code class="font-mono text-sm text-neutral-500">{run.branch}</code>}
        />
        <Kv
          label={t("started")}
          value={
            <time class="font-mono text-sm text-neutral-500" datetime={run.startedAt}>
              {run.startedAt}
            </time>
          }
        />
        <Kv
          label={t("sessions")}
          value={<span class="font-mono text-sm text-neutral-900">{run.sessionIds.length}</span>}
        />
        <Kv
          label={t("sub issues")}
          value={<span class="font-mono text-sm text-neutral-900">{run.subIssues.length}</span>}
        />
        <Kv
          label={t("pr")}
          value={
            run.prUrl ? (
              <a
                href={run.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="font-mono text-sm text-brand-600 hover:text-brand-700"
              >
                {run.prUrl.replace("https://github.com/", "")}
              </a>
            ) : (
              <span class="text-neutral-400">—</span>
            )
          }
        />
      </dl>
    </div>
  );
};

const RunUsageSummaryCard: FC<{ usage: UsageAggregate }> = ({ usage }) => {
  const tokenVolume = totalTokenVolume(usage);
  const hasUsage = usage.modelRequestCount > 0;
  return (
    <div class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
      <div class="space-y-1">
        <h2 class="text-lg font-semibold text-neutral-900">{t("usage")}</h2>
        {!hasUsage && <p class="text-sm text-neutral-500">{t("no usage recorded yet")}</p>}
      </div>
      <dl class="grid grid-cols-2 gap-3">
        <UsageTile
          label={t("total cost")}
          value={usage.costUsd > 0 ? formatUsd(usage.costUsd) : "—"}
          emphasis
        />
        <UsageTile
          label={t("tokens")}
          value={tokenVolume > 0 ? formatTokens(tokenVolume) : "—"}
          emphasis
        />
        <UsageTile label={t("input")} value={formatPositiveTokens(usage.inputTokens)} />
        <UsageTile label={t("output")} value={formatPositiveTokens(usage.outputTokens)} />
        <UsageTile
          label={t("cache create")}
          value={formatPositiveTokens(usage.cacheCreationInputTokens)}
        />
        <UsageTile
          label={t("cache read")}
          value={formatPositiveTokens(usage.cacheReadInputTokens)}
        />
        <UsageTile
          label={t("model requests")}
          value={usage.modelRequestCount > 0 ? usage.modelRequestCount : "—"}
        />
      </dl>
    </div>
  );
};

const UsageTile: FC<{ label: string; value: string | number; emphasis?: boolean }> = ({
  emphasis = false,
  label,
  value,
}) => (
  <div class="rounded-lg border border-neutral-200 bg-surface-muted px-3 py-2">
    <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">{label}</dt>
    <dd
      class={`mt-1 font-mono font-semibold ${
        emphasis ? "text-xl text-neutral-900" : "text-sm text-neutral-700"
      }`}
    >
      {value}
    </dd>
  </div>
);

const Kv: FC<{ label: string; value: Child }> = ({ label, value }) => (
  <div class="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1">
    <dt class="text-sm font-medium text-neutral-500">{label}</dt>
    <dd class="text-sm text-neutral-900">{value}</dd>
  </div>
);

const SessionMetricsSection: FC<{
  sessions: SessionResult[];
  sessionUsages: SessionUsageRow[];
}> = ({ sessionUsages, sessions }) => {
  if (sessions.length === 0) {
    return (
      <div class="space-y-4">
        <h2 class="text-lg font-semibold text-neutral-900">{t("session metrics")}</h2>
        <div class="text-sm text-neutral-500 italic">{t("no sessions recorded")}</div>
      </div>
    );
  }
  const usageRowsBySessionId = groupSessionUsages(sessionUsages);
  return (
    <div class="space-y-4">
      <h2 class="text-lg font-semibold text-neutral-900">{t("session metrics")}</h2>
      <div class="space-y-3">
        {sessions.map((s, idx) => {
          const usageRows = usageRowsBySessionId.get(s.sessionId) ?? [];
          const tokenVolume = usageRows.reduce((sum, usage) => sum + totalTokenVolume(usage), 0);
          const costUsd = usageRows.reduce((sum, usage) => sum + usage.costUsd, 0);
          return (
            <details
              class="group bg-surface border border-neutral-200 rounded-xl overflow-hidden"
              open={idx === 0}
            >
              <summary class="flex items-center justify-between p-4 cursor-pointer bg-surface hover:bg-neutral-50 transition-colors select-none">
                <span class="font-mono text-sm font-medium text-neutral-900">
                  {s.sessionId.slice(0, 12)}…
                </span>
                <span class="font-mono text-xs text-neutral-500">
                  {(s.durationMs / 1000).toFixed(1)}s · {s.eventsProcessed} {t("events")}
                </span>
              </summary>
              <div class="p-4 border-t border-neutral-200 bg-surface-muted grid grid-cols-2 gap-4">
                <StatCard label={t("events")} value={s.eventsProcessed} />
                <StatCard label={t("tool calls")} value={s.toolInvocations} />
                <StatCard
                  label={t("tool errors")}
                  value={s.toolErrors}
                  variant={s.toolErrors > 0 ? "warning" : "default"}
                />
                <StatCard label={t("duration")} value={`${(s.durationMs / 1000).toFixed(1)}s`} />
                <StatCard
                  label={t("tokens")}
                  value={tokenVolume > 0 ? formatTokens(tokenVolume) : "—"}
                />
                <StatCard label={t("cost")} value={costUsd > 0 ? formatUsd(costUsd) : "—"} />
                <div class="col-span-2">
                  <MiniBar
                    label={t("errors / calls")}
                    ratio={s.toolInvocations > 0 ? s.toolErrors / s.toolInvocations : 0}
                    variant={s.toolErrors > 0 ? "danger" : "success"}
                  />
                </div>
                <div class="col-span-2">
                  <SessionUsageBreakdown rows={usageRows} />
                </div>
                <div class="col-span-2 flex flex-wrap gap-2">
                  {s.aborted && <StatusBadge status="failure" label="aborted" />}
                  {s.errored && <StatusBadge status="failure" label="errored" />}
                  {s.timedOut && <StatusBadge status="failure" label="timed out" />}
                  {s.idleReached && <StatusBadge status="info" label="idle reached" />}
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
};

const SessionUsageBreakdown: FC<{ rows: SessionUsageRow[] }> = ({ rows }) => {
  if (rows.length === 0) {
    return (
      <div class="rounded-lg border border-dashed border-neutral-200 bg-surface px-3 py-2 text-sm text-neutral-500">
        {t("no usage recorded yet")}
      </div>
    );
  }

  return (
    <div class="space-y-2">
      <div class="text-xs font-medium text-neutral-500 uppercase tracking-wider">
        {t("model usage")}
      </div>
      {rows.map((row) => {
        const tokenVolume = totalTokenVolume(row);
        return (
          <div class="rounded-lg border border-neutral-200 bg-surface px-3 py-3 space-y-3">
            <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <span class="inline-flex w-fit items-center rounded-md border border-brand-200 bg-brand-50 px-2 py-0.5 font-mono text-xs font-medium text-brand-700">
                {row.model}
              </span>
              <span class="font-mono text-sm font-semibold text-neutral-900">
                {row.costUsd > 0 ? formatUsd(row.costUsd) : "—"}
              </span>
            </div>
            <dl class="grid grid-cols-2 gap-x-4 gap-y-2">
              <TinyUsageStat label={t("tokens")} value={formatPositiveTokens(tokenVolume)} />
              <TinyUsageStat label={t("requests")} value={row.modelRequestCount || "—"} />
              <TinyUsageStat label={t("input")} value={formatPositiveTokens(row.inputTokens)} />
              <TinyUsageStat label={t("output")} value={formatPositiveTokens(row.outputTokens)} />
              <TinyUsageStat
                label={t("cache create")}
                value={formatPositiveTokens(row.cacheCreationInputTokens)}
              />
              <TinyUsageStat
                label={t("cache read")}
                value={formatPositiveTokens(row.cacheReadInputTokens)}
              />
            </dl>
          </div>
        );
      })}
    </div>
  );
};

const TinyUsageStat: FC<{ label: string; value: string | number }> = ({ label, value }) => (
  <div>
    <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">{label}</dt>
    <dd class="mt-0.5 font-mono text-xs text-neutral-900">{value}</dd>
  </div>
);

function groupSessionUsages(sessionUsages: SessionUsageRow[]): Map<string, SessionUsageRow[]> {
  const grouped = new Map<string, SessionUsageRow[]>();
  for (const usage of sessionUsages) {
    const rows = grouped.get(usage.sessionId);
    if (rows) {
      rows.push(usage);
    } else {
      grouped.set(usage.sessionId, [usage]);
    }
  }
  return grouped;
}

function formatPositiveTokens(count: number): string {
  return count > 0 ? formatTokens(count) : "—";
}

const MiniBar: FC<{ label: string; ratio: number; variant: "success" | "warning" | "danger" }> = ({
  label,
  ratio,
  variant,
}) => {
  const percent = Math.min(100, Math.max(0, ratio * 100));
  const trackColors = {
    success: "bg-success-500",
    warning: "bg-warning-500",
    danger: "bg-danger-500",
  };
  return (
    <div class="space-y-1">
      <div class="flex justify-between text-xs">
        <span class="font-medium text-neutral-500">{label}</span>
        <span class="font-mono text-neutral-900">{percent.toFixed(1)}%</span>
      </div>
      <div class="h-2 w-full bg-neutral-200 rounded-full overflow-hidden">
        <div
          class={`h-full ${trackColors[variant]} transition-all duration-500`}
          style={`width: ${percent.toFixed(1)}%`}
        />
      </div>
    </div>
  );
};

// Per-task child results were tracked by the legacy `spawn_child_task` custom
// tool. Under Managed Agents' coordinator topology, sub-agent activity surfaces
// via `agent.thread_*` events streamed into the live tail / run-events feed
// instead of being persisted as discrete result rows. The detail page now only
// renders the sub-issue list itself; per-task commit / files / test output
// reappear once the thread-events UI lands.
const SubIssuesSection: FC<{ run: RunState }> = ({ run }) => {
  if (run.subIssues.length === 0) {
    return (
      <div class="space-y-4">
        <h2 class="text-xl font-semibold text-neutral-900">{t("sub issues")}</h2>
        <div class="text-sm text-neutral-500 italic">{t("no sub issues created yet")}</div>
      </div>
    );
  }
  return (
    <div class="space-y-4">
      <h2 class="text-xl font-semibold text-neutral-900">
        {t("sub issues")} ({run.subIssues.length})
      </h2>
      <div class="space-y-3">
        {run.subIssues.map((sub) => (
          <SubIssueCard run={run} subIssue={sub} />
        ))}
      </div>
    </div>
  );
};

const SubIssueCard: FC<{
  run: RunState;
  subIssue: RunState["subIssues"][number];
}> = ({ run, subIssue }) => {
  return (
    <article class="bg-surface border border-neutral-200 rounded-xl overflow-hidden shadow-sm">
      <header class="flex items-center justify-between p-4 bg-surface-muted">
        <div class="flex items-center space-x-3">
          <span class="font-mono text-sm font-medium text-neutral-900">{subIssue.taskId}</span>
          <a
            href={`https://github.com/${run.repo}/issues/${subIssue.issueNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono text-sm text-brand-600 hover:text-brand-700"
          >
            #{subIssue.issueNumber}
          </a>
        </div>
        <StatusBadge status="pending" />
      </header>
    </article>
  );
};

const LiveTailSection: FC<{ enabled: boolean; runId: string; sessionIds: string[] }> = ({
  enabled,
  runId,
  sessionIds,
}) => {
  if (sessionIds.length === 0) {
    return (
      <div class="space-y-4">
        <h2 class="text-xl font-semibold text-neutral-900">{t("live tail")}</h2>
        <div class="text-sm text-neutral-500 italic">{t("no sessions to tail")}</div>
      </div>
    );
  }
  return (
    <div class="space-y-4" data-live-tail-root data-run-id={runId}>
      <h2 class="text-xl font-semibold text-neutral-900">{t("live tail")}</h2>
      {!enabled && (
        <div class="p-3 bg-warning-50 border border-warning-200 text-warning-800 text-sm rounded-lg">
          {t("live tail is unavailable: ANTHROPIC_API_KEY was not configured when starting")}{" "}
          <code class="font-mono bg-warning-100 px-1 py-0.5 rounded">serve</code>
        </div>
      )}
      <noscript>
        <div class="p-3 bg-neutral-50 border border-neutral-200 text-neutral-600 text-sm rounded-lg">
          {t("live tail requires JavaScript. Use")}{" "}
          <code class="font-mono bg-neutral-200 px-1 py-0.5 rounded">--log-level debug</code> on the
          {t("on the CLI to inspect events from the terminal instead.")}
        </div>
      </noscript>
      <div class="space-y-3">
        {sessionIds.map((sessionId) => (
          <details
            class="group bg-surface border border-neutral-200 rounded-xl overflow-hidden"
            data-live-tail-session={sessionId}
          >
            <summary class="flex items-center justify-between p-4 cursor-pointer bg-surface hover:bg-neutral-50 transition-colors select-none">
              <span class="font-mono text-sm font-medium text-neutral-900">
                {sessionId.slice(0, 12)}…
              </span>
              <span class="text-xs text-neutral-500" data-live-tail-status>
                {t("click to start tailing")}
              </span>
            </summary>
            <div class="border-t border-neutral-200">
              <div class="flex items-center gap-2 p-2 bg-surface-muted border-b border-neutral-200">
                <button
                  type="button"
                  class="px-3 py-1.5 text-xs font-medium text-brand-700 bg-brand-50 border border-brand-200 rounded hover:bg-brand-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  data-live-tail-btn="start"
                  disabled={!enabled}
                >
                  {t("start")}
                </button>
                <button
                  type="button"
                  class="px-3 py-1.5 text-xs font-medium text-neutral-700 bg-surface border border-neutral-200 rounded hover:bg-neutral-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  data-live-tail-btn="stop"
                  disabled
                >
                  {t("stop")}
                </button>
                <button
                  type="button"
                  class="px-3 py-1.5 text-xs font-medium text-neutral-700 bg-surface border border-neutral-200 rounded hover:bg-neutral-50 transition-colors"
                  data-live-tail-btn="clear"
                >
                  {t("clear")}
                </button>
                <a
                  class="ml-auto px-3 py-1.5 text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
                  href={`/runs/${runId}/sessions/${sessionId}/events/stream`}
                >
                  {t("raw stream")}
                </a>
              </div>
              <pre
                class="p-4 bg-neutral-950 text-neutral-700 font-mono text-xs h-96 overflow-y-auto whitespace-pre-wrap break-words"
                data-live-tail-log
              >
                {""}
              </pre>
            </div>
          </details>
        ))}
      </div>
    </div>
  );
};

const LIVE_TAIL_CLIENT_SCRIPT = `(()=>{const root=document.querySelector("[data-live-tail-root]");if(!root)return;const runId=root.getAttribute("data-run-id");const blocks=root.querySelectorAll("[data-live-tail-session]");const MAX_LINES=500;function fmt(payload){try{const o=JSON.parse(payload);if(o.phase==="history"||o.phase==="live"){const e=o.event||{};const t=e.type||"unknown";const id=(e.id||"").slice(-8);const head="["+o.phase+" "+t+" "+id+"]";let body="";if(t==="agent.message"&&Array.isArray(e.content)){body=e.content.filter(b=>b&&b.type==="text").map(b=>b.text).join("\\n");}else if(t==="agent.custom_tool_use"){body=e.name+" "+JSON.stringify(e.input||{});}else if(t==="user.custom_tool_result"){const txt=Array.isArray(e.content)?e.content.filter(b=>b&&b.type==="text").map(b=>b.text).join("\\n"):"";body=(e.is_error?"ERROR ":"")+txt;}else{body=JSON.stringify(e);}return head+" "+body;}if(o.phase==="end")return"[end "+o.reason+"]";if(o.phase==="error")return"[error] "+o.message;return payload;}catch(_){return payload;}}blocks.forEach(block=>{const sessionId=block.getAttribute("data-live-tail-session");const startBtn=block.querySelector('[data-live-tail-btn="start"]');const stopBtn=block.querySelector('[data-live-tail-btn="stop"]');const clearBtn=block.querySelector('[data-live-tail-btn="clear"]');const status=block.querySelector("[data-live-tail-status]");const log=block.querySelector("[data-live-tail-log]");let es=null;function setStatus(s){if(status)status.textContent=s;}function append(line){if(!log)return;log.textContent+=line+"\\n";const lines=log.textContent.split("\\n");if(lines.length>MAX_LINES){log.textContent=lines.slice(-MAX_LINES).join("\\n");}log.scrollTop=log.scrollHeight;}function stop(){if(es){es.close();es=null;}if(startBtn)startBtn.disabled=false;if(stopBtn)stopBtn.disabled=true;}function start(){if(es||!startBtn||startBtn.disabled)return;const url="/runs/"+encodeURIComponent(runId)+"/sessions/"+encodeURIComponent(sessionId)+"/events/stream";es=new EventSource(url);startBtn.disabled=true;if(stopBtn)stopBtn.disabled=false;setStatus("connecting…");es.onopen=()=>setStatus("streaming");es.onmessage=ev=>{append(fmt(ev.data));try{const o=JSON.parse(ev.data);if(o.phase==="end"){setStatus("ended ("+o.reason+")");stop();}else if(o.phase==="error"){setStatus("error: "+o.message);}}catch(_){}};es.onerror=()=>{setStatus("disconnected");stop();};}if(startBtn)startBtn.addEventListener("click",start);if(stopBtn)stopBtn.addEventListener("click",stop);if(clearBtn)clearBtn.addEventListener("click",()=>{if(log)log.textContent="";});});})();`;

const LiveTailScript: FC = () => (
  <script type="module" dangerouslySetInnerHTML={{ __html: LIVE_TAIL_CLIENT_SCRIPT }} />
);
