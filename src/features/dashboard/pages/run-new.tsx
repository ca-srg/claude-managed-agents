/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { t } from "@/features/dashboard/i18n";

export type RunNewPageProps = {
  enabledRepositories?: string[];
  values?: {
    issue?: string;
    linearIssue?: string;
    origin?: "github_issue" | "linear_issue";
    repo?: string;
    dryRun?: boolean;
    vaultId?: string;
    configPath?: string;
  };
  errors?: {
    issue?: string;
    linearIssue?: string;
    origin?: string;
    repo?: string;
    dryRun?: string;
    vaultId?: string;
    configPath?: string;
    _form?: string;
  };
  linearMcpEnabled?: boolean;
  registeredRepositoryCount?: number;
};

export const RunNewPage: FC<RunNewPageProps> = ({
  enabledRepositories = [],
  values = {},
  errors = {},
  linearMcpEnabled = false,
  registeredRepositoryCount = 0,
}) => {
  const selectedOrigin = linearMcpEnabled ? (values.origin ?? "github_issue") : "github_issue";
  const isGithubOrigin = selectedOrigin === "github_issue";
  const isLinearOrigin = selectedOrigin === "linear_issue";
  return (
    <Layout title={t("New Run")} activeNav="run-new" enhanced>
      <div class="max-w-2xl mx-auto">
        <header class="mb-8">
          <h1 class="text-3xl font-bold tracking-tight text-neutral-900 mb-2">
            {t("Start New Run")}
          </h1>
          <p class="text-neutral-500">
            {t("Configure and enqueue a new managed agent run across registered repositories.")}
          </p>
          <p class="mt-2 text-sm text-neutral-500">
            {t("Enabled registered repositories:")} {registeredRepositoryCount}
          </p>
        </header>

        {errors._form && (
          <div class="mb-6 p-4 rounded-md bg-status-failed-bg text-status-failed-fg border border-status-failed-fg/20">
            <p class="text-sm font-medium">{t(errors._form)}</p>
          </div>
        )}

        <form
          method="post"
          action="/runs/new"
          class="space-y-6 bg-surface p-6 sm:p-8 rounded-xl border border-neutral-200 shadow-sm"
        >
          <div class="space-y-4">
            {linearMcpEnabled && (
              <fieldset class="rounded-lg border border-neutral-200 bg-surface-muted p-4">
                <legend class="px-1 text-sm font-medium text-neutral-900">
                  {t("Run origin")} <span class="text-brand-600">*</span>
                </legend>
                <div class="grid gap-3 sm:grid-cols-2">
                  <label class="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-200 bg-surface p-3 text-sm hover:border-brand-300">
                    <input
                      type="radio"
                      name="origin"
                      value="github_issue"
                      checked={selectedOrigin === "github_issue"}
                      class="mt-0.5 h-4 w-4 border-neutral-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span>
                      <span class="block font-medium text-neutral-900">{t("GitHub Issue")}</span>
                      <span class="block text-xs text-neutral-500">
                        {t("Read the GitHub issue and close it from the final PR.")}
                      </span>
                    </span>
                  </label>
                  <label class="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-200 bg-surface p-3 text-sm hover:border-brand-300">
                    <input
                      type="radio"
                      name="origin"
                      value="linear_issue"
                      checked={selectedOrigin === "linear_issue"}
                      class="mt-0.5 h-4 w-4 border-neutral-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span>
                      <span class="block font-medium text-neutral-900">{t("Linear")}</span>
                      <span class="block text-xs text-neutral-500">
                        {t("Read the Linear issue through the enabled Linear MCP server.")}
                      </span>
                    </span>
                  </label>
                </div>
                {errors.origin && (
                  <p class="mt-2 text-sm text-status-failed-fg">{t(errors.origin)}</p>
                )}
              </fieldset>
            )}

            <div
              data-origin-field={linearMcpEnabled ? "github_issue" : undefined}
              hidden={linearMcpEnabled && !isGithubOrigin}
            >
              <label htmlFor="issue" class="block text-sm font-medium text-neutral-900 mb-1">
                {linearMcpEnabled ? t("GitHub Issue") : t("Issue")}{" "}
                <span class="text-brand-600">*</span>
              </label>
              <div>
                <input
                  type="text"
                  id="issue"
                  name="issue"
                  required={!linearMcpEnabled || isGithubOrigin}
                  data-required-when-visible={linearMcpEnabled ? "true" : undefined}
                  placeholder="42 or https://github.com/owner/repo/issues/42"
                  value={values.issue ?? ""}
                  class={`block w-full rounded-md shadow-sm sm:text-sm px-3 py-2 border focus:ring-2 focus:ring-offset-0 outline-none transition-colors ${
                    errors.issue
                      ? "border-status-failed-fg/50 focus:border-status-failed-fg focus:ring-status-failed-fg/20 bg-status-failed-bg/30"
                      : "border-neutral-300 focus:border-brand-500 focus:ring-brand-500/20 bg-surface"
                  }`}
                />
              </div>
              {errors.issue ? (
                <p class="mt-1 text-sm text-status-failed-fg">{t(errors.issue)}</p>
              ) : (
                <p class="mt-1 text-xs text-neutral-500">
                  {t("Use a GitHub issue URL when multiple repositories are registered.")}
                </p>
              )}
            </div>

            {linearMcpEnabled && (
              <div data-origin-field="linear_issue" hidden={!isLinearOrigin} class="space-y-4">
                <label
                  htmlFor="linearIssue"
                  class="block text-sm font-medium text-neutral-900 mb-1"
                >
                  {t("Linear Issue")} <span class="text-brand-600">*</span>
                </label>
                <input
                  type="text"
                  id="linearIssue"
                  name="linearIssue"
                  required={isLinearOrigin}
                  data-required-when-visible="true"
                  placeholder="ENG-123 or https://linear.app/..."
                  value={values.linearIssue ?? ""}
                  class={`block w-full rounded-md shadow-sm sm:text-sm px-3 py-2 border focus:ring-2 focus:ring-offset-0 outline-none transition-colors ${
                    errors.linearIssue
                      ? "border-status-failed-fg/50 focus:border-status-failed-fg focus:ring-status-failed-fg/20 bg-status-failed-bg/30"
                      : "border-neutral-300 focus:border-brand-500 focus:ring-brand-500/20 bg-surface"
                  }`}
                />
                {errors.linearIssue ? (
                  <p class="mt-1 text-sm text-status-failed-fg">{t(errors.linearIssue)}</p>
                ) : (
                  <p class="mt-1 text-xs text-neutral-500">
                    {t("Required when Linear is selected.")}
                  </p>
                )}

                <div>
                  <label htmlFor="repo" class="block text-sm font-medium text-neutral-900 mb-1">
                    {t("Primary repository")} <span class="text-brand-600">*</span>
                  </label>
                  <select
                    id="repo"
                    name="repo"
                    required={isLinearOrigin}
                    data-required-when-visible="true"
                    class={`block w-full rounded-md shadow-sm sm:text-sm px-3 py-2 border focus:ring-2 focus:ring-offset-0 outline-none transition-colors ${
                      errors.repo
                        ? "border-status-failed-fg/50 focus:border-status-failed-fg focus:ring-status-failed-fg/20 bg-status-failed-bg/30"
                        : "border-neutral-300 focus:border-brand-500 focus:ring-brand-500/20 bg-surface"
                    }`}
                  >
                    <option value="">{t("Choose a repository")}</option>
                    {enabledRepositories.map((repo) => (
                      <option value={repo} selected={values.repo === repo}>
                        {repo}
                      </option>
                    ))}
                  </select>
                  {errors.repo ? (
                    <p class="mt-1 text-sm text-status-failed-fg">{t(errors.repo)}</p>
                  ) : enabledRepositories.length === 0 ? (
                    <p class="mt-1 text-xs text-status-failed-fg">
                      {t(
                        "No enabled repositories are registered. Register a repository before starting a Linear run.",
                      )}
                    </p>
                  ) : (
                    <p class="mt-1 text-xs text-neutral-500">
                      {t("Select the registered repository that owns the Linear run.")}
                    </p>
                  )}
                </div>
              </div>
            )}

            <div>
              <label htmlFor="vaultId" class="block text-sm font-medium text-neutral-900 mb-1">
                {t("Vault ID")} <span class="text-neutral-400 font-normal">{t("(Optional)")}</span>
              </label>
              <input
                type="text"
                id="vaultId"
                name="vaultId"
                placeholder="vlt_..."
                value={values.vaultId ?? ""}
                class={`block w-full rounded-md shadow-sm sm:text-sm px-3 py-2 border focus:ring-2 focus:ring-offset-0 outline-none transition-colors ${
                  errors.vaultId
                    ? "border-status-failed-fg/50 focus:border-status-failed-fg focus:ring-status-failed-fg/20 bg-status-failed-bg/30"
                    : "border-neutral-300 focus:border-brand-500 focus:ring-brand-500/20 bg-surface"
                }`}
              />
              {errors.vaultId ? (
                <p class="mt-1 text-sm text-status-failed-fg">{t(errors.vaultId)}</p>
              ) : (
                <p class="mt-1 text-xs text-neutral-500">
                  {t("Reuse an existing Anthropic vault")}
                </p>
              )}
            </div>

            <div>
              <label htmlFor="configPath" class="block text-sm font-medium text-neutral-900 mb-1">
                {t("Config Path")}{" "}
                <span class="text-neutral-400 font-normal">{t("(Optional)")}</span>
              </label>
              <input
                type="text"
                id="configPath"
                name="configPath"
                placeholder="./my.config.ts"
                value={values.configPath ?? ""}
                class={`block w-full rounded-md shadow-sm sm:text-sm px-3 py-2 border focus:ring-2 focus:ring-offset-0 outline-none transition-colors ${
                  errors.configPath
                    ? "border-status-failed-fg/50 focus:border-status-failed-fg focus:ring-status-failed-fg/20 bg-status-failed-bg/30"
                    : "border-neutral-300 focus:border-brand-500 focus:ring-brand-500/20 bg-surface"
                }`}
              />
              {errors.configPath && (
                <p class="mt-1 text-sm text-status-failed-fg">{t(errors.configPath)}</p>
              )}
            </div>

            <div class="pt-2">
              <div class="flex items-start">
                <div class="flex items-center h-5">
                  <input
                    id="dryRun"
                    name="dryRun"
                    type="checkbox"
                    checked={values.dryRun}
                    class="focus:ring-brand-500 h-4 w-4 text-brand-600 border-neutral-300 rounded"
                  />
                </div>
                <div class="ml-3 text-sm">
                  <label htmlFor="dryRun" class="font-medium text-neutral-900">
                    {t("Dry Run")}
                  </label>
                  <p class="text-neutral-500">
                    {t("Enqueue the run in dry-run mode without remote execution.")}
                  </p>
                </div>
              </div>
              {errors.dryRun && (
                <p class="mt-1 text-sm text-status-failed-fg ml-7">{t(errors.dryRun)}</p>
              )}
            </div>
          </div>

          <div class="pt-4 border-t border-neutral-200 flex justify-end">
            <button
              type="submit"
              class="inline-flex justify-center py-2 px-4 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-brand-600 hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
            >
              {t("Start Run")}
            </button>
          </div>
        </form>
      </div>
      {linearMcpEnabled && (
        <script type="module" dangerouslySetInnerHTML={{ __html: ORIGIN_TOGGLE_SCRIPT }} />
      )}
    </Layout>
  );
};

const ORIGIN_TOGGLE_SCRIPT = `
(() => {
  const radios = document.querySelectorAll('input[name="origin"]');
  if (radios.length === 0) return;
  const fields = document.querySelectorAll('[data-origin-field]');
  if (fields.length === 0) return;

  function applyOrigin(value) {
    fields.forEach((field) => {
      const match = field.getAttribute('data-origin-field') === value;
      field.hidden = !match;
      field.querySelectorAll('[data-required-when-visible="true"]').forEach((control) => {
        control.required = match;
      });
    });
  }

  radios.forEach((radio) => {
    radio.addEventListener('change', (event) => {
      const target = event.currentTarget;
      if (target && target.checked) applyOrigin(target.value);
    });
  });
})();
`.trim();
