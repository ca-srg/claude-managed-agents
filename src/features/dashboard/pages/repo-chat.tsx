/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { StatusBadge } from "@/features/dashboard/components/status-badge";
import { formatRelativeTime, t, tPlural } from "@/features/dashboard/i18n";
import type { RunSummary } from "@/features/dashboard/pages/runs";

export type RepoChatMessageView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  sessionId: string | null;
};

export type RepoChatThreadView = {
  id: string;
  title: string;
  updatedAt: string;
};

export type RepoChatMcpEntry = {
  enabled: boolean;
  envPresent: boolean;
  isBuiltin: boolean;
  name: string;
  permissionPolicy: string;
  tokenEnvName: string;
};

export type RepoChatContextSummary = {
  chatAvailable: boolean;
  environment: {
    configured: boolean;
    environmentId: string | null;
    packageCount: number;
  };
  mcp: {
    enabledCount: number;
    missingEnvCount: number;
    servers: RepoChatMcpEntry[];
    totalCount: number;
  };
  prompts: Array<{
    agent: "parent" | "child";
    configured: boolean;
  }>;
  recentRuns: RunSummary[];
  trigger: {
    botMention: string;
    configured: boolean;
    enabled: boolean;
    triggerLabel: string;
  };
};

export type RepoChatPageProps = {
  activeThreadId: string | null;
  context: RepoChatContextSummary;
  errorNotice?: string;
  messages: RepoChatMessageView[];
  repo: string;
  threads: RepoChatThreadView[];
};

const SUGGESTED_QUESTIONS = [
  "Summarize repository setup",
  "Check MCP readiness",
  "Review environment packages",
  "Inspect repository contents",
  "Find recent run failures",
] as const;

export const RepoChatPage: FC<RepoChatPageProps> = (props) => {
  const { owner, name } = splitRepo(props.repo);
  const repoHref = `/repos/${owner}/${name}`;
  const chatHref = `${repoHref}/chat`;
  const settingsConfigured =
    props.context.prompts.some((slot) => slot.configured) ||
    props.context.environment.configured ||
    props.context.trigger.configured;

  return (
    <Layout title={`${props.repo} · ${t("Repository chat")}`} activeNav="repos">
      <section class="space-y-10">
        <header class="relative overflow-hidden rounded-[1.5rem] border border-neutral-200 bg-surface p-5 shadow-lg sm:p-6 lg:p-8">
          <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(45,212,191,0.16),transparent_34%),linear-gradient(135deg,rgba(19,26,38,0.98),rgba(11,18,32,0.98))]" />
          <div class="pointer-events-none absolute right-0 top-0 h-28 w-28 border-b border-l border-brand-300/20 bg-brand-500/5" />
          <div class="relative space-y-6">
            <nav class="flex flex-wrap items-center gap-2 text-sm text-neutral-500">
              <a href="/repositories" class="hover:text-neutral-900 transition-colors">
                {t("repositories")}
              </a>
              <span class="text-neutral-300">/</span>
              <a href={repoHref} class="font-medium hover:text-neutral-900 transition-colors">
                {props.repo}
              </a>
              <span class="text-neutral-300">/</span>
              <span class="font-medium text-neutral-900">{t("chat")}</span>
            </nav>
            <div class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_26rem] lg:items-end">
              <div class="max-w-3xl space-y-3">
                <div class="flex flex-wrap items-center gap-3">
                  <h1 class="text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl">
                    {t("Chat with {repo}", { repo: props.repo })}
                  </h1>
                  <span class="inline-flex items-center rounded-full border border-brand-300/70 bg-brand-50 px-3 py-1 font-mono text-xs font-medium uppercase tracking-wide text-brand-700 shadow-sm">
                    {t("Read-only inspection")}
                  </span>
                </div>
                <p class="max-w-3xl text-base leading-7 text-neutral-500">
                  {t(
                    "Ask about settings, MCP availability, and repository contents before starting an agent run.",
                  )}
                </p>
              </div>
              <div class="space-y-3">
                <dl class="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-2">
                  <HeaderPill
                    label={t("Repository settings")}
                    value={settingsConfigured ? t("configured") : t("not-configured")}
                  />
                  <HeaderPill
                    label={t("MCP availability")}
                    value={`${props.context.mcp.enabledCount}/${props.context.mcp.totalCount}`}
                  />
                  <HeaderPill label={t("Repository contents")} value={t("read-only")} />
                  <HeaderPill label={t("Recent runs")} value={props.context.recentRuns.length} />
                </dl>
                <a
                  href={`https://github.com/${props.repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex w-full items-center justify-center rounded-lg border border-neutral-200 bg-surface/90 px-4 py-2.5 text-sm font-medium text-neutral-900 transition-colors hover:border-brand-300 hover:bg-neutral-100 sm:w-auto lg:w-full"
                >
                  GitHub →
                </a>
              </div>
            </div>
          </div>
        </header>

        {props.errorNotice && <ErrorNotice message={props.errorNotice} />}

        <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-3 lg:gap-8 xl:gap-10">
          <ChatContextAside context={props.context} repo={props.repo} repoHref={repoHref} />
          <div class="order-1 lg:order-2 lg:col-span-2">
            <section class="overflow-hidden rounded-[1.5rem] border border-neutral-200 bg-surface shadow-lg">
              {props.messages.length === 0 && (
                <SuggestedQuestionGrid chatHref={chatHref} threadId={props.activeThreadId} />
              )}
              <ChatThread messages={props.messages} />
              <ChatComposer
                available={props.context.chatAvailable}
                chatHref={chatHref}
                threadId={props.activeThreadId}
              />
            </section>
          </div>
        </div>

        {props.threads.length > 0 && (
          <ThreadHistory
            chatHref={chatHref}
            threads={props.threads}
            activeThreadId={props.activeThreadId}
          />
        )}
      </section>
    </Layout>
  );
};

const ErrorNotice: FC<{ message: string }> = ({ message }) => (
  <div class="rounded-xl border border-danger-200 bg-danger-50 p-4 text-sm text-danger-800">
    <span class="font-semibold">{t("Chat error")}: </span>
    <span>{message}</span>
  </div>
);

const HeaderPill: FC<{ label: string; value: Child }> = ({ label, value }) => (
  <div class="rounded-lg border border-neutral-200/80 bg-surface-muted/70 px-3 py-2.5 shadow-sm">
    <dt class="font-mono text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
      {label}
    </dt>
    <dd class="mt-1 truncate font-mono text-sm font-semibold text-neutral-900">{value}</dd>
  </div>
);

const ChatContextAside: FC<{
  context: RepoChatContextSummary;
  repo: string;
  repoHref: string;
}> = ({ context, repo, repoHref }) => (
  <aside class="order-2 space-y-4 lg:sticky lg:top-24 lg:order-1">
    <ContextCard title={t("Repository settings")}>
      <dl class="space-y-3 text-sm">
        <ContextRow label={t("prompts")}>
          {context.prompts.map((slot) => (
            <span
              class="mr-2 inline-flex rounded-md bg-surface-muted px-2 py-1 font-mono text-xs"
              key={slot.agent}
            >
              {slot.agent}:{" "}
              <span class={slot.configured ? "text-success-700" : "text-neutral-500"}>
                {slot.configured ? t("configured") : t("not-configured")}
              </span>
            </span>
          ))}
        </ContextRow>
        <ContextRow label={t("environment")}>
          <span class="font-mono">
            {context.environment.configured
              ? tPlural(context.environment.packageCount, "{count} package", "{count} packages")
              : t("base only")}
          </span>
        </ContextRow>
        <ContextRow label={t("auto-trigger")}>
          <span class="font-mono">
            {context.trigger.configured
              ? context.trigger.enabled
                ? t("active")
                : t("paused")
              : t("not-configured")}
          </span>
        </ContextRow>
      </dl>
      <a
        href={repoHref}
        class="inline-flex rounded-full border border-brand-200/70 bg-brand-50 px-3 py-1.5 font-mono text-xs text-brand-600 transition-colors hover:border-brand-300 hover:text-brand-700"
      >
        {t("open settings →")}
      </a>
    </ContextCard>

    <ContextCard title={t("MCP availability")}>
      <dl class="grid grid-cols-3 gap-2 text-sm">
        <MiniStat label={t("total")} value={context.mcp.totalCount} />
        <MiniStat label={t("enabled")} value={context.mcp.enabledCount} />
        <MiniStat label={t("missing env")} value={context.mcp.missingEnvCount} />
      </dl>
      <div class="space-y-2">
        {context.mcp.servers.slice(0, 5).map((server) => (
          <div
            class="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-surface-muted px-3 py-2.5 text-xs"
            key={server.name}
          >
            <span class="min-w-0 truncate font-mono text-neutral-900">{server.name}</span>
            <span
              class={`shrink-0 font-mono ${
                server.enabled && server.envPresent ? "text-success-700" : "text-warning-700"
              }`}
            >
              {mcpServerStatusText(server)}
            </span>
          </div>
        ))}
      </div>
      <a
        href="/mcp-servers"
        class="inline-flex rounded-full border border-brand-200/70 bg-brand-50 px-3 py-1.5 font-mono text-xs text-brand-600 transition-colors hover:border-brand-300 hover:text-brand-700"
      >
        {t("open MCP servers →")}
      </a>
    </ContextCard>

    <ContextCard title={t("Repository contents")}>
      <p class="text-sm text-neutral-500">
        {t("Managed Agents mounts this repository for read-only inspection during each chat turn.")}
      </p>
      <code class="block rounded-md border border-neutral-200 bg-surface-muted px-3 py-2 font-mono text-xs text-neutral-700 break-all">
        /workspace/{repo.split("/")[1] ?? repo}
      </code>
    </ContextCard>

    <ContextCard title={t("Recent runs")}>
      {context.recentRuns.length === 0 ? (
        <p class="text-sm text-neutral-500">{t("No runs for this repository yet.")}</p>
      ) : (
        <div class="space-y-2">
          {context.recentRuns.slice(0, 4).map((run) => (
            <a
              href={`/runs/${run.runId}`}
              class="flex items-center justify-between gap-3 rounded-lg border border-neutral-200 bg-surface-muted px-3 py-2.5 text-xs transition-colors hover:border-brand-300"
              key={run.runId}
            >
              <span class="font-mono text-brand-700">{run.runId.slice(0, 8)}</span>
              <StatusBadge status={runStatus(run)} />
            </a>
          ))}
        </div>
      )}
    </ContextCard>
  </aside>
);

function mcpServerStatusText(server: RepoChatMcpEntry): string {
  if (!server.enabled) {
    return t("disabled");
  }
  if (server.tokenEnvName.length === 0 || server.isBuiltin) {
    return t("not required");
  }
  return server.envPresent ? t("env loaded") : t("env missing");
}

const ContextCard: FC<{ children: Child; title: string }> = ({ children, title }) => (
  <section class="overflow-hidden rounded-xl border border-neutral-200 bg-surface shadow-sm">
    <div class="flex items-center justify-between gap-3 border-b border-neutral-200/80 bg-surface-muted/50 px-4 py-3">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-neutral-500">{title}</h2>
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
    </div>
    <div class="space-y-4 p-4">{children}</div>
  </section>
);

const ContextRow: FC<{ children: Child; label: string }> = ({ children, label }) => (
  <div class="rounded-lg border border-neutral-200/70 bg-surface-muted/40 px-3 py-2.5">
    <dt class="text-xs font-medium uppercase tracking-wider text-neutral-500">{label}</dt>
    <dd class="mt-1 text-neutral-800">{children}</dd>
  </div>
);

const MiniStat: FC<{ label: string; value: number }> = ({ label, value }) => (
  <div class="rounded-lg border border-neutral-200 bg-surface-muted px-3 py-2.5">
    <dt class="text-[10px] font-medium uppercase tracking-wider text-neutral-500">{label}</dt>
    <dd class="font-mono text-sm font-semibold text-neutral-900">{value}</dd>
  </div>
);

const SuggestedQuestionGrid: FC<{ chatHref: string; threadId: string | null }> = ({
  chatHref,
  threadId,
}) => (
  <section class="relative overflow-hidden border-b border-neutral-200 bg-gradient-to-br from-brand-50 via-surface to-surface-muted p-4 sm:p-6">
    <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-brand-400/70" />
    <div class="relative space-y-4">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 class="text-lg font-semibold text-neutral-900">{t("Suggested questions")}</h2>
          <p class="mt-1 text-sm leading-6 text-neutral-500">
            {t("Start with a suggested question or ask about this repository directly.")}
          </p>
        </div>
        <span class="hidden rounded-full border border-brand-300/60 bg-brand-100 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-brand-700 sm:inline-flex">
          {t("Read-only inspection")}
        </span>
      </div>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SUGGESTED_QUESTIONS.map((question, index) => (
          <form method="post" action={chatHref} key={question}>
            <DefaultContextInputs />
            {threadId && <input type="hidden" name="threadId" value={threadId} />}
            <button
              type="submit"
              name="message"
              value={t(question)}
              class="group flex h-full w-full items-start gap-3 rounded-xl border border-brand-200/80 bg-surface/90 px-4 py-3.5 text-left text-sm font-medium text-neutral-800 shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-400 hover:text-brand-700 hover:shadow-md"
            >
              <span class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 font-mono text-[10px] font-semibold text-brand-500 ring-1 ring-brand-300/60">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span class="min-w-0 flex-1 leading-6">{t(question)}</span>
              <span class="text-brand-500 opacity-60 transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </button>
          </form>
        ))}
      </div>
    </div>
  </section>
);

const ChatThread: FC<{ messages: RepoChatMessageView[] }> = ({ messages }) => {
  if (messages.length === 0) {
    return (
      <div class="bg-surface p-4 sm:p-6">
        <div class="relative overflow-hidden rounded-xl border border-dashed border-neutral-300 bg-surface-muted px-4 py-10 text-center sm:px-8 sm:py-12">
          <div class="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-brand-400/40 to-transparent" />
          <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-brand-300/60 bg-brand-50 font-mono text-lg text-brand-600 shadow-sm">
            →
          </div>
          <h2 class="mb-2 text-lg font-medium text-neutral-900">{t("No messages yet")}</h2>
          <p class="mx-auto max-w-xl text-sm leading-6 text-neutral-500">
            {t("Start with a suggested question or ask about this repository directly.")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <section class="space-y-5 bg-surface-muted/40 p-4 sm:p-6">
      {messages.map((message) => (
        <ChatBubble key={message.id} message={message} />
      ))}
    </section>
  );
};

const ChatBubble: FC<{ message: RepoChatMessageView }> = ({ message }) => {
  const isUser = message.role === "user";
  return (
    <article class={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        class={`max-w-full rounded-2xl border px-4 py-4 shadow-sm sm:max-w-[86%] sm:px-5 ${
          isUser
            ? "border-brand-300 bg-brand-100 shadow-md"
            : "border-neutral-200 border-l-2 border-l-brand-400 bg-surface"
        }`}
      >
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200/70 pb-3">
          <div class="flex min-w-0 items-center gap-2">
            <span
              class={`font-mono text-xs font-semibold uppercase tracking-wide ${
                isUser ? "text-brand-700" : "text-neutral-500"
              }`}
            >
              {isUser ? t("you") : t("assistant")}
            </span>
            {message.sessionId && !isUser && (
              <span class="truncate font-mono text-[11px] text-neutral-400">
                {message.sessionId}
              </span>
            )}
          </div>
          <time class="shrink-0 font-mono text-xs text-neutral-400" datetime={message.createdAt}>
            {formatRelativeTime(message.createdAt)}
          </time>
        </header>
        <div class="whitespace-pre-wrap break-words text-sm leading-7 text-neutral-800 sm:text-[0.95rem]">
          {message.content}
        </div>
      </div>
    </article>
  );
};

const ChatComposer: FC<{
  available: boolean;
  chatHref: string;
  threadId: string | null;
}> = ({ available, chatHref, threadId }) => (
  <form
    method="post"
    action={chatHref}
    class="space-y-5 border-t border-neutral-200 bg-gradient-to-br from-surface to-surface-muted p-4 sm:p-6"
  >
    {threadId && <input type="hidden" name="threadId" value={threadId} />}
    <fieldset class="rounded-xl border border-neutral-200 bg-surface/80 p-3 sm:p-4">
      <legend class="px-2 text-sm font-semibold text-neutral-900">{t("Context included")}</legend>
      <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Checkbox name="includeSettings" label={t("Repository settings")} />
        <Checkbox name="includeMcp" label={t("MCP availability")} />
        <Checkbox name="includeRepository" label={t("Repository contents")} />
        <Checkbox name="includeRecentRuns" label={t("Recent runs")} />
      </div>
    </fieldset>

    <label class="block space-y-2">
      <span class="text-sm font-medium text-neutral-700">{t("Ask a question")}</span>
      <textarea
        name="message"
        required
        maxLength={4000}
        rows={5}
        disabled={!available}
        placeholder={t("Ask a question about this repository…")}
        class="block min-h-[9rem] w-full resize-y rounded-xl border border-neutral-300 bg-surface px-4 py-3 text-sm leading-6 text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-neutral-100 disabled:text-neutral-400"
      />
    </label>
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
      <p class="text-xs text-neutral-500">
        {t(
          "Submitting creates a short-lived Managed Agents session and reloads this page with the latest answer.",
        )}
      </p>
      <button
        type="submit"
        disabled={!available}
        class="inline-flex w-full items-center justify-center rounded-lg border border-transparent bg-brand-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-neutral-300 sm:w-auto"
      >
        {t("Send")}
      </button>
    </div>
  </form>
);

const Checkbox: FC<{ label: string; name: string }> = ({ label, name }) => (
  <label class="flex items-center gap-3 rounded-lg border border-neutral-200 bg-surface-muted px-3 py-2.5 text-sm text-neutral-700 transition-colors hover:border-brand-300">
    <input
      type="checkbox"
      name={name}
      checked
      class="h-4 w-4 rounded border-neutral-300 bg-surface text-brand-600"
    />
    <span>{label}</span>
  </label>
);

const DefaultContextInputs: FC = () => (
  <>
    <input type="hidden" name="includeSettings" value="on" />
    <input type="hidden" name="includeMcp" value="on" />
    <input type="hidden" name="includeRepository" value="on" />
    <input type="hidden" name="includeRecentRuns" value="on" />
  </>
);

const ThreadHistory: FC<{
  activeThreadId: string | null;
  chatHref: string;
  threads: RepoChatThreadView[];
}> = ({ activeThreadId, chatHref, threads }) => (
  <section class="overflow-hidden rounded-[1.25rem] border border-neutral-200 bg-surface shadow-lg">
    <div class="flex items-center justify-between gap-3 border-b border-neutral-200/80 bg-surface-muted/50 px-4 py-3 sm:px-5">
      <h2 class="text-lg font-semibold text-neutral-900">{t("Chat history")}</h2>
      <a
        href={`${chatHref}?new=1`}
        class="rounded-full border border-brand-200/70 bg-brand-50 px-3 py-1.5 font-mono text-sm text-brand-600 transition-colors hover:border-brand-300 hover:text-brand-700"
      >
        {t("New chat →")}
      </a>
    </div>
    <div class="grid grid-cols-1 gap-3 p-4 sm:p-5 md:grid-cols-2">
      {threads.map((thread) => (
        <a
          href={`${chatHref}?thread=${encodeURIComponent(thread.id)}`}
          class={`rounded-xl border px-4 py-3 transition-colors ${
            thread.id === activeThreadId
              ? "border-brand-400 bg-brand-50 shadow-sm"
              : "border-neutral-200 bg-surface-muted hover:border-brand-300 hover:bg-surface"
          }`}
          key={thread.id}
        >
          <div class="font-medium text-neutral-900 truncate">{thread.title}</div>
          <time class="font-mono text-xs text-neutral-500" datetime={thread.updatedAt}>
            {formatRelativeTime(thread.updatedAt)}
          </time>
        </a>
      ))}
    </div>
  </section>
);

function runStatus(run: RunSummary): "success" | "failure" | "in-progress" | "pending" {
  if (run.status === "completed") return "success";
  if (run.status === "failed" || run.status === "aborted") return "failure";
  if (run.status === "running") return "in-progress";
  return "pending";
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner = "", name = ""] = repo.split("/");
  return { owner, name };
}
