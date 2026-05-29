/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { PackageListInput } from "@/features/dashboard/components/package-list-input";
import { t } from "@/features/dashboard/i18n";
import { packageListEnhanceScript } from "@/features/dashboard/scripts/package-list-enhance";

export type RepoEnvironmentRevisionView = {
  id: number;
  packages: {
    apt: string[];
    cargo: string[];
    gem: string[];
    go: string[];
    npm: string[];
    pip: string[];
  };
  createdAt: string;
  source: "edit" | "restore";
};

export type RepoEnvironmentDetailPageProps = {
  repo: string;
  configured: boolean;
  packages: RepoEnvironmentRevisionView["packages"];
  environmentId: string | null;
  definitionHash: string | null;
  currentRevisionId: number | null;
  revisions: RepoEnvironmentRevisionView[];
  noChangeNotice?: { kind: "no_change" | "already_current" };
  removedNotice?: boolean;
};

type PackageManagerKey = keyof RepoEnvironmentRevisionView["packages"];

type PackageManagerConfig = {
  key: PackageManagerKey;
  examples: string;
  alwaysIncludes?: string[];
};

const PACKAGE_MANAGERS: PackageManagerConfig[] = [
  { key: "apt", examples: "vim\ngolang-go", alwaysIncludes: ["git"] },
  { key: "cargo", examples: "ripgrep@14.0.0" },
  { key: "gem", examples: "rails:7.1.0" },
  { key: "go", examples: "golang.org/x/tools/cmd/goimports@latest" },
  { key: "npm", examples: "typescript\neslint@8.57.0", alwaysIncludes: ["bun"] },
  { key: "pip", examples: "pandas==2.2.0\nrequests" },
];

export const RepoEnvironmentDetailPage: FC<RepoEnvironmentDetailPageProps> = (props) => {
  const { owner, name } = splitRepo(props.repo);
  const repoHref = `/repos/${owner}/${name}`;
  const pageHref = `${repoHref}/environment`;
  const editorFormId = "repo-environment-edit-form";

  return (
    <Layout
      title={`${props.repo} · ${t("Environment packages")}`}
      activeNav="repos"
      enhanced={true}
    >
      <header class="prompt-page-header space-y-2 mb-6">
        <nav class="breadcrumb flex items-center space-x-2 text-sm text-neutral-500">
          <a href="/repositories" class="hover:text-neutral-900 transition-colors">
            {t("repositories")}
          </a>
          <span class="breadcrumb-sep text-neutral-300">/</span>
          <a href={repoHref} class="hover:text-neutral-900 transition-colors">
            {props.repo}
          </a>
          <span class="breadcrumb-sep text-neutral-300">/</span>
          <span class="breadcrumb-current text-neutral-900 font-mono font-medium">
            {t("environment")}
          </span>
        </nav>
        <h1 class="page-title text-3xl font-bold tracking-tight text-neutral-900">
          {t("Environment packages")} <span class="font-mono text-brand-600">{props.repo}</span>
        </h1>
      </header>

      <div class="space-y-3 mb-6">
        <div class="bg-info-50 border border-info-200 text-info-700 rounded-md p-4 text-sm">
          {t(
            "Base packages are always auto-merged at runtime: apt includes git, and npm includes bun. Leave all fields empty to use only the base environment. Saves update the database now; Anthropic environments sync lazily on the next run.",
          )}
        </div>

        {props.noChangeNotice && (
          <div class="prompt-no-changes-banner bg-neutral-50 border border-neutral-200 text-neutral-600 rounded-md p-3 text-sm">
            {props.noChangeNotice.kind === "no_change"
              ? t("Saved with the same package lists — no new revision created.")
              : t("Already at this revision — restore had no effect.")}
          </div>
        )}

        {props.removedNotice && (
          <div class="prompt-removed-banner bg-success-50 border border-success-200 text-success-700 rounded-md p-3 text-sm">
            {t(
              "Environment package configuration removed. This repository now uses only base packages.",
            )}
          </div>
        )}
      </div>

      <div class="space-y-6">
        <section class="prompt-detail-card bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div class="space-y-1">
              <h2 class="section-title text-lg font-semibold text-neutral-900">
                {t("Package editor")}
              </h2>
              <p class="text-sm text-neutral-500">
                {t("Repository-specific packages pre-installed for")} {props.repo}.
              </p>
            </div>
            <ConfiguredBadge configured={props.configured} />
          </div>

          <form
            method="post"
            action={pageHref}
            id={editorFormId}
            class="environment-form space-y-5"
          >
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              {PACKAGE_MANAGERS.map((manager) => (
                <PackageManagerField
                  key={manager.key}
                  manager={manager}
                  values={props.packages[manager.key]}
                />
              ))}
            </div>
          </form>

          <div class="prompt-form-actions flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
            <div class="flex items-center space-x-3">
              <button
                type="submit"
                form={editorFormId}
                class="primary bg-brand-600 text-white hover:bg-brand-700 px-4 py-2 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t("Save")}
              </button>
              <a
                href={repoHref}
                class="secondary bg-surface text-neutral-900 hover:bg-neutral-100 border border-neutral-200 px-4 py-2 rounded-md font-medium transition-colors"
              >
                {t("Cancel")}
              </a>
            </div>

            {props.configured && (
              <form method="post" action={`${pageHref}/delete`}>
                <button
                  type="submit"
                  class="bg-danger-50 text-danger-700 hover:bg-danger-100 border border-danger-200 px-4 py-2 rounded-md font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-danger-500"
                >
                  {t("Remove configuration")}
                </button>
              </form>
            )}
          </div>
        </section>

        <section class="prompt-detail-card bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
          <div class="space-y-1">
            <h2 class="section-title text-lg font-semibold text-neutral-900">
              {t("Anthropic state (read-only)")}
            </h2>
            <p class="text-sm text-neutral-500">
              {t(
                "The cloud environment is created or updated lazily when the next repository run starts.",
              )}
            </p>
          </div>
          <dl class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-neutral-100">
            <StateValue label={t("environment id")} value={props.environmentId} />
            <StateValue label={t("definition hash")} value={props.definitionHash} />
          </dl>
        </section>

        {props.configured && props.revisions.length > 0 && (
          <section class="prompt-detail-card bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
            <h2 class="section-title text-lg font-semibold text-neutral-900">{t("History")}</h2>
            <ol class="prompt-history-list space-y-3">
              {props.revisions.map((rev) => (
                <li
                  class="prompt-history-item bg-surface-muted border border-neutral-200 rounded-md p-3"
                  key={rev.id}
                >
                  <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                    <details class="flex-1 group">
                      <summary class="cursor-pointer list-none">
                        <div class="prompt-history-meta flex flex-wrap items-center gap-3 text-sm">
                          <span class="font-mono font-medium text-neutral-900">#{rev.id}</span>
                          <SourceBadge source={rev.source} />
                          <span class="muted text-neutral-500">{rev.createdAt}</span>
                          {rev.id === props.currentRevisionId && (
                            <span class="prompt-badge editable inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide bg-success-50 text-success-700 border border-success-200">
                              {t("current")}
                            </span>
                          )}
                          <span class="font-mono text-xs text-neutral-600">
                            {formatPackageSummary(rev.packages)}
                          </span>
                          <span class="text-xs text-brand-600 group-open:hidden">
                            {t("expand")}
                          </span>
                          <span class="hidden text-xs text-brand-600 group-open:inline">
                            {t("collapse")}
                          </span>
                        </div>
                      </summary>
                      <ExpandedPackageList packages={rev.packages} />
                    </details>

                    {rev.id !== props.currentRevisionId && (
                      <form method="post" action={`${pageHref}/restore`}>
                        <input type="hidden" name="revision_id" value={String(rev.id)} />
                        <button
                          type="submit"
                          class="secondary bg-surface text-neutral-900 hover:bg-neutral-100 border border-neutral-200 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
                        >
                          {t("restore")}
                        </button>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>

      <script type="module" dangerouslySetInnerHTML={{ __html: packageListEnhanceScript() }} />
    </Layout>
  );
};

const PackageManagerField: FC<{ manager: PackageManagerConfig; values: string[] }> = ({
  manager,
  values,
}) => (
  <div class="space-y-2 rounded-lg border border-neutral-200 bg-surface-muted p-4">
    <div class="flex flex-col gap-1">
      <label
        htmlFor={`package-list-${manager.key}`}
        class="font-mono text-sm font-semibold text-neutral-900"
      >
        {manager.key}
      </label>
      {manager.alwaysIncludes && (
        <p class="text-xs text-neutral-500">
          {t("Always includes:")} <span class="font-mono">{manager.alwaysIncludes.join(", ")}</span>
        </p>
      )}
    </div>
    <PackageListInput
      name={manager.key}
      values={values}
      placeholder={manager.examples}
      alwaysIncludes={manager.alwaysIncludes}
      ariaLabel={`${manager.key} ${t("package specs")}`}
    />
    <p class="text-xs text-neutral-500">
      {t("Examples:")} <code class="font-mono">{formatExamples(manager.examples)}</code>
    </p>
  </div>
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

const SourceBadge: FC<{ source: RepoEnvironmentRevisionView["source"] }> = ({ source }) => (
  <span
    class={`prompt-history-source ${source} inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium uppercase tracking-wide border ${
      source === "edit"
        ? "bg-brand-50 text-brand-700 border-brand-200"
        : "bg-warning-50 text-warning-700 border-warning-200"
    }`}
  >
    {t(source)}
  </span>
);

const StateValue: FC<{ label: string; value: string | null }> = ({ label, value }) => (
  <div>
    <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">{label}</dt>
    <dd class="mt-1 font-mono text-sm text-neutral-900" title={value ?? ""}>
      {value ? truncateValue(value) : <span class="text-neutral-500">{t("not yet synced")}</span>}
    </dd>
  </div>
);

const ExpandedPackageList: FC<{ packages: RepoEnvironmentRevisionView["packages"] }> = ({
  packages,
}) => {
  const hasPackages = PACKAGE_MANAGERS.some((manager) => packages[manager.key].length > 0);

  return (
    <div class="mt-3 border-t border-neutral-200 pt-3">
      {hasPackages ? (
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          {PACKAGE_MANAGERS.map((manager) => {
            const values = packages[manager.key];
            if (values.length === 0) return null;

            return (
              <div key={manager.key} class="space-y-2">
                <h3 class="font-mono text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  {manager.key}
                </h3>
                <div class="flex flex-wrap gap-2">
                  {values.map((pkg) => (
                    <span
                      key={pkg}
                      class="inline-flex items-center rounded-md border border-neutral-200 bg-surface px-2 py-1 font-mono text-xs text-neutral-700"
                    >
                      {pkg}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p class="text-sm text-neutral-500">{t("No extra packages. Base packages only.")}</p>
      )}
    </div>
  );
};

function formatPackageSummary(packages: RepoEnvironmentRevisionView["packages"]): string {
  const parts = PACKAGE_MANAGERS.map((manager) => {
    const count = packages[manager.key].length;
    return count > 0 ? `${manager.key}: ${count}` : null;
  }).filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(" · ") : t("no extra packages");
}

function formatExamples(examples: string): string {
  return examples.split("\n").join(", ");
}

function truncateValue(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}...` : value;
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
}
