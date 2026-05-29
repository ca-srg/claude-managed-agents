/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { RunLiveScript } from "@/features/dashboard/components/run-live-script";
import { StatusBadge } from "@/features/dashboard/components/status-badge";
import { t } from "@/features/dashboard/i18n";
import { fallbackRunOrigin, originShortDisplay, originUrl } from "@/shared/run-origin";
import type { SessionResult } from "@/shared/session";
import type { RunPhase, RunState, RunStatus } from "@/shared/types";

export type RunLivePageProps = {
  run: RunState;
  status: RunStatus;
  sessions: SessionResult[];
};

const PHASES: RunPhase[] = [
  "preflight",
  "environment",
  "vault",
  "lock",
  "session_start",
  "decomposition",
  "child_execution",
  "finalize_pr",
  "cleanup",
];

function statusBadgeForRunStatus(
  status: RunStatus,
): "success" | "failure" | "in-progress" | "pending" {
  if (status === "completed") {
    return "success";
  }

  if (status === "failed" || status === "aborted") {
    return "failure";
  }

  if (status === "running") {
    return "in-progress";
  }

  return "pending";
}

export const RunLivePage: FC<RunLivePageProps> = (props) => {
  const { run, status } = props;
  const shortRunId = run.runId.slice(0, 8);
  const [owner, name] = run.repo.split("/");
  const origin = fallbackRunOrigin(run);
  const originHref = origin ? originUrl(origin) : undefined;
  const originLabel = origin ? originShortDisplay(origin) : "—";
  const isRunning = status === "queued" || status === "running";
  const badgeStatus = statusBadgeForRunStatus(status);

  return (
    <Layout title={`${t("live run")} ${shortRunId}`} activeNav="runs">
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
            <a href={`/runs/${run.runId}`} class="hover:text-neutral-900 transition-colors">
              {shortRunId}
            </a>
            <span class="text-neutral-300">/</span>
            <span class="font-mono font-medium text-neutral-900">{t("live")}</span>
          </nav>
          <div class="flex items-center justify-between">
            <h1 class="text-3xl font-bold tracking-tight text-neutral-900 font-mono">
              {t("live run")} <span class="text-brand-600">{shortRunId}</span>
            </h1>
            <StatusBadge id="run-status-badge" status={badgeStatus} label={status} />
          </div>
        </header>

        <div
          id="error-banner"
          class="hidden p-4 rounded-lg border bg-danger-50 text-danger-900 border-danger-200"
          role="alert"
        >
          <div class="font-medium">{t("Error")}</div>
          <div id="error-banner-message" class="text-sm mt-1 font-mono"></div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <aside class="space-y-6 lg:col-span-1">
            <div class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
              <h2 class="text-lg font-semibold text-neutral-900">{t("overview")}</h2>
              <dl class="space-y-3">
                <div class="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1">
                  <dt class="text-sm font-medium text-neutral-500">runId</dt>
                  <dd class="text-sm text-neutral-900">
                    <code class="font-mono text-sm text-neutral-900">{run.runId}</code>
                  </dd>
                </div>
                <div class="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1">
                  <dt class="text-sm font-medium text-neutral-500">{t("repo")}</dt>
                  <dd class="text-sm text-neutral-900">
                    <a
                      href={`https://github.com/${run.repo}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="font-mono text-sm text-brand-600 hover:text-brand-700"
                    >
                      {owner}/{name}
                    </a>
                  </dd>
                </div>
                <div class="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1">
                  <dt class="text-sm font-medium text-neutral-500">{t("origin")}</dt>
                  <dd class="text-sm text-neutral-900">
                    {originHref ? (
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
                    )}
                  </dd>
                </div>
                <div class="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1">
                  <dt class="text-sm font-medium text-neutral-500">{t("branch")}</dt>
                  <dd class="text-sm text-neutral-900">
                    <code class="font-mono text-sm text-neutral-500">{run.branch}</code>
                  </dd>
                </div>
                <div class="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1">
                  <dt class="text-sm font-medium text-neutral-500">{t("started")}</dt>
                  <dd class="text-sm text-neutral-900">
                    <time class="font-mono text-sm text-neutral-500" datetime={run.startedAt}>
                      {run.startedAt}
                    </time>
                  </dd>
                </div>
                <div
                  id="pr-url-container"
                  class="flex flex-col sm:flex-row sm:justify-between sm:items-baseline gap-1"
                  style={{ display: run.prUrl ? "flex" : "none" }}
                >
                  <dt class="text-sm font-medium text-neutral-500">{t("pr")}</dt>
                  <dd class="text-sm text-neutral-900">
                    <a
                      id="pr-url-link"
                      href={run.prUrl || "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="font-mono text-sm text-brand-600 hover:text-brand-700"
                    >
                      {run.prUrl ? run.prUrl.replace("https://github.com/", "") : ""}
                    </a>
                  </dd>
                </div>
              </dl>
            </div>

            <div class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
              <h2 class="text-lg font-semibold text-neutral-900">{t("phases")}</h2>
              <ol class="space-y-2">
                {PHASES.map((phase) => (
                  <li class="flex items-center space-x-3">
                    <span class="font-mono text-sm text-neutral-400" data-phase={phase}>
                      {phase}
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            <form
              id="stop-button-form"
              method="post"
              action={`/api/runs/${run.runId}/stop`}
              style={{ display: isRunning ? "block" : "none" }}
            >
              <button
                type="submit"
                class="w-full px-4 py-2 text-sm font-medium text-danger-700 bg-danger-50 border border-danger-200 rounded-md hover:bg-danger-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-danger-500 transition-colors"
              >
                {t("stop this run")}
              </button>
            </form>
          </aside>

          <section class="space-y-8 lg:col-span-2">
            <div class="space-y-4">
              <h2 class="text-xl font-semibold text-neutral-900">{t("sub issues")}</h2>
              <ul id="sub-issues-list" class="space-y-3">
                {run.subIssues.map((sub) => (
                  <li
                    id={`sub-issue-${sub.taskId}`}
                    class="bg-surface border border-neutral-200 rounded-lg p-4 flex items-center justify-between"
                  >
                    <div class="flex items-center space-x-3">
                      <span
                        class="font-mono text-sm font-medium text-neutral-900"
                        data-sub-issue-title
                      >
                        {sub.taskId}
                      </span>
                      <a
                        href={`https://github.com/${run.repo}/issues/${sub.issueNumber}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="font-mono text-sm text-brand-600 hover:text-brand-700"
                        data-sub-issue-link
                      >
                        #{sub.issueNumber}
                      </a>
                    </div>
                    <StatusBadge status="pending" />
                  </li>
                ))}
              </ul>

              <template id="sub-issue-template">
                <li class="bg-surface border border-neutral-200 rounded-lg p-4 flex items-center justify-between">
                  <div class="flex items-center space-x-3">
                    <span
                      class="font-mono text-sm font-medium text-neutral-900"
                      data-sub-issue-title
                    ></span>
                    {/* biome-ignore lint/a11y/useAnchorContent: template element */}
                    {/* biome-ignore lint/a11y/useValidAnchor: template element */}
                    <a
                      target="_blank"
                      rel="noopener noreferrer"
                      class="font-mono text-sm text-brand-600 hover:text-brand-700"
                      data-sub-issue-link
                    ></a>
                  </div>
                  <span data-sub-issue-status></span>
                </li>
              </template>
            </div>

            <div class="space-y-4">
              <h2 class="text-xl font-semibold text-neutral-900">{t("live log")}</h2>
              <details
                class="group bg-surface border border-neutral-200 rounded-xl overflow-hidden live-log"
                open
              >
                <summary class="flex items-center justify-between p-4 cursor-pointer bg-surface hover:bg-neutral-50 transition-colors select-none">
                  <span class="font-mono text-sm font-medium text-neutral-900">{t("events")}</span>
                </summary>
                <div class="border-t border-neutral-200 bg-neutral-950 p-4 h-96 overflow-y-auto">
                  <ol id="live-log-list" class="space-y-0"></ol>
                </div>
              </details>
            </div>
          </section>
        </div>
      </section>
      <RunLiveScript runId={run.runId} />
    </Layout>
  );
};
