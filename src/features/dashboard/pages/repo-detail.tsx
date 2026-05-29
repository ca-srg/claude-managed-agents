/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { StatusBadge } from "@/features/dashboard/components/status-badge";
import { Table } from "@/features/dashboard/components/table";
import { formatRelativeTime, t, tPlural } from "@/features/dashboard/i18n";
import { RunFailureSnippet, type RunSummary } from "@/features/dashboard/pages/runs";
import type { UsageAggregate } from "@/shared/persistence/schemas";
import { formatTokens, formatUsd, totalTokenVolume } from "@/shared/pricing";
import { fallbackRunOrigin, originShortDisplay, originUrl } from "@/shared/run-origin";

export type RepoPromptSlot = {
  agent: "parent" | "child";
  configured: boolean;
  currentRevisionId: number | null;
  revisionCount: number;
  updatedAt: string | null;
};

export type RepoEnvironmentSummary = {
  configured: boolean;
  packageCount: number;
  perManagerCount: {
    apt: number;
    cargo: number;
    gem: number;
    go: number;
    npm: number;
    pip: number;
  } | null;
  revisionCount: number;
  updatedAt: string | null;
  environmentId: string | null;
};

export type RepoTriggerSummary = {
  /** DB に登録されている (= ポーラーで監視対象) */
  configured: boolean;
  /** 監視対象だが現在は一時停止中ではない */
  enabled: boolean;
  /** 監視を追加した時刻 (DB に行がある場合) */
  addedAt: string | null;
  /** 最後にトグル/再有効化された時刻 */
  updatedAt: string | null;
  /** GitHub username (no `@`) — `@<bot> run` で発火 */
  botMention: string;
  /** 付与でトリガーするラベル名 */
  triggerLabel: string;
};

export type RepoDetailPageProps = {
  repo: string;
  repoPromptSlots: RepoPromptSlot[];
  repoEnvironmentSummary: RepoEnvironmentSummary;
  repoTriggerSummary: RepoTriggerSummary;
  repoUsage: UsageAggregate;
  runs: RunSummary[];
};

type PackageManagerCount = NonNullable<RepoEnvironmentSummary["perManagerCount"]>;
type PackageManagerKey = keyof PackageManagerCount;

const PACKAGE_MANAGER_KEYS: PackageManagerKey[] = ["apt", "cargo", "gem", "go", "npm", "pip"];

export const RepoDetailPage: FC<RepoDetailPageProps> = (props) => {
  const { owner, name } = splitRepo(props.repo);
  const repoHref = `/repos/${owner}/${name}`;

  return (
    <Layout title={`${props.repo} · ${t("Repository")}`} activeNav="repos">
      <section class="space-y-8">
        <header class="space-y-2">
          <nav class="flex items-center space-x-2 text-sm text-neutral-500">
            <a href="/repositories" class="hover:text-neutral-900 transition-colors">
              {t("repositories")}
            </a>
            <span class="text-neutral-300">/</span>
            <span class="font-medium text-neutral-900">{props.repo}</span>
          </nav>
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
        </header>

        <RepoUsageSummaryCard usage={props.repoUsage} />

        <RepoChatEntryCard repoHref={repoHref} />

        <section class="space-y-4">
          <div class="space-y-2">
            <h2 class="text-xl font-semibold text-neutral-900">{t("Repository prompts")}</h2>
            <p class="text-sm text-neutral-500 max-w-3xl">
              {t(
                "Override the global system prompt with repository-specific instructions. Configured overrides are appended to each runtime prompt.",
              )}
            </p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            {props.repoPromptSlots.map((slot) => (
              <RepoPromptSlotCard key={slot.agent} repoHref={repoHref} slot={slot} />
            ))}
          </div>
        </section>

        <section class="space-y-4">
          <div class="space-y-2">
            <h2 class="text-xl font-semibold text-neutral-900">{t("Environment packages")}</h2>
            <p class="text-sm text-neutral-500 max-w-3xl">
              {t("Pre-install apt/npm/pip/go/cargo/gem packages for this repository's agent runs.")}
            </p>
          </div>

          <RepoEnvironmentSummaryCard repoHref={repoHref} summary={props.repoEnvironmentSummary} />
        </section>

        <AutoTriggerSection
          repo={props.repo}
          repoHref={repoHref}
          summary={props.repoTriggerSummary}
        />

        <section class="space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div class="space-y-1">
              <h2 class="text-xl font-semibold text-neutral-900">{t("Runs")}</h2>
              <p class="text-sm text-neutral-500">
                {tPlural(
                  props.runs.length,
                  "{count} run recorded for this repository.",
                  "{count} runs recorded for this repository.",
                )}
              </p>
            </div>
            <a
              href={`${repoHref}/runs`}
              class="font-mono text-sm text-brand-600 hover:text-brand-700"
            >
              {t("View all runs →")}
            </a>
          </div>

          {props.runs.length === 0 ? (
            <EmptyRunsState repo={props.repo} />
          ) : (
            <RunsTable runs={props.runs} />
          )}
        </section>
      </section>
    </Layout>
  );
};

const RepoChatEntryCard: FC<{ repoHref: string }> = ({ repoHref }) => (
  <article class="bg-gradient-to-br from-brand-50 to-surface border border-brand-200 rounded-xl p-6 space-y-5 shadow-sm">
    <header class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-xl font-semibold text-neutral-900">{t("Repository chat")}</h2>
          <span class="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide bg-surface text-brand-700 border border-brand-200">
            {t("Read-only inspection")}
          </span>
        </div>
        <p class="text-sm text-neutral-600 max-w-3xl">
          {t(
            "Ask about settings, MCP availability, and repository contents before starting an agent run.",
          )}
        </p>
      </div>
      <a
        href={`${repoHref}/chat`}
        class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors whitespace-nowrap"
      >
        {t("Open chat →")}
      </a>
    </header>
  </article>
);

const RepoUsageSummaryCard: FC<{ usage: UsageAggregate }> = ({ usage }) => {
  const tokenVolume = totalTokenVolume(usage);
  const hasUsage = usage.modelRequestCount > 0;
  return (
    <article class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-5 shadow-sm">
      <header class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div class="space-y-2">
          <h2 class="text-xl font-semibold text-neutral-900">{t("Usage summary")}</h2>
          <p class="text-sm text-neutral-500 max-w-3xl">
            {t(
              "Accumulated Anthropic Managed Agents token volume and estimated cost for this repository.",
            )}
          </p>
        </div>
        <div class="font-mono text-xs text-neutral-500">
          {hasUsage
            ? tPlural(usage.modelRequestCount, "{count} model request", "{count} model requests")
            : t("no usage recorded yet")}
        </div>
      </header>

      <dl class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <UsageStat
          label={t("total cost")}
          value={usage.costUsd > 0 ? formatUsd(usage.costUsd) : "—"}
          emphasis
        />
        <UsageStat
          label={t("total tokens")}
          value={tokenVolume > 0 ? formatTokens(tokenVolume) : "—"}
          emphasis
        />
        <UsageStat
          label={t("input")}
          value={usage.inputTokens > 0 ? formatTokens(usage.inputTokens) : "—"}
        />
        <UsageStat
          label={t("output")}
          value={usage.outputTokens > 0 ? formatTokens(usage.outputTokens) : "—"}
        />
        <UsageStat
          label={t("cache create")}
          value={
            usage.cacheCreationInputTokens > 0 ? formatTokens(usage.cacheCreationInputTokens) : "—"
          }
        />
        <UsageStat
          label={t("cache read")}
          value={usage.cacheReadInputTokens > 0 ? formatTokens(usage.cacheReadInputTokens) : "—"}
        />
        <UsageStat
          label={t("model requests")}
          value={usage.modelRequestCount > 0 ? usage.modelRequestCount : "—"}
        />
      </dl>
    </article>
  );
};

const UsageStat: FC<{ label: string; value: string | number; emphasis?: boolean }> = ({
  emphasis = false,
  label,
  value,
}) => (
  <div class="rounded-lg border border-neutral-200 bg-surface-muted px-4 py-3">
    <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">{label}</dt>
    <dd
      class={`mt-1 font-mono font-semibold ${
        emphasis ? "text-2xl text-neutral-900" : "text-sm text-neutral-700"
      }`}
    >
      {value}
    </dd>
  </div>
);

const RepoPromptSlotCard: FC<{ repoHref: string; slot: RepoPromptSlot }> = ({ repoHref, slot }) => (
  <article class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-5 shadow-sm">
    <header class="flex items-start justify-between gap-4">
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="font-mono text-lg font-semibold text-neutral-900">{slot.agent}</h3>
          {slot.configured && (
            <span class="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide bg-success-50 text-success-700 border border-success-200">
              {t("current")}
            </span>
          )}
        </div>
        <p class="text-sm text-neutral-500">
          {slot.agent === "parent"
            ? t("Parent orchestration instructions.")
            : t("Child execution instructions.")}
        </p>
      </div>
      <ConfiguredBadge configured={slot.configured} />
    </header>

    <dl class="grid grid-cols-2 gap-4 pt-4 border-t border-neutral-100">
      <div>
        <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">
          {t("revisions")}
        </dt>
        <dd class="mt-1 font-mono text-sm text-neutral-900">{slot.revisionCount}</dd>
      </div>
      <div>
        <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">
          {t("updated")}
        </dt>
        <dd class="mt-1 font-mono text-sm text-neutral-500">
          <time datetime={slot.updatedAt ?? ""}>{formatRelativeTime(slot.updatedAt)}</time>
        </dd>
      </div>
    </dl>

    <a
      href={`${repoHref}/prompts/${slot.agent}`}
      class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
    >
      {slot.configured ? t("Edit") : t("Configure")}
    </a>
  </article>
);

const AutoTriggerSection: FC<{
  repo: string;
  repoHref: string;
  summary: RepoTriggerSummary;
}> = ({ repo, repoHref, summary }) => (
  <section class="space-y-4">
    <div class="space-y-2">
      <h2 class="text-xl font-semibold text-neutral-900">{t("GitHub Issue auto-trigger")}</h2>
      <p class="text-sm text-neutral-500 max-w-3xl">
        {t("Polls this repository for")}{" "}
        <code class="font-mono text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded">
          @{summary.botMention} run
        </code>{" "}
        {t("issue comments and")}{" "}
        <code class="font-mono text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded">
          {summary.triggerLabel}
        </code>{" "}
        {t(
          "label additions, automatically enqueuing a run when matched. The poller runs continuously; toggle off to pause without losing dedupe history.",
        )}
      </p>
    </div>

    {/* TODO: show trigger result banners when trigger query state is passed through page props. */}
    <AutoTriggerCard repo={repo} repoHref={repoHref} summary={summary} />
  </section>
);

const AutoTriggerCard: FC<{
  repo: string;
  repoHref: string;
  summary: RepoTriggerSummary;
}> = ({ repo, repoHref, summary }) => {
  if (!summary.configured) {
    return (
      <article class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-5 shadow-sm">
        <header class="flex items-start justify-between gap-4">
          <div class="space-y-2">
            <h3 class="text-lg font-semibold text-neutral-900">{t("Not polled yet")}</h3>
            <p class="text-sm text-neutral-500">
              {t("This repo is not yet polled. Add it to start receiving auto-triggers.")}
            </p>
          </div>
          <ConfiguredBadge configured={false} />
        </header>

        <form method="post" action="/polled-repos" class="pt-4 border-t border-neutral-100">
          <input type="hidden" name="repo" value={repo} />
          <button
            type="submit"
            class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
          >
            {t("Enable polling for this repo")}
          </button>
        </form>
      </article>
    );
  }

  return (
    <article class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-5 shadow-sm">
      <header class="flex items-start justify-between gap-4">
        <div class="space-y-2">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-lg font-semibold text-neutral-900">
              {summary.enabled ? t("Polling active") : t("Polling paused")}
            </h3>
            <TriggerStatusBadge enabled={summary.enabled} />
          </div>
          <p class="text-sm text-neutral-500">
            {summary.enabled
              ? t("New matching issue comments or label events will enqueue runs automatically.")
              : t("Dedupe history is retained while the poller skips this repository.")}
          </p>
        </div>
        <ConfiguredBadge configured={true} />
      </header>

      <dl class="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-neutral-100">
        <TriggerDetail label={t("added")}>
          <time datetime={summary.addedAt ?? ""}>{formatRelativeTime(summary.addedAt)}</time>
        </TriggerDetail>
        <TriggerDetail label={t("last updated")}>
          <time datetime={summary.updatedAt ?? ""}>{formatRelativeTime(summary.updatedAt)}</time>
        </TriggerDetail>
        <TriggerDetail label={t("bot mention")}>
          <span class="font-mono text-sm text-neutral-900">@{summary.botMention} run</span>
        </TriggerDetail>
        <TriggerDetail label={t("trigger label")}>
          <span class="font-mono text-sm text-neutral-900">{summary.triggerLabel}</span>
        </TriggerDetail>
      </dl>

      <div class="flex flex-col sm:flex-row sm:items-center gap-3 pt-1">
        <form
          method="post"
          action={`${repoHref}/trigger/${summary.enabled ? "disable" : "enable"}`}
        >
          <button
            type="submit"
            class={
              summary.enabled
                ? "inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-neutral-900 bg-surface border border-neutral-200 rounded-md hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
                : "inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
            }
          >
            {summary.enabled ? t("Pause polling") : t("Resume polling")}
          </button>
        </form>
        <form method="post" action={`${repoHref}/trigger/remove`}>
          <button
            type="submit"
            class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-danger-700 bg-danger-50 border border-danger-200 rounded-md hover:bg-danger-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-danger-500 transition-colors"
          >
            {t("Remove from polled list")}
          </button>
        </form>
      </div>
    </article>
  );
};

const TriggerStatusBadge: FC<{ enabled: boolean }> = ({ enabled }) => (
  <span
    class={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide border ${
      enabled
        ? "bg-success-50 text-success-700 border-success-200"
        : "bg-warning-50 text-warning-700 border-warning-200"
    }`}
  >
    {enabled ? t("active") : t("paused")}
  </span>
);

const TriggerDetail: FC<{ label: string; children: Child }> = ({ children, label }) => (
  <div>
    <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">{label}</dt>
    <dd class="mt-1 font-mono text-sm text-neutral-500">{children}</dd>
  </div>
);

const RepoEnvironmentSummaryCard: FC<{
  repoHref: string;
  summary: RepoEnvironmentSummary;
}> = ({ repoHref, summary }) => (
  <article class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-5 shadow-sm">
    <header class="flex items-start justify-between gap-4">
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <h3 class="text-lg font-semibold text-neutral-900">{t("Environment packages")}</h3>
          {summary.configured && (
            <span class="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide bg-success-50 text-success-700 border border-success-200">
              {t("current")}
            </span>
          )}
        </div>
        <p class="text-sm text-neutral-500">
          {t("Pre-install apt/npm/pip/go/cargo/gem packages for this repository's agent runs.")}
        </p>
      </div>
      <ConfiguredBadge configured={summary.configured} />
    </header>

    {summary.configured && summary.perManagerCount ? (
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2 pt-4 border-t border-neutral-100">
        {PACKAGE_MANAGER_KEYS.map((manager) => (
          <div
            key={manager}
            class="rounded-md border border-neutral-200 bg-surface-muted px-3 py-2"
          >
            <span class="font-mono text-xs text-neutral-500">{manager}</span>{" "}
            <span class="font-mono text-sm font-semibold text-neutral-900">
              {summary.perManagerCount?.[manager] ?? 0}
            </span>
          </div>
        ))}
      </div>
    ) : (
      <div class="rounded-md border border-dashed border-neutral-200 bg-surface-muted p-4 text-sm text-neutral-500">
        {t("No repository-specific packages configured. Runs use the base environment only.")}
      </div>
    )}

    <dl class="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-4 border-t border-neutral-100">
      <div>
        <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">
          {t("packages")}
        </dt>
        <dd class="mt-1 font-mono text-sm text-neutral-900">{summary.packageCount}</dd>
      </div>
      <div>
        <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">
          {t("revisions")}
        </dt>
        <dd class="mt-1 font-mono text-sm text-neutral-900">{summary.revisionCount}</dd>
      </div>
      <div>
        <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">
          {t("updated")}
        </dt>
        <dd class="mt-1 font-mono text-sm text-neutral-500">
          <time datetime={summary.updatedAt ?? ""}>{formatRelativeTime(summary.updatedAt)}</time>
        </dd>
      </div>
    </dl>

    <dl class="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-neutral-100">
      <div>
        <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">
          {t("anthropic env")}
        </dt>
        <dd class="mt-1 font-mono text-sm text-neutral-900" title={summary.environmentId ?? ""}>
          {summary.environmentId ? (
            truncateIdentifier(summary.environmentId)
          ) : (
            <span class="text-neutral-500">{t("not yet synced")}</span>
          )}
        </dd>
      </div>
    </dl>

    <a
      href={`${repoHref}/environment`}
      class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
    >
      {summary.configured ? t("Edit") : t("Configure")}
    </a>
  </article>
);

const ConfiguredBadge: FC<{ configured: boolean }> = ({ configured }) => (
  <span
    class={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide border ${
      configured
        ? "bg-brand-50 text-brand-700 border-brand-200"
        : "bg-neutral-50 text-neutral-600 border-neutral-200"
    }`}
  >
    {configured ? t("configured") : t("not-configured")}
  </span>
);

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
  const { owner, name } = splitRepo(run.repo);
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

function truncateIdentifier(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
}

const EmptyRunsState: FC<{ repo: string }> = ({ repo }) => (
  <div class="text-center py-16 px-4 border-2 border-dashed border-neutral-200 rounded-xl bg-surface">
    <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-neutral-100 text-neutral-400 mb-4">
      <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 12H4" />
      </svg>
    </div>
    <h3 class="text-lg font-medium text-neutral-900 mb-1">{t("No runs for {repo}", { repo })}</h3>
    <p class="text-neutral-500 mb-4">{t("No runs for this repository yet.")}</p>
    <a
      href="/runs/new"
      class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
    >
      {t("Start your first run")}
    </a>
  </div>
);
