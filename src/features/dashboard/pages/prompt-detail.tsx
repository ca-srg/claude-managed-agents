/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { t } from "@/features/dashboard/i18n";
import { DiffViewer } from "../components/diff-viewer";
import { Layout } from "../components/layout";
import { PromptEditor } from "../components/prompt-editor";

export type PromptRevisionView = {
  id: number;
  body: string;
  createdAt: string;
  source: "seed" | "edit" | "restore";
};

export type PromptDetailPageProps = {
  promptKey: "parent.system" | "child.system" | "parent.runtime" | "child.runtime";
  body: string;
  editable: boolean;
  revisions: PromptRevisionView[];
  currentRevisionId: number | null;
  prevRevision?: PromptRevisionView;
  noChangeNotice?: { kind: "no_change" | "already_current" };
};

export const PromptDetailPage: FC<PromptDetailPageProps> = (props) => {
  return (
    <Layout
      title={`${t("Prompts")} · ${props.promptKey}`}
      activeNav="prompts"
      enhanced={props.editable}
    >
      <header class="prompt-page-header space-y-2 mb-6">
        <nav class="breadcrumb flex items-center space-x-2 text-sm text-neutral-500">
          <a href="/prompts" class="hover:text-neutral-900 transition-colors">
            {t("prompts")}
          </a>
          <span class="breadcrumb-sep text-neutral-300">/</span>
          <span class="breadcrumb-current text-neutral-900 font-medium">{props.promptKey}</span>
        </nav>
        <h1 class="page-title text-3xl font-bold tracking-tight font-mono text-neutral-900">
          {props.promptKey}
        </h1>
      </header>

      {props.noChangeNotice && (
        <div class="prompt-no-changes-banner bg-neutral-50 border border-neutral-200 text-neutral-600 rounded-md p-3 text-sm mb-6">
          {props.noChangeNotice.kind === "no_change"
            ? t("Saved with same content — no new revision created.")
            : t("Already at this revision — restore had no effect.")}
        </div>
      )}

      {!props.editable && (
        <div class="prompt-readonly-banner bg-info-50 border border-info-200 text-info-700 rounded-md p-4 mb-6">
          <span class="prompt-readonly-banner-text">
            {t("This is a hardcoded runtime template. Read-only in MVP.")}
          </span>
        </div>
      )}

      <div class="space-y-6">
        <section class="prompt-detail-card bg-surface border border-neutral-200 rounded-xl p-6">
          {props.editable ? (
            <form
              method="post"
              action={`/prompts/${props.promptKey}`}
              class="prompt-form space-y-4"
            >
              <PromptEditor body={props.body} editable={true} />
              <div class="prompt-form-actions flex items-center space-x-3 pt-2">
                <button
                  type="submit"
                  class="primary bg-brand-600 text-white hover:bg-brand-700 px-4 py-2 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t("Save")}
                </button>
                <a
                  href={`/prompts/${props.promptKey}`}
                  class="secondary bg-surface text-neutral-900 hover:bg-neutral-100 border border-neutral-200 px-4 py-2 rounded-md font-medium transition-colors"
                >
                  {t("Cancel")}
                </a>
              </div>
            </form>
          ) : (
            <PromptEditor body={props.body} editable={false} />
          )}
        </section>

        {props.editable && props.prevRevision && (
          <section class="prompt-detail-card bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
            <h2 class="section-title text-lg font-semibold text-neutral-900">
              {t("diff (vs previous revision)")}
            </h2>
            <DiffViewer oldText={props.prevRevision.body} newText={props.body} />
          </section>
        )}

        {props.editable && props.revisions.length > 0 && (
          <section class="prompt-detail-card bg-surface border border-neutral-200 rounded-xl p-6 space-y-4">
            <h2 class="section-title text-lg font-semibold text-neutral-900">{t("history")}</h2>
            <ol class="prompt-history-list space-y-3">
              {props.revisions.map((rev) => (
                <li
                  class="prompt-history-item bg-surface-muted border border-neutral-200 rounded-md p-3 flex items-center justify-between"
                  key={rev.id}
                >
                  <div class="prompt-history-meta flex items-center space-x-3 text-sm">
                    <span class="font-mono font-medium text-neutral-900">#{rev.id}</span>
                    <span
                      class={`prompt-history-source ${rev.source} inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium uppercase tracking-wide border ${
                        rev.source === "seed"
                          ? "bg-info-50 text-info-700 border-info-200"
                          : rev.source === "edit"
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
                    <form method="post" action={`/prompts/${props.promptKey}/restore`}>
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
