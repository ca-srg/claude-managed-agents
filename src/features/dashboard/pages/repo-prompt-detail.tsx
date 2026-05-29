/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { DiffViewer } from "@/features/dashboard/components/diff-viewer";
import { Layout } from "@/features/dashboard/components/layout";
import { PromptEditor } from "@/features/dashboard/components/prompt-editor";
import { t } from "@/features/dashboard/i18n";

export type RepoPromptRevisionView = {
  id: number;
  body: string;
  createdAt: string;
  source: "edit" | "restore";
};

export type RepoPromptDetailPageProps = {
  repo: string;
  agent: "parent" | "child";
  agentLabel: string;
  configured: boolean;
  body: string;
  globalPromptKey: "parent.system" | "child.system";
  globalPromptBody: string;
  currentRevisionId: number | null;
  revisions: RepoPromptRevisionView[];
  prevRevision?: RepoPromptRevisionView;
  noChangeNotice?: { kind: "no_change" | "already_current" };
  removedNotice?: boolean;
};

export const RepoPromptDetailPage: FC<RepoPromptDetailPageProps> = (props) => {
  const { owner, name } = splitRepo(props.repo);
  const repoHref = `/repos/${owner}/${name}`;
  const promptHref = `${repoHref}/prompts/${props.agent}`;
  const editorFormId = "repo-prompt-edit-form";

  return (
    <Layout
      title={`${props.repo} · ${props.agent} ${t("prompts")}`}
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
          <span class="text-neutral-500">{t("prompts")}</span>
          <span class="breadcrumb-sep text-neutral-300">/</span>
          <span class="breadcrumb-current text-neutral-900 font-mono font-medium">
            {props.agent}
          </span>
        </nav>
        <h1 class="page-title text-3xl font-bold tracking-tight text-neutral-900">
          <span class="font-mono text-brand-600">{props.agentLabel}</span> {t("prompt")}
        </h1>
      </header>

      <div class="space-y-3 mb-6">
        <div class="bg-info-50 border border-info-200 text-info-700 rounded-md p-4 text-sm">
          {t("This override is appended to the global")}{" "}
          <code class="font-mono">{props.globalPromptKey}</code> {t("prompt as a")}{" "}
          <code class="font-mono">## Repository-specific instructions</code>{" "}
          {t("section. Leave empty (remove) to fall back to the global prompt only.")}
        </div>

        {props.noChangeNotice && (
          <div class="prompt-no-changes-banner bg-neutral-50 border border-neutral-200 text-neutral-600 rounded-md p-3 text-sm">
            {props.noChangeNotice.kind === "no_change"
              ? t("Saved with same content — no new revision created.")
              : t("Already at this revision — restore had no effect.")}
          </div>
        )}

        {props.removedNotice && (
          <div class="prompt-removed-banner bg-success-50 border border-success-200 text-success-700 rounded-md p-3 text-sm">
            {t("Override removed. This repository now uses the global prompt only.")}
          </div>
        )}
      </div>

      <div class="space-y-6">
        <section class="prompt-detail-card bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div class="space-y-1">
              <h2 class="section-title text-lg font-semibold text-neutral-900">
                {t("Override editor")}
              </h2>
              <p class="text-sm text-neutral-500">
                {t("Repository-specific additions for {repo}.", { repo: props.repo })}
              </p>
            </div>
            <ConfiguredBadge configured={props.configured} />
          </div>

          <form method="post" action={promptHref} id={editorFormId} class="prompt-form space-y-4">
            <PromptEditor body={props.body} editable={true} />
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
              <form method="post" action={`${promptHref}/delete`}>
                <button
                  type="submit"
                  class="bg-danger-50 text-danger-700 hover:bg-danger-100 border border-danger-200 px-4 py-2 rounded-md font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-danger-500"
                >
                  {t("Remove override")}
                </button>
              </form>
            )}
          </div>
        </section>

        <section class="prompt-detail-card bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div class="space-y-1">
              <h2 class="section-title text-lg font-semibold text-neutral-900">
                {t("Global prompt (read-only)")}
              </h2>
              <p class="text-sm text-neutral-500">
                {t("Base {promptKey} prompt used before this repository override is appended.", {
                  promptKey: props.globalPromptKey,
                })}
              </p>
            </div>
            <a
              href={`/prompts/${props.globalPromptKey}`}
              class="font-mono text-sm text-brand-600 hover:text-brand-700"
            >
              {t("view global →")}
            </a>
          </div>
          <PromptEditor body={props.globalPromptBody} editable={false} />
        </section>

        {props.configured && props.prevRevision && (
          <section class="prompt-detail-card bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
            <h2 class="section-title text-lg font-semibold text-neutral-900">
              {t("Diff vs previous revision")}
            </h2>
            <DiffViewer oldText={props.prevRevision.body} newText={props.body} />
          </section>
        )}

        {props.configured && props.revisions.length > 0 && (
          <section class="prompt-detail-card bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
            <h2 class="section-title text-lg font-semibold text-neutral-900">{t("History")}</h2>
            <ol class="prompt-history-list space-y-3">
              {props.revisions.map((rev) => (
                <li
                  class="prompt-history-item bg-surface-muted border border-neutral-200 rounded-md p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
                  key={rev.id}
                >
                  <div class="prompt-history-meta flex flex-wrap items-center gap-3 text-sm">
                    <span class="font-mono font-medium text-neutral-900">#{rev.id}</span>
                    <span
                      class={`prompt-history-source ${rev.source} inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium uppercase tracking-wide border ${
                        rev.source === "edit"
                          ? "bg-brand-50 text-brand-700 border-brand-200"
                          : "bg-warning-50 text-warning-700 border-warning-200"
                      }`}
                    >
                      {t(rev.source)}
                    </span>
                    <span class="muted text-neutral-500">{rev.createdAt}</span>
                    {rev.id === props.currentRevisionId && (
                      <span class="prompt-badge editable inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide bg-success-50 text-success-700 border border-success-200">
                        {t("current")}
                      </span>
                    )}
                  </div>
                  {rev.id !== props.currentRevisionId && (
                    <form method="post" action={`${promptHref}/restore`}>
                      <input type="hidden" name="revision_id" value={String(rev.id)} />
                      <button
                        type="submit"
                        class="secondary bg-surface text-neutral-900 hover:bg-neutral-100 border border-neutral-200 px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
                      >
                        {t("restore")}
                      </button>
                    </form>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </Layout>
  );
};

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

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
}
