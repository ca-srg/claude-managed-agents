/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { Table } from "@/features/dashboard/components/table";
import { formatRelativeTime, t } from "@/features/dashboard/i18n";

export type PromptListEntry = {
  promptKey: "parent.system" | "child.system" | "parent.runtime" | "child.runtime";
  editable: boolean;
  updatedAt: string | null; // ISO; null if never seeded
  revisionCount: number;
};

export type PromptsListPageProps = {
  prompts: PromptListEntry[];
  repoOverrides?: RepoPromptOverrideEntry[];
};

export type RepoPromptOverrideEntry = {
  repo: string;
  agent: "parent" | "child";
  revisionCount: number;
  updatedAt: string;
};

export const PromptsListPage: FC<PromptsListPageProps> = (props) => {
  const repoOverrides = props.repoOverrides ?? [];

  return (
    <Layout title={t("Prompts")} activeNav="prompts">
      <div class="space-y-8">
        <section class="space-y-6">
          <header class="space-y-2">
            <h1 class="text-3xl font-bold tracking-tight text-neutral-900">{t("Prompts")}</h1>
            <p class="text-neutral-500">
              {t("system prompts: editable / runtime templates: read-only")}
            </p>
          </header>
          {props.prompts.length === 0 ? (
            <div class="text-center py-16 px-4 border-2 border-dashed border-neutral-200 rounded-xl bg-surface">
              <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-neutral-100 text-neutral-400 mb-4">
                <span class="text-2xl leading-none">⎋</span>
              </div>
              <h3 class="text-lg font-medium text-neutral-900 mb-1">
                {t("No prompts seeded yet")}
              </h3>
              <p class="text-neutral-500">
                {t('Restart the CLI or run "serve" to seed defaults.')}
              </p>
            </div>
          ) : (
            <Table columns={[t("key"), t("editable"), t("revisions"), t("updated"), t("details")]}>
              {props.prompts.map((entry) => (
                <tr key={entry.promptKey} class="hover:bg-neutral-50 transition-colors">
                  <td class="px-4 py-3">
                    <a
                      href={`/prompts/${entry.promptKey}`}
                      data-prompt-key={entry.promptKey}
                      class="font-mono text-brand-600 hover:text-brand-700 font-medium"
                    >
                      {entry.promptKey}
                    </a>
                  </td>
                  <td class="px-4 py-3">
                    <span
                      class={`prompt-badge inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide border ${
                        entry.editable
                          ? "editable bg-success-50 text-success-700 border-success-200"
                          : "readonly bg-neutral-50 text-neutral-600 border-neutral-200"
                      }`}
                    >
                      {entry.editable ? t("editable") : t("read-only")}
                    </span>
                  </td>
                  <td class="px-4 py-3 font-mono text-neutral-900">{entry.revisionCount}</td>
                  <td class="px-4 py-3 font-mono text-neutral-500 text-sm">
                    {formatRelativeTime(entry.updatedAt)}
                  </td>
                  <td class="px-4 py-3">
                    <a
                      href={`/prompts/${entry.promptKey}`}
                      class="font-mono text-brand-600 hover:text-brand-700 text-sm"
                    >
                      {t("view →")}
                    </a>
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </section>

        <section class="space-y-4">
          <header class="space-y-2">
            <h2 class="text-xl font-semibold text-neutral-900">{t("Repository overrides")}</h2>
            <p class="text-sm text-neutral-500">
              {t("Per-repository additions on top of the global system prompts.")}
            </p>
          </header>

          {repoOverrides.length === 0 ? (
            <div class="bg-surface border border-neutral-200 rounded-xl px-4 py-6 text-sm text-neutral-500">
              {t("No repository overrides configured.")}
            </div>
          ) : (
            <Table columns={[t("repo"), t("agent"), t("revisions"), t("updated"), t("details")]}>
              {repoOverrides.map((entry) => {
                const repoHref = repositoryHref(entry.repo);
                return (
                  <tr
                    key={`${entry.repo}:${entry.agent}`}
                    class="hover:bg-neutral-50 transition-colors"
                  >
                    <td class="px-4 py-3">
                      <a
                        href={repoHref}
                        class="font-mono text-neutral-900 hover:text-brand-600 font-medium"
                      >
                        {entry.repo}
                      </a>
                    </td>
                    <td class="px-4 py-3">
                      <span class="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide border bg-brand-50 text-brand-700 border-brand-200">
                        {entry.agent}
                      </span>
                    </td>
                    <td class="px-4 py-3 font-mono text-neutral-900">{entry.revisionCount}</td>
                    <td class="px-4 py-3 font-mono text-neutral-500 text-sm">
                      {formatRelativeTime(entry.updatedAt)}
                    </td>
                    <td class="px-4 py-3">
                      <a
                        href={`${repoHref}/prompts/${entry.agent}`}
                        class="font-mono text-brand-600 hover:text-brand-700 text-sm"
                      >
                        {t("view →")}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </Table>
          )}
        </section>
      </div>
    </Layout>
  );
};

function repositoryHref(repo: string): string {
  const [owner = "", name = ""] = repo.split("/");
  return `/repos/${owner}/${name}`;
}
