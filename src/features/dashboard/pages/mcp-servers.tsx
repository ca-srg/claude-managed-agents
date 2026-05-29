/** @jsxImportSource hono/jsx */
import type { FC } from "hono/jsx";
import { Layout } from "@/features/dashboard/components/layout";
import { Table } from "@/features/dashboard/components/table";
import { t } from "@/features/dashboard/i18n";

export type McpServerEntry = {
  id: number;
  name: string;
  url: string;
  /** Blank means this server is used without a bearer-token credential. */
  tokenEnvName: string;
  permissionPolicy: "always_allow" | "always_ask";
  enabled: boolean;
  isBuiltin: boolean;
  /** Whether token-related environment requirements are satisfied on this server. */
  envPresent: boolean;
  createdAt: string;
  updatedAt: string;
};

export type McpServersNoticeKind =
  | "added"
  | "duplicate"
  | "disabled"
  | "enabled"
  | "invalid"
  | "removed";

export type McpServersPageProps = {
  servers: McpServerEntry[];
  /** Form error or success notice from the previous POST. */
  notice?: { kind: McpServersNoticeKind } | undefined;
};

export const McpServersPage: FC<McpServersPageProps> = (props) => {
  const enabledCount = props.servers.filter((server) => server.enabled).length;
  const missingEnvCount = props.servers.filter(
    (server) => needsTokenEnv(server) && !server.envPresent,
  ).length;

  return (
    <Layout title={t("MCP Servers")} activeNav="mcp-servers">
      <section class="space-y-6">
        <header class="space-y-3">
          <div class="space-y-2">
            <p class="text-xs font-medium uppercase tracking-wider text-brand-700">
              {t("Managed Agents integrations")}
            </p>
            <h1 class="text-3xl font-bold tracking-tight text-neutral-900">{t("MCP Servers")}</h1>
          </div>
          <p class="max-w-3xl text-neutral-500">
            {t(
              "Register remote MCP endpoints that the coordinator and implementer can use during GitHub issue automation. The GitHub MCP server is built in and remains protected, while its token environment variable and policy can still be tuned here.",
            )}
          </p>
          <dl class="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
            <SummaryMetric label={t("registered")} value={props.servers.length} />
            <SummaryMetric label={t("enabled")} value={enabledCount} tone="success" />
            <SummaryMetric label={t("missing env")} value={missingEnvCount} tone="danger" />
          </dl>
        </header>

        {props.notice && <NoticeBanner notice={props.notice} />}

        <AddMcpServerCard />

        <section class="space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div class="space-y-1">
              <h2 class="text-xl font-semibold text-neutral-900">{t("Configured servers")}</h2>
              <p class="text-sm text-neutral-500">
                {t(
                  "Toggle availability without deleting credentials. Missing configured environment variables are highlighted before the next agent registration run.",
                )}
              </p>
            </div>
          </div>

          {props.servers.length === 0 ? (
            <EmptyState />
          ) : (
            <McpServersTable servers={props.servers} />
          )}
        </section>
      </section>
    </Layout>
  );
};

const SummaryMetric: FC<{
  label: string;
  value: number;
  tone?: "default" | "danger" | "success";
}> = ({ label, tone = "default", value }) => {
  const toneClass =
    tone === "success"
      ? "border-success-200 bg-success-50 text-success-700"
      : tone === "danger"
        ? "border-danger-200 bg-danger-50 text-danger-700"
        : "border-neutral-200 bg-surface text-neutral-700";

  return (
    <div class={`rounded-xl border px-4 py-3 shadow-sm ${toneClass}`}>
      <dt class="text-xs font-medium uppercase tracking-wider opacity-80">{label}</dt>
      <dd class="mt-1 font-mono text-2xl font-semibold text-neutral-900">{value}</dd>
    </div>
  );
};

const AddMcpServerCard: FC = () => (
  <article class="bg-surface border border-neutral-200 rounded-xl p-6 space-y-5 shadow-sm animate-fade-in-up">
    <div class="space-y-2">
      <h2 class="text-xl font-semibold text-neutral-900">{t("Add MCP server")}</h2>
      <p class="text-sm text-neutral-500 max-w-3xl">
        {t(
          "Add an HTTP(S) MCP endpoint. Optionally provide an environment variable containing a bearer token; leave it blank for public endpoints. Tokens are never stored in the dashboard database.",
        )}
      </p>
    </div>

    <form method="post" action="/mcp-servers" class="space-y-5">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="space-y-2">
          <label htmlFor="mcp-name" class="block text-sm font-medium text-neutral-900">
            {t("Name")}
          </label>
          <input
            type="text"
            id="mcp-name"
            name="name"
            required
            maxLength={64}
            pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
            placeholder="linear"
            class="block w-full rounded-md border border-neutral-300 bg-surface px-3 py-2 font-mono text-sm text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
          <p class="text-xs text-neutral-500">{t("Used as the Managed Agents mcp_server_name.")}</p>
        </div>

        <div class="space-y-2">
          <label htmlFor="mcp-url" class="block text-sm font-medium text-neutral-900">
            {t("URL")}
          </label>
          <input
            type="url"
            id="mcp-url"
            name="url"
            required
            maxLength={2048}
            placeholder="https://mcp.example.com/"
            class="block w-full rounded-md border border-neutral-300 bg-surface px-3 py-2 font-mono text-sm text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>

        <div class="space-y-2">
          <label htmlFor="mcp-token-env" class="block text-sm font-medium text-neutral-900">
            {t("Token env var")} {t("(Optional)")}
          </label>
          <input
            type="text"
            id="mcp-token-env"
            name="tokenEnvName"
            maxLength={128}
            pattern="[A-Za-z_][A-Za-z0-9_]*"
            placeholder="LINEAR_API_KEY"
            class="block w-full rounded-md border border-neutral-300 bg-surface px-3 py-2 font-mono text-sm text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
          <p class="text-xs text-neutral-500">
            {t("Leave blank for public or unauthenticated MCP servers.")}
          </p>
        </div>

        <div class="space-y-2">
          <label htmlFor="mcp-permission-policy" class="block text-sm font-medium text-neutral-900">
            {t("Permission policy")}
          </label>
          <select
            id="mcp-permission-policy"
            name="permissionPolicy"
            class="block w-full rounded-md border border-neutral-300 bg-surface px-3 py-2 text-sm text-neutral-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          >
            <option value="always_allow" selected>
              always_allow
            </option>
          </select>
        </div>
      </div>

      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pt-2 border-t border-neutral-100">
        <label class="flex items-start gap-3 text-sm text-neutral-700">
          <input
            type="checkbox"
            name="enabled"
            value="on"
            checked
            class="mt-0.5 h-4 w-4 rounded border-neutral-300 text-brand-600 focus:ring-brand-500"
          />
          <span>
            <span class="font-medium text-neutral-900">{t("Enable immediately")}</span>
            <span class="block text-neutral-500">
              {t("Disabled servers remain saved but are not used.")}
            </span>
          </span>
        </label>
        <button
          type="submit"
          class="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors whitespace-nowrap"
        >
          {t("Add MCP server")}
        </button>
      </div>
    </form>
  </article>
);

const McpServersTable: FC<{ servers: McpServerEntry[] }> = ({ servers }) => (
  <Table
    columns={[t("server"), t("url"), t("token"), t("policy"), t("state"), t("env"), t("actions")]}
  >
    {servers.map((server) => (
      <McpServerRow key={server.id} server={server} />
    ))}
  </Table>
);

const McpServerRow: FC<{ server: McpServerEntry }> = ({ server }) => (
  <tr class="hover:bg-neutral-50 transition-colors">
    <td class="px-4 py-3">
      <div class="flex flex-wrap items-center gap-2">
        <a
          href={`/mcp-servers/${server.id}`}
          class="font-mono text-brand-600 hover:text-brand-700 font-medium"
        >
          {server.name}
        </a>
        {server.isBuiltin && <BuiltinBadge />}
      </div>
    </td>
    <td class="px-4 py-3 max-w-xs">
      <code class="block truncate font-mono text-sm text-neutral-600" title={server.url}>
        {server.url}
      </code>
    </td>
    <td class="px-4 py-3">
      {server.tokenEnvName.length > 0 ? (
        <code class="font-mono text-sm text-neutral-900">{server.tokenEnvName}</code>
      ) : (
        <span class="text-sm text-neutral-500">{t("not required")}</span>
      )}
    </td>
    <td class="px-4 py-3">
      <PermissionPolicyBadge policy={server.permissionPolicy} />
    </td>
    <td class="px-4 py-3">
      <div class="flex items-center gap-2">
        <EnabledBadge enabled={server.enabled} />
        {server.isBuiltin && server.enabled ? (
          <button
            type="button"
            disabled
            class="inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium text-neutral-400 bg-neutral-50 border border-neutral-200 rounded-md cursor-not-allowed"
          >
            {t("Disable")}
          </button>
        ) : (
          <form
            method="post"
            action={`/mcp-servers/${server.id}/${server.enabled ? "disable" : "enable"}`}
          >
            <button
              type="submit"
              class={
                server.enabled
                  ? "inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium text-neutral-900 bg-surface border border-neutral-200 rounded-md hover:bg-neutral-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
                  : "inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium text-white bg-brand-600 border border-transparent rounded-md hover:bg-brand-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
              }
            >
              {server.enabled ? t("Disable") : t("Enable")}
            </button>
          </form>
        )}
      </div>
    </td>
    <td class="px-4 py-3">
      <EnvStatusBadge server={server} />
    </td>
    <td class="px-4 py-3">
      <div class="flex items-center gap-2">
        <a
          href={`/mcp-servers/${server.id}`}
          class="inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium text-brand-700 bg-brand-50 border border-brand-200 rounded-md hover:bg-brand-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-500 transition-colors"
        >
          {t("Edit")}
        </a>
        {server.isBuiltin ? (
          <button
            type="button"
            disabled
            class="inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium text-neutral-400 bg-neutral-50 border border-neutral-200 rounded-md cursor-not-allowed"
          >
            {t("Delete")}
          </button>
        ) : (
          <form method="post" action={`/mcp-servers/${server.id}/delete`}>
            <button
              type="submit"
              class="inline-flex items-center justify-center px-3 py-1.5 text-xs font-medium text-danger-700 bg-danger-50 border border-danger-200 rounded-md hover:bg-danger-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-danger-500 transition-colors"
            >
              {t("Delete")}
            </button>
          </form>
        )}
      </div>
    </td>
  </tr>
);

const PermissionPolicyBadge: FC<{ policy: McpServerEntry["permissionPolicy"] }> = ({ policy }) => (
  <span
    class={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide border ${
      policy === "always_allow"
        ? "bg-success-50 text-success-700 border-success-200"
        : "bg-warning-50 text-warning-700 border-warning-200"
    }`}
  >
    {policy === "always_allow" ? t("allow") : t("ask")}
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
      {server.envPresent ? t("loaded") : t("missing")}
    </span>
  );
};

const BuiltinBadge: FC = () => (
  <span class="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono uppercase tracking-wide bg-info-50 text-info-700 border border-info-200">
    {t("builtin")}
  </span>
);

const NoticeBanner: FC<{ notice: NonNullable<McpServersPageProps["notice"]> }> = ({ notice }) => {
  const isProblem = notice.kind === "duplicate" || notice.kind === "invalid";
  const isWarning = notice.kind === "disabled" || notice.kind === "duplicate";
  const toneClass = isProblem
    ? isWarning
      ? "bg-warning-50 border-warning-200 text-warning-700"
      : "bg-danger-50 border-danger-200 text-danger-700"
    : notice.kind === "disabled"
      ? "bg-warning-50 border-warning-200 text-warning-700"
      : "bg-success-50 border-success-200 text-success-700";

  return (
    <div class={`rounded-md border p-3 text-sm ${toneClass}`} role="status" aria-live="polite">
      {noticeMessage(notice.kind)}
    </div>
  );
};

const EmptyState: FC = () => (
  <div class="text-center py-16 px-4 border-2 border-dashed border-neutral-200 rounded-xl bg-surface">
    <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-neutral-100 text-neutral-400 mb-4">
      <span class="text-2xl leading-none">⎔</span>
    </div>
    <h3 class="text-lg font-medium text-neutral-900 mb-1">{t("No MCP servers configured")}</h3>
    <p class="text-neutral-500">
      {t(
        "The builtin GitHub MCP server should be seeded automatically when the database initializes.",
      )}
    </p>
  </div>
);

function noticeMessage(kind: McpServersNoticeKind): string {
  switch (kind) {
    case "added":
      return t("MCP server added.");
    case "duplicate":
      return t("A MCP server with that name already exists.");
    case "disabled":
      return t("MCP server disabled.");
    case "enabled":
      return t("MCP server enabled.");
    case "invalid":
      return t("Invalid MCP server form submission.");
    case "removed":
      return t("MCP server removed.");
  }
}
