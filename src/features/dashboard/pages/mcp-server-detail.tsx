/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { t } from "@/features/dashboard/i18n";
import type { McpServerEntry } from "@/features/dashboard/pages/mcp-servers";

export type McpServerDetailNoticeKind = "invalid" | "no_change" | "updated";

export type McpServerDetailPageProps = {
  server: McpServerEntry;
  notice?: { kind: McpServerDetailNoticeKind } | undefined;
};

const INPUT_BASE_CLASS =
  "block w-full rounded-md border px-3 py-2 font-mono text-sm shadow-sm focus:outline-none focus:ring-2 transition-colors";
const EDITABLE_INPUT_CLASS = `${INPUT_BASE_CLASS} border-neutral-300 bg-surface text-neutral-900 placeholder:text-neutral-400 focus:border-brand-500 focus:ring-brand-500/20`;
const READONLY_INPUT_CLASS = `${INPUT_BASE_CLASS} border-neutral-200 bg-neutral-100 text-neutral-500 cursor-not-allowed focus:border-neutral-300 focus:ring-neutral-200`;

export const McpServerDetailPage: FC<McpServerDetailPageProps> = (props) => {
  const serverHref = `/mcp-servers/${props.server.id}`;
  const identityLocked = props.server.isBuiltin;
  const editorFormId = "mcp-server-edit-form";

  return (
    <Layout title={`${props.server.name} · ${t("MCP Servers")}`} activeNav="mcp-servers">
      <section class="space-y-6">
        <header class="space-y-3">
          <nav class="flex items-center space-x-2 text-sm text-neutral-500">
            <a href="/mcp-servers" class="hover:text-neutral-900 transition-colors">
              {t("MCP servers")}
            </a>
            <span class="text-neutral-300">/</span>
            <span class="font-mono font-medium text-neutral-900">{props.server.name}</span>
          </nav>
          <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div class="space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <h1 class="text-3xl font-bold tracking-tight text-neutral-900">
                  {props.server.name}
                </h1>
                {props.server.isBuiltin && <BuiltinBadge />}
                <EnabledBadge enabled={props.server.enabled} />
              </div>
              <p class="max-w-3xl text-neutral-500">
                {t(
                  "Edit the Managed Agents MCP server record. Builtin servers keep their canonical identity locked so agent definitions can rely on stable names and URLs.",
                )}
              </p>
            </div>
            <a
              href="/mcp-servers"
              class="font-mono text-sm text-brand-600 hover:text-brand-700 whitespace-nowrap"
            >
              {t("← Back to MCP servers")}
            </a>
          </div>
        </header>

        {props.notice && <NoticeBanner notice={props.notice} />}

        {props.server.isBuiltin && (
          <div class="bg-info-50 border border-info-200 text-info-700 rounded-md p-4 text-sm">
            {t(
              "This builtin MCP server cannot be deleted or disabled, and its name/URL are read-only. Token env and permission policy remain configurable.",
            )}
          </div>
        )}

        <section class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-6 shadow-sm">
          <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div class="space-y-1">
              <h2 class="text-xl font-semibold text-neutral-900">{t("Server settings")}</h2>
              <p class="text-sm text-neutral-500">
                {t("Environment variables are checked on this dashboard process only.")}
              </p>
            </div>
            <EnvStatusBadge server={props.server} />
          </div>

          <form method="post" action={serverHref} id={editorFormId} class="space-y-5">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div class="space-y-2">
                <label htmlFor="mcp-detail-name" class="block text-sm font-medium text-neutral-900">
                  {t("Name")}
                </label>
                <input
                  type="text"
                  id="mcp-detail-name"
                  name="name"
                  required
                  maxLength={64}
                  pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                  value={props.server.name}
                  readOnly={identityLocked}
                  class={identityLocked ? READONLY_INPUT_CLASS : EDITABLE_INPUT_CLASS}
                />
                <p class="text-xs text-neutral-500">
                  {identityLocked
                    ? t("Builtin server name is locked.")
                    : t("Changing the name updates mcp_server_name for future agent definitions.")}
                </p>
              </div>

              <div class="space-y-2">
                <label htmlFor="mcp-detail-url" class="block text-sm font-medium text-neutral-900">
                  {t("URL")}
                </label>
                <input
                  type="url"
                  id="mcp-detail-url"
                  name="url"
                  required
                  maxLength={2048}
                  value={props.server.url}
                  readOnly={identityLocked}
                  class={identityLocked ? READONLY_INPUT_CLASS : EDITABLE_INPUT_CLASS}
                />
                <p class="text-xs text-neutral-500">
                  {identityLocked
                    ? t("Builtin server URL is locked.")
                    : t("HTTP(S) endpoint only.")}
                </p>
              </div>

              <div class="space-y-2">
                <label
                  htmlFor="mcp-detail-token-env"
                  class="block text-sm font-medium text-neutral-900"
                >
                  {t("Token env var")} {t("(Optional)")}
                </label>
                <input
                  type="text"
                  id="mcp-detail-token-env"
                  name="tokenEnvName"
                  maxLength={128}
                  pattern="[A-Za-z_][A-Za-z0-9_]*"
                  value={props.server.tokenEnvName}
                  class={EDITABLE_INPUT_CLASS}
                />
                <p class="text-xs text-neutral-500">
                  <EnvStatusText server={props.server} />
                </p>
              </div>

              <div class="space-y-2">
                <label
                  htmlFor="mcp-detail-permission-policy"
                  class="block text-sm font-medium text-neutral-900"
                >
                  {t("Permission policy")}
                </label>
                <select
                  id="mcp-detail-permission-policy"
                  name="permissionPolicy"
                  class="block w-full rounded-md border border-neutral-300 bg-surface px-3 py-2 text-sm text-neutral-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                >
                  <option
                    value="always_allow"
                    selected={props.server.permissionPolicy === "always_allow"}
                  >
                    always_allow
                  </option>
                </select>
                <p class="text-xs text-neutral-500">
                  {t(
                    "MCP tool calls run automatically. Confirmation-based approval is not available yet.",
                  )}
                </p>
              </div>
            </div>

            {props.server.isBuiltin && <input type="hidden" name="enabled" value="on" />}
            <label class="flex items-start gap-3 rounded-lg border border-neutral-200 bg-surface-muted p-4 text-sm text-neutral-700">
              <input
                type="checkbox"
                name="enabled"
                value="on"
                checked={props.server.isBuiltin || props.server.enabled}
                disabled={props.server.isBuiltin}
                class="mt-0.5 h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <span>
                <span class="font-medium text-neutral-900">{t("Enabled")}</span>
                <span class="block text-neutral-500">
                  {t("Enabled servers are included in future parent/child agent definitions.")}
                </span>
              </span>
            </label>
          </form>

          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 border-t border-neutral-100">
            <div class="flex items-center gap-3">
              <button
                type="submit"
                form={editorFormId}
                class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
              >
                {t("Save")}
              </button>
              <a
                href="/mcp-servers"
                class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-neutral-900 bg-surface border border-neutral-200 rounded-md hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
              >
                {t("Cancel")}
              </a>
            </div>

            {!props.server.isBuiltin && (
              <form method="post" action={`${serverHref}/delete`}>
                <button
                  type="submit"
                  class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-danger-700 bg-danger-50 border border-danger-200 rounded-md hover:bg-danger-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-danger-500 transition-colors"
                >
                  {t("Delete")}
                </button>
              </form>
            )}
          </div>
        </section>

        <section class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-4 shadow-sm">
          <h2 class="text-lg font-semibold text-neutral-900">{t("Metadata")}</h2>
          <dl class="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StateValue label={t("id")} value={`#${props.server.id}`} />
            <StateValue label={t("created")} value={props.server.createdAt} />
            <StateValue label={t("updated")} value={props.server.updatedAt} />
          </dl>
        </section>
      </section>
    </Layout>
  );
};

const EnvStatusText: FC<{ server: McpServerEntry }> = ({ server }) => {
  if (server.isBuiltin) {
    return (
      <span class="text-neutral-500">
        {t(
          "Builtin GitHub MCP uses GitHub App authorization; no environment variable is required.",
        )}
      </span>
    );
  }

  if (!needsTokenEnv(server)) {
    return (
      <span class="text-neutral-500">
        {t("No token env var configured; connection will be attempted unauthenticated.")}
      </span>
    );
  }

  return (
    <span class={server.envPresent ? "text-success-700" : "text-danger-700"}>
      {t("Current process env:")} <code class="font-mono">{server.tokenEnvName}</code>{" "}
      {server.envPresent ? t("is loaded") : t("is missing")}
    </span>
  );
};

const StateValue: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <dt class="text-xs font-medium text-neutral-500 uppercase tracking-wider">{label}</dt>
    <dd class="mt-1 font-mono text-sm text-neutral-900 break-all">{value}</dd>
  </div>
);

const NoticeBanner: FC<{ notice: NonNullable<McpServerDetailPageProps["notice"]> }> = ({
  notice,
}) => {
  const toneClass =
    notice.kind === "updated"
      ? "bg-success-50 border-success-200 text-success-700"
      : notice.kind === "no_change"
        ? "bg-neutral-50 border-neutral-200 text-neutral-600"
        : "bg-danger-50 border-danger-200 text-danger-700";

  return (
    <div class={`rounded-md border p-3 text-sm ${toneClass}`} role="status" aria-live="polite">
      {detailNoticeMessage(notice.kind)}
    </div>
  );
};

const BuiltinBadge: FC = () => (
  <span class="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide bg-info-50 text-info-700 border border-info-200">
    {t("builtin")}
  </span>
);

const EnabledBadge: FC<{ enabled: boolean }> = ({ enabled }) => (
  <span
    class={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide border ${
      enabled
        ? "bg-success-50 text-success-700 border-success-200"
        : "bg-neutral-50 text-neutral-600 border-neutral-200"
    }`}
  >
    {enabled ? t("enabled") : t("disabled")}
  </span>
);

function needsTokenEnv(server: Pick<McpServerEntry, "isBuiltin" | "tokenEnvName">): boolean {
  return !server.isBuiltin && server.tokenEnvName.length > 0;
}

const EnvStatusBadge: FC<{
  server: Pick<McpServerEntry, "envPresent" | "isBuiltin" | "tokenEnvName">;
}> = ({ server }) => {
  if (!needsTokenEnv(server)) {
    return (
      <span class="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide border bg-neutral-50 text-neutral-600 border-neutral-200">
        {t("not required")}
      </span>
    );
  }

  return (
    <span
      class={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide border ${
        server.envPresent
          ? "bg-success-50 text-success-700 border-success-200"
          : "bg-danger-50 text-danger-700 border-danger-200"
      }`}
    >
      {server.envPresent ? t("env loaded") : t("env missing")}
    </span>
  );
};

function detailNoticeMessage(kind: McpServerDetailNoticeKind): string {
  switch (kind) {
    case "invalid":
      return t("Invalid MCP server form submission.");
    case "no_change":
      return t("Saved with the same MCP server settings — no changes applied.");
    case "updated":
      return t("MCP server updated.");
  }
}
