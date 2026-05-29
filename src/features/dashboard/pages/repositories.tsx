/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { formatRelativeTime, t, tPlural } from "@/features/dashboard/i18n";
import type { UsageAggregate } from "@/shared/persistence/schemas";
import { formatTokens, formatUsd, totalTokenVolume } from "@/shared/pricing";

export type Repository = {
  repo: string; // "owner/name"
  runCount: number;
  lastRunAt: string | null; // ISO timestamp
  usage: UsageAggregate;
  /** GitHub Issue auto-trigger registration state for this repo. */
  polledTrigger: {
    configured: boolean;
    enabled: boolean;
  };
};

export type RepositoriesPageProps = {
  globalUsage: UsageAggregate;
  repositories: Repository[];
  /** Bot mention name (no `@`) used to trigger runs from issue comments. */
  triggerBotMention: string;
  /** Issue label name whose addition triggers runs. */
  triggerLabel: string;
};

export const RepositoriesPage: FC<RepositoriesPageProps> = (props) => {
  const usageRepoCount = props.repositories.filter(
    (repo) => repo.usage.modelRequestCount > 0,
  ).length;
  return (
    <Layout title={t("Repositories")} activeNav="repos">
      <section class="space-y-6">
        <header class="space-y-2">
          <h1 class="text-3xl font-bold tracking-tight text-neutral-900">{t("Repositories")}</h1>
          <p class="text-neutral-500">
            {tPlural(
              props.repositories.length,
              "agent ran against {count} repository",
              "agent ran against {count} repositories",
            )}
          </p>
        </header>
        {props.globalUsage.modelRequestCount > 0 && (
          <GlobalUsageBanner usage={props.globalUsage} repoCount={usageRepoCount} />
        )}
        <AddPolledRepositoryCard
          botMention={props.triggerBotMention}
          triggerLabel={props.triggerLabel}
        />
        {props.repositories.length === 0 ? (
          <EmptyState />
        ) : (
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {props.repositories.map((repo, idx) => (
              <RepoCard repo={repo} delayMs={idx * 50} />
            ))}
          </div>
        )}
      </section>
    </Layout>
  );
};

const AddPolledRepositoryCard: FC<{ botMention: string; triggerLabel: string }> = ({
  botMention,
  triggerLabel,
}) => (
  <article class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-5 shadow-sm animate-fade-in-up">
    <div class="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5">
      <div class="space-y-2 max-w-3xl">
        <h2 class="text-xl font-semibold text-neutral-900">
          {t("Watch a repository for auto-trigger")}
        </h2>
        <p class="text-sm text-neutral-500">
          {t("Add an")}{" "}
          <code class="font-mono text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded">
            owner/name
          </code>{" "}
          {t("to poll for")}{" "}
          <code class="font-mono text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded">
            @{botMention} run
          </code>{" "}
          {t("comments")}{" "}
          <code class="font-mono text-neutral-700 bg-neutral-100 px-1 py-0.5 rounded">
            {triggerLabel}
          </code>{" "}
          {t("label events.")}
        </p>
      </div>

      <form
        method="post"
        action="/polled-repos"
        class="flex flex-col sm:flex-row gap-3 lg:min-w-[28rem]"
      >
        <label htmlFor="polled-repo" class="sr-only">
          {t("Repository")}
        </label>
        <input
          type="text"
          id="polled-repo"
          name="repo"
          required
          pattern="[\w.-]+/[\w.-]+"
          placeholder="acme/widgets"
          class="block w-full rounded-md border border-neutral-300 bg-surface px-3 py-2 font-mono text-sm text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        />
        <button
          type="submit"
          class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors whitespace-nowrap"
        >
          {t("Add to polled list")}
        </button>
      </form>
    </div>
  </article>
);

const GlobalUsageBanner: FC<{ usage: UsageAggregate; repoCount: number }> = ({
  repoCount,
  usage,
}) => {
  const cacheTokens = usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  return (
    <article class="bg-gradient-to-br from-brand-50 to-brand-100 border border-brand-200 rounded-xl p-6 shadow-sm animate-fade-in-up">
      <div class="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-6">
        <div class="space-y-2">
          <p class="text-xs font-medium uppercase tracking-wider text-brand-700">
            {t("Managed Agents usage")}
          </p>
          <dl>
            <dt class="text-sm font-medium text-neutral-500">{t("total cost")}</dt>
            <dd class="mt-1 font-mono text-4xl font-semibold tracking-tight text-neutral-900">
              {formatUsd(usage.costUsd)}
            </dd>
          </dl>
        </div>
        <dl class="grid grid-cols-2 sm:grid-cols-4 gap-3 lg:min-w-[32rem]">
          <UsageMetric
            label={t("tokens")}
            value={formatTokens(totalTokenVolume(usage))}
            tone="strong"
          />
          <UsageMetric label={t("input")} value={formatTokens(usage.inputTokens)} />
          <UsageMetric label={t("output")} value={formatTokens(usage.outputTokens)} />
          <UsageMetric label={t("cache")} value={formatTokens(cacheTokens)} />
        </dl>
      </div>
      <p class="mt-5 text-sm text-neutral-500">
        {tPlural(
          repoCount,
          "Aggregated from {count} repo with usage · {requests} model requests",
          "Aggregated from {count} repos with usage · {requests} model requests",
          { requests: usage.modelRequestCount },
        )}
      </p>
    </article>
  );
};

const UsageMetric: FC<{ label: string; value: string; tone?: "default" | "strong" }> = ({
  label,
  tone = "default",
  value,
}) => (
  <div class="rounded-lg border border-brand-200 bg-surface/70 px-4 py-3">
    <dt class="text-xs font-medium uppercase tracking-wider text-neutral-500">{label}</dt>
    <dd
      class={`mt-1 font-mono font-semibold ${
        tone === "strong" ? "text-lg text-neutral-900" : "text-sm text-neutral-700"
      }`}
    >
      {value}
    </dd>
  </div>
);

const RepoCard: FC<{ repo: Repository; delayMs: number }> = ({ repo, delayMs }) => {
  const [owner, name] = repo.repo.split("/");
  const href = `/repos/${owner}/${name}`;
  const tokenVolume = totalTokenVolume(repo.usage);
  const showUsage = repo.usage.costUsd > 0;
  return (
    <a
      href={href}
      class="group block p-6 bg-surface border border-neutral-200 rounded-xl hover:border-brand-500 hover:shadow-md transition-all duration-200 animate-fade-in-up"
      style={`animation-delay: ${delayMs}ms; animation-fill-mode: both;`}
    >
      <div class="flex items-baseline space-x-1 mb-4">
        <span class="text-neutral-500 font-medium">{owner}/</span>
        <span class="text-xl font-bold text-neutral-900 group-hover:text-brand-600 transition-colors">
          {name}
        </span>
      </div>
      <div class="flex items-center justify-between gap-3 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <span class="inline-flex items-center px-2.5 py-0.5 rounded-full bg-neutral-100 text-neutral-700 font-medium">
            {tPlural(repo.runCount, "{count} run", "{count} runs")}
          </span>
          {repo.polledTrigger.configured && (
            <PolledTriggerBadge enabled={repo.polledTrigger.enabled} />
          )}
        </div>
        <time class="text-neutral-500 font-mono" datetime={repo.lastRunAt ?? ""}>
          {formatRelativeTime(repo.lastRunAt)}
        </time>
      </div>
      {showUsage && (
        <div class="mt-4 pt-4 border-t border-neutral-100 font-mono text-xs text-neutral-500">
          {t("cost:")} <span class="text-neutral-700">{formatUsd(repo.usage.costUsd)}</span> ·{" "}
          {formatTokens(tokenVolume)} {t("tokens")}
        </div>
      )}
    </a>
  );
};

const PolledTriggerBadge: FC<{ enabled: boolean }> = ({ enabled }) => (
  <span
    class={`inline-flex items-center px-2 py-0.5 rounded-full border font-mono text-[11px] font-semibold uppercase tracking-wide ${
      enabled
        ? "bg-success-50 text-success-700 border-success-200"
        : "bg-warning-50 text-warning-700 border-warning-200"
    }`}
  >
    {enabled ? t("polled") : t("polled (paused)")}
  </span>
);

const EmptyState: FC = () => {
  return (
    <div class="text-center py-16 px-4 border-2 border-dashed border-neutral-200 rounded-xl bg-surface">
      <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-neutral-100 text-neutral-400 mb-4">
        <svg
          class="w-6 h-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
          />
        </svg>
      </div>
      <h3 class="text-lg font-medium text-neutral-900 mb-1">{t("No runs yet")}</h3>
      <p class="text-neutral-500 mb-4">
        {t("Run a GitHub or Linear issue from New Run; history appears here.")}
      </p>
    </div>
  );
};
