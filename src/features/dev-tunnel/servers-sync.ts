import type { Logger } from "pino";

import type { McpServerRow as McpServer } from "@/shared/persistence/schemas";

type DbForServersSync = {
  createMcpServer: (input: unknown) => McpServer;
  getMcpServerByName: (name: string) => McpServer | null;
  listMcpServers: (opts?: { enabledOnly?: boolean }) => McpServer[];
  updateMcpServer: (id: number, input: unknown) => McpServer;
};

export type SyncDevTunnelServersOptions = {
  db: DbForServersSync;
  logger: Pick<Logger, "info" | "warn">;
  /** Public base URL (e.g. `https://abc.ngrok.app`); no trailing slash required. */
  publicBaseUrl: string;
  /** mcp-proxy named-server names that should be exposed through the tunnel. */
  serverNames: readonly string[];
  /** Env var name holding the Bearer token used to call the gateway. */
  tokenEnvName: string;
};

/**
 * Compose the public URL that Managed Agents will call.
 *
 * mcp-proxy exposes each named server as both `/servers/<name>/mcp` (Streamable
 * HTTP) and `/servers/<name>/sse` (legacy SSE). The Managed Agents
 * `mcp_servers` definition currently uses Streamable HTTP, so we register the
 * `.../mcp` URL.
 */
export function buildServerUrl(publicBaseUrl: string, name: string): string {
  const trimmed = publicBaseUrl.replace(/\/+$/, "");
  return `${trimmed}/servers/${name}/mcp`;
}

/**
 * Reconcile the `mcp_servers` table so that each tunnel-backed server name
 * points at the current ngrok public URL.
 *
 * - Builtin rows (`is_builtin = 1`) are never modified: their name/url are
 *   immutable, and overwriting their token_env_name would break the GitHub
 *   App installation token plumbing. A warning is logged if a tunnel target
 *   collides with a builtin name.
 * - Existing non-builtin rows are updated in place when their url or
 *   token_env_name drift from the desired value, and re-enabled if disabled.
 * - Missing rows are created with `permissionPolicy = always_allow`.
 * - Enabled, non-builtin rows that use the same gateway token env var are
 *   treated as dev-tunnel-managed. If they are not in the current target set,
 *   they are disabled so old ngrok URLs are not attached to future agents.
 *
 * The function is idempotent: running it again with the same inputs is a
 * no-op except for the implicit `updated_at` bump on changed rows.
 */
export function syncDevTunnelServers(opts: SyncDevTunnelServersOptions): void {
  const targetNames = new Set(opts.serverNames);
  const existingByName = new Map<string, McpServer | null>();
  for (const name of targetNames) {
    existingByName.set(name, opts.db.getMcpServerByName(name));
  }

  for (const existing of opts.db.listMcpServers({ enabledOnly: true })) {
    if (
      existing.isBuiltin ||
      existing.tokenEnvName !== opts.tokenEnvName ||
      targetNames.has(existing.name)
    ) {
      continue;
    }

    opts.db.updateMcpServer(existing.id, { enabled: false });
    opts.logger.info(
      { id: existing.id, name: existing.name },
      "dev-tunnel: disabled stale mcp_servers row",
    );
  }

  for (const name of targetNames) {
    const url = buildServerUrl(opts.publicBaseUrl, name);
    const existing = existingByName.get(name) ?? null;

    if (existing == null) {
      opts.db.createMcpServer({
        enabled: true,
        name,
        permissionPolicy: "always_allow",
        tokenEnvName: opts.tokenEnvName,
        url,
      });
      opts.logger.info({ name, url }, "dev-tunnel: created mcp_servers row");
      continue;
    }

    if (existing.isBuiltin) {
      opts.logger.warn(
        { name },
        "dev-tunnel: target server name collides with a builtin row; skipping",
      );
      continue;
    }

    const needsUrlUpdate = existing.url !== url;
    const needsTokenUpdate = existing.tokenEnvName !== opts.tokenEnvName;
    const needsEnable = !existing.enabled;

    if (!needsUrlUpdate && !needsTokenUpdate && !needsEnable) {
      opts.logger.info({ id: existing.id, name }, "dev-tunnel: mcp_servers row up to date");
      continue;
    }

    opts.db.updateMcpServer(existing.id, {
      enabled: true,
      tokenEnvName: opts.tokenEnvName,
      url,
    });
    opts.logger.info({ id: existing.id, name, url }, "dev-tunnel: updated mcp_servers row");
  }
}
