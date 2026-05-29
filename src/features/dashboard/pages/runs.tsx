/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { StatusBadge } from "@/features/dashboard/components/status-badge";
import { Table } from "@/features/dashboard/components/table";
import { t, tPlural } from "@/features/dashboard/i18n";
import type { RunFailure } from "@/features/dashboard/run-failure";
import type { UsageAggregate } from "@/shared/persistence/schemas";
import { formatTokens, formatUsd, totalTokenVolume } from "@/shared/pricing";
import {
  fallbackRunOrigin,
  originShortDisplay,
  originUrl,
  type RunOrigin,
} from "@/shared/run-origin";
import type { RunStatus } from "@/shared/types";

export type RunSummary = {
  branch?: string;
  failure?: RunFailure;
  subIssueCount: number;
  failedChildResultCount: number;
  issueNumber: number | null;
  origin?: RunOrigin;
  prUrl?: string;
  repo: string;
  runId: string;
  startedAt: string;
  status?: RunStatus;
  usage?: UsageAggregate;
};

export type RunsPageProps = {
  repo?: string;
  runs: RunSummary[];
};

export const RunsPage: FC<RunsPageProps> = (props) => {
  const [owner, name] = props.repo?.split("/") ?? [];
  return (
    <Layout
      title={props.repo === undefined ? t("Runs") : `${props.repo} · ${t("Runs")}`}
      activeNav="runs"
    >
      <section class="space-y-6">
        <header class="space-y-2">
          <nav class="flex items-center space-x-2 text-sm text-neutral-500">
            <a href="/" class="hover:text-neutral-900 transition-colors">
              {t("repositories")}
            </a>
            {props.repo !== undefined && (
              <span class="contents">
                <span class="text-neutral-300">/</span>
                <span class="font-medium text-neutral-900">{props.repo}</span>
              </span>
            )}
          </nav>
          {props.repo === undefined ? (
            <h1 class="text-3xl font-bold tracking-tight text-neutral-900">{t("Runs")}</h1>
          ) : (
            <h1 class="text-3xl font-bold tracking-tight text-neutral-900">
              <a
                href={`https://github.com/${props.repo}`}
                target="_blank"
                rel="noopener noreferrer"
                class="hover:text-brand-600 transition-colors"
              >
                {owner}/<span class="text-brand-600">{name}</span>
              </a>
            </h1>
          )}
          <p class="text-neutral-500">
            {tPlural(props.runs.length, "{count} run", "{count} runs")}
          </p>
        </header>
        {props.runs.length === 0 ? (
          <EmptyState repo={props.repo} />
        ) : (
          <RunsTable runs={props.runs} />
        )}
      </section>
    </Layout>
  );
};

const RunsTable: FC<{ runs: RunSummary[] }> = ({ runs }) => {
  return (
    <Table
      columns={[
        t("run"),
        t("repo"),
        t("origin"),
        t("branch"),
        t("started"),
        t("status"),
        t("tasks"),
        t("tokens"),
        t("cost"),
        t("pr"),
      ]}
      sortedColumn={t("started")}
      sortDirection="desc"
    >
      {runs.map((run) => (
        <RunRow key={run.runId} run={run} />
      ))}
    </Table>
  );
};

const RunRow: FC<{ run: RunSummary }> = ({ run }) => {
  const shortRunId = run.runId.slice(0, 8);
  const status = determineStatus(run);
  const [owner, name] = run.repo.split("/");
  const origin = fallbackRunOrigin(run);
  const originHref = origin ? originUrl(origin) : undefined;
  const originLabel = origin ? originShortDisplay(origin) : "—";
  const usage = run.usage;
  const tokenVolume = usage ? totalTokenVolume(usage) : 0;
  return (
    <tr class="hover:bg-neutral-50 transition-colors">
      <td class="px-4 py-3">
        <a
          href={`/runs/${run.runId}`}
          class="font-mono text-brand-600 hover:text-brand-700 font-medium"
        >
          {shortRunId}
        </a>
      </td>
      <td class="px-4 py-3">
        <a href={`/repos/${owner}/${name}`} class="font-mono text-neutral-900 hover:text-brand-600">
          {run.repo}
        </a>
      </td>
      <td class="px-4 py-3">
        {originHref ? (
          <a
            href={originHref}
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono text-neutral-900 hover:text-brand-600"
          >
            {originLabel}
          </a>
        ) : (
          <span class="font-mono text-neutral-400">—</span>
        )}
      </td>
      <td class="px-4 py-3 font-mono text-neutral-500 text-sm">{run.branch ?? "—"}</td>
      <td class="px-4 py-3 font-mono text-neutral-500 text-sm">{formatDateTime(run.startedAt)}</td>
      <td class="px-4 py-3">
        <div class="space-y-1.5">
          <StatusBadge status={status} />
          {run.failure && <RunFailureSnippet failure={run.failure} />}
        </div>
      </td>
      <td class="px-4 py-3 font-mono text-neutral-900">{run.subIssueCount}</td>
      <td class="px-4 py-3 font-mono text-neutral-500 text-sm">
        {usage && tokenVolume > 0 ? formatTokens(tokenVolume) : "—"}
      </td>
      <td class="px-4 py-3 font-mono text-neutral-900 text-sm">
        {usage && usage.costUsd > 0 ? formatUsd(usage.costUsd) : "—"}
      </td>
      <td class="px-4 py-3">
        {run.prUrl ? (
          <a
            href={run.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="font-mono text-brand-600 hover:text-brand-700 text-sm"
          >
            PR →
          </a>
        ) : (
          <span class="text-neutral-400">—</span>
        )}
      </td>
    </tr>
  );
};

export const RunFailureSnippet: FC<{ failure: RunFailure }> = ({ failure }) => (
  <div class="max-w-xs space-y-0.5">
    <span class="sr-only">{t("failure details")}</span>
    {failure.type && (
      <div class="break-words font-mono text-[11px] uppercase tracking-wide text-danger-700">
        {failure.type}
      </div>
    )}
    <p
      class="max-h-20 overflow-hidden whitespace-pre-wrap break-words text-xs leading-5 text-danger-700"
      title={failure.message}
    >
      {failure.message}
    </p>
  </div>
);

function determineStatus(run: RunSummary): "success" | "failure" | "in-progress" | "pending" {
  if (run.status === "completed") return "success";
  if (run.status === "failed" || run.status === "aborted") return "failure";
  if (run.status === "running") return "in-progress";
  if (run.status === "queued") return "pending";
  if (run.prUrl) return "success";
  if (run.failedChildResultCount > 0) return "failure";
  if (run.subIssueCount > 0) return "in-progress";
  return "pending";
}

function formatDateTime(iso: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().replace("T", " ").slice(0, 19)}Z`;
}

const EmptyState: FC<{ repo?: string }> = ({ repo }) => (
  <div class="text-center py-16 px-4 border-2 border-dashed border-neutral-200 rounded-xl bg-surface">
    <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-neutral-100 text-neutral-400 mb-4">
      <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
      </svg>
    </div>
    <h3 class="text-lg font-medium text-neutral-900 mb-1">
      {repo === undefined ? t("No runs yet") : t("No runs for {repo}", { repo })}
    </h3>
    <p class="text-neutral-500 mb-4">
      {repo === undefined
        ? t("Run a GitHub or Linear issue from New Run; history appears here.")
        : t("No runs for this repository yet.")}
    </p>
    <a
      href="/runs/new"
      class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
    >
      {t("Start your first run")}
    </a>
  </div>
);
