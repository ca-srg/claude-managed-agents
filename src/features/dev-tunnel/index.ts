import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import type { createLogger } from "@/shared/logging";
import type { createDbModule } from "@/shared/persistence/db";

import { syncDevTunnelServers } from "./servers-sync";

type BunServer = {
  stop(force?: boolean): void;
};

type BunSubprocess = {
  exitCode: number | null;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
  stderr?: ReadableStream<Uint8Array> | null;
  stdout?: ReadableStream<Uint8Array> | null;
};

type BunSpawnOptions = {
  env?: Record<string, string>;
  stderr?: "pipe" | "inherit" | "ignore";
  stdout?: "pipe" | "inherit" | "ignore";
};

type BunRuntime = {
  serve(options: {
    fetch: (request: Request) => Response | Promise<Response>;
    hostname: string;
    idleTimeout?: number;
    port: number;
  }): BunServer;
  spawn(cmd: string[], options?: BunSpawnOptions): BunSubprocess;
};

type Db = ReturnType<typeof createDbModule>;
type Logger = ReturnType<typeof createLogger>;

export type StartDevTunnelOptions = {
  db: Db;
  env?: NodeJS.ProcessEnv;
  logger: Logger;
};

export type DevTunnelHandle = {
  publicUrl: string;
  stop(): Promise<void>;
};

type DevTunnelEnvConfig = {
  authtoken: string;
  // Strip NODE_EXTRA_CA_CERTS from the env propagated to subprocesses.
  //
  // Interactive-shell helpers (notably socket-firewall, which exports
  // NODE_EXTRA_CA_CERTS=/var/folders/.../sfw-XXXX/socketFirewallCa.crt) point
  // the var at an ephemeral CA bundle they own. When that env propagates into
  // the npx child of mcp-proxy, the child's Node tries to load the temp CA
  // for an upstream npm registry the helper does not actually proxy, fails
  // with UNABLE_TO_GET_ISSUER_CERT_LOCALLY, and refuses to fall back to the
  // default trust store. The corporate npm registry usually presents a
  // publicly-trusted cert, so simply dropping NODE_EXTRA_CA_CERTS for the
  // subprocess makes the fetch succeed. Opt-in to keep the door open for
  // users who legitimately need a corporate CA bundle in their subprocesses.
  dropNodeExtraCaCerts: boolean;
  mcpGatewayHost: string;
  mcpGatewayPort: number;
  mcpGatewayToken: string;
  mcpProxyConfigPath: string;
  mcpProxyHost: string;
  mcpProxyPort: number;
  targetServerNames: string[] | undefined;
};

const DEFAULT_MCP_PROXY_HOST = "127.0.0.1";
const DEFAULT_MCP_PROXY_PORT = 8096;
const DEFAULT_MCP_GATEWAY_HOST = "127.0.0.1";
const DEFAULT_MCP_GATEWAY_PORT = 8097;
const DEFAULT_MCP_PROXY_CONFIG = "./mcp-proxy.json";
const HEALTHCHECK_TIMEOUT_MS = 30_000;
const HEALTHCHECK_INTERVAL_MS = 500;
const SHUTDOWN_GRACE_MS = 5_000;
const TOKEN_ENV_NAME = "MCP_GATEWAY_TOKEN";
const EMPTY_TARGET_PUBLIC_BASE_URL = "http://dev-tunnel-empty-target.invalid";

function getBunRuntime(): BunRuntime {
  const runtime = globalThis as typeof globalThis & { Bun?: BunRuntime };
  if (!runtime.Bun) {
    throw new Error("dev-tunnel requires the Bun runtime");
  }
  return runtime.Bun;
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

/**
 * Convert a `NodeJS.ProcessEnv` (which has `string | undefined` values) into
 * the `Record<string, string>` shape that `Bun.spawn` expects. We explicitly
 * forward env to subprocesses so it is obvious from the call site that
 * `process.env` is being propagated (Bun spawns inherit by default, but
 * making it explicit avoids surprises when env is the actual subject of a
 * bug — e.g. `NODE_EXTRA_CA_CERTS` failing to reach the npx child of
 * mcp-proxy).
 *
 * `dropNodeExtraCaCerts` strips `NODE_EXTRA_CA_CERTS` from the propagated
 * env. See `DevTunnelEnvConfig.dropNodeExtraCaCerts` for the rationale.
 */
function toSpawnEnv(
  env: NodeJS.ProcessEnv,
  opts: { dropNodeExtraCaCerts: boolean },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (opts.dropNodeExtraCaCerts && key === "NODE_EXTRA_CA_CERTS") continue;
    out[key] = value;
  }
  return out;
}

/**
 * The npx child of mcp-proxy will run `figma-developer-mcp` from the user's
 * configured npm registry. When that registry uses a private CA bundle
 * (common in corporate / mirror setups like `npm.flatt.tech`), the npx call
 * fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` unless one of
 * `NODE_EXTRA_CA_CERTS` / `~/.npmrc cafile` / `NODE_TLS_REJECT_UNAUTHORIZED`
 * is set in the shell that started `bun run start`. Log the relevant env so
 * the user can spot the cause from the dev-tunnel boot log instead of having
 * to decode the multi-page Python traceback that mcp-proxy emits when the
 * stdio child cannot initialize.
 */
function logTlsRelevantEnv(env: NodeJS.ProcessEnv, logger: Logger): void {
  logger.info(
    {
      nodeExtraCaCerts: env.NODE_EXTRA_CA_CERTS ?? "(unset)",
      nodeTlsRejectUnauthorized: env.NODE_TLS_REJECT_UNAUTHORIZED ?? "(unset)",
      npmConfigRegistry: env.NPM_CONFIG_REGISTRY ?? "(unset; npm will read ~/.npmrc)",
    },
    "dev-tunnel: TLS / npm registry env propagated to mcp-proxy and its npx children",
  );
}

function parsePort(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

/**
 * Parse the subset of environment variables that control the dev tunnel.
 *
 * Returns `undefined` when `ENABLE_DEV_TUNNEL` is unset/falsy so that the
 * production codepath (Cloudflare Tunnel) is unaffected. Throws when the flag
 * is on but required credentials (`NGROK_AUTHTOKEN`, `MCP_GATEWAY_TOKEN`) are
 * missing.
 */
export function parseDevTunnelEnv(env: NodeJS.ProcessEnv): DevTunnelEnvConfig | undefined {
  if (!isTruthy(env.ENABLE_DEV_TUNNEL)) {
    return undefined;
  }

  const authtoken = env.NGROK_AUTHTOKEN?.trim();
  if (!authtoken) {
    throw new Error("ENABLE_DEV_TUNNEL=true requires NGROK_AUTHTOKEN");
  }

  const mcpGatewayToken = env.MCP_GATEWAY_TOKEN?.trim();
  if (!mcpGatewayToken) {
    throw new Error("ENABLE_DEV_TUNNEL=true requires MCP_GATEWAY_TOKEN");
  }

  const targetServerNames = env.DEV_TUNNEL_TARGET_SERVERS?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return {
    authtoken,
    dropNodeExtraCaCerts: isTruthy(env.DEV_TUNNEL_DROP_NODE_EXTRA_CA_CERTS),
    mcpGatewayHost: env.MCP_GATEWAY_HOST?.trim() || DEFAULT_MCP_GATEWAY_HOST,
    mcpGatewayPort: parsePort("MCP_GATEWAY_PORT", env.MCP_GATEWAY_PORT, DEFAULT_MCP_GATEWAY_PORT),
    mcpGatewayToken,
    mcpProxyConfigPath: resolve(
      process.cwd(),
      env.MCP_PROXY_CONFIG?.trim() || DEFAULT_MCP_PROXY_CONFIG,
    ),
    mcpProxyHost: env.MCP_PROXY_HOST?.trim() || DEFAULT_MCP_PROXY_HOST,
    mcpProxyPort: parsePort("MCP_PROXY_PORT", env.MCP_PROXY_PORT, DEFAULT_MCP_PROXY_PORT),
    targetServerNames:
      targetServerNames && targetServerNames.length > 0 ? targetServerNames : undefined,
  };
}

/**
 * Read the named-server keys from the mcp-proxy config file. The shape mirrors
 * the standard MCP `{ mcpServers: { <name>: { command, args } } }` JSON used
 * by mcp-proxy's `--named-server-config`.
 */
export function readMcpProxyServerNames(configPath: string): string[] {
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
  if (parsed.mcpServers == null || typeof parsed.mcpServers !== "object") {
    return [];
  }
  return Object.keys(parsed.mcpServers);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll a URL until any HTTP response is observed (even non-2xx). We treat
 * "connection refused / DNS error" as not-yet-ready and "any response" as
 * ready. This works for both mcp-proxy (no health endpoint, but any path
 * returns something) and mcp-gateway (/healthz returns 200).
 */
async function waitForReachable(
  url: string,
  opts: { intervalMs: number; timeoutMs: number },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { method: "GET" });
      return;
    } catch (err) {
      lastError = err;
    }
    await delay(opts.intervalMs);
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`dev-tunnel: timed out waiting for ${url} (last error: ${reason})`);
}

async function stopSubprocess(
  proc: BunSubprocess | undefined,
  name: string,
  logger: Logger,
): Promise<void> {
  if (proc === undefined || proc.exitCode != null) return;
  try {
    proc.kill("SIGTERM");
  } catch (err) {
    logger.warn({ err, name }, "dev-tunnel: failed to send SIGTERM");
  }
  await Promise.race([proc.exited, delay(SHUTDOWN_GRACE_MS)]);
  if (proc.exitCode == null) {
    logger.warn({ name }, "dev-tunnel: subprocess did not exit after SIGTERM; sending SIGKILL");
    try {
      proc.kill("SIGKILL");
    } catch {
      // best-effort
    }
  }
}

async function pipeStreamToLogger(
  stream: ReadableStream<Uint8Array> | null | undefined,
  component: string,
  level: "info" | "warn",
  logger: Logger,
): Promise<void> {
  if (stream == null) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed.length === 0) continue;
        logger[level]({ component, line: trimmed }, "subprocess log");
      }
    }
    const tail = buffer.trim();
    if (tail.length > 0) {
      logger[level]({ component, line: tail }, "subprocess log");
    }
  } catch (err) {
    logger.warn({ component, err }, "dev-tunnel: stream read failed");
  }
}

/**
 * Start the dev tunnel: spawn mcp-proxy, start the mcp-gateway in-process,
 * open an ngrok tunnel pointing at the gateway, and update the `mcp_servers`
 * DB rows so Managed Agents can reach the local stdio MCP servers.
 *
 * Returns `undefined` when `ENABLE_DEV_TUNNEL` is not enabled. Throws when
 * the flag is on but a precondition (env var, mcp-proxy binary, mcp-proxy
 * config file) is missing.
 *
 * The caller is responsible for awaiting `handle.stop()` during shutdown.
 * The supervisor itself does not register a SIGINT/SIGTERM handler.
 */
export async function startDevTunnel(
  opts: StartDevTunnelOptions,
): Promise<DevTunnelHandle | undefined> {
  const env = opts.env ?? process.env;
  const cfg = parseDevTunnelEnv(env);
  if (cfg == null) return undefined;

  const logger = opts.logger.child({ component: "dev-tunnel" });
  logger.info(
    {
      mcpGatewayPort: cfg.mcpGatewayPort,
      mcpProxyConfig: cfg.mcpProxyConfigPath,
      mcpProxyPort: cfg.mcpProxyPort,
    },
    "starting dev tunnel",
  );

  const serverNamesFromConfig = readMcpProxyServerNames(cfg.mcpProxyConfigPath);
  const targetServers = cfg.targetServerNames ?? serverNamesFromConfig;
  if (targetServers.length === 0) {
    logger.warn(
      { configPath: cfg.mcpProxyConfigPath },
      "dev-tunnel: no target MCP servers (config is empty); skipping tunnel setup",
    );
    syncDevTunnelServers({
      db: opts.db,
      logger,
      publicBaseUrl: EMPTY_TARGET_PUBLIC_BASE_URL,
      serverNames: [],
      tokenEnvName: TOKEN_ENV_NAME,
    });
    return undefined;
  }

  const runtime = getBunRuntime();
  const spawnEnv = toSpawnEnv(env, { dropNodeExtraCaCerts: cfg.dropNodeExtraCaCerts });
  logTlsRelevantEnv(env, logger);
  if (cfg.dropNodeExtraCaCerts) {
    logger.info(
      "dev-tunnel: dropping NODE_EXTRA_CA_CERTS from subprocess env (DEV_TUNNEL_DROP_NODE_EXTRA_CA_CERTS=true)",
    );
  }

  // Step 1: spawn mcp-proxy. Inherit env explicitly so child stdio MCP servers
  // can read user-provided API tokens AND so the npx child of mcp-proxy can
  // see corporate-CA env like NODE_EXTRA_CA_CERTS (the same
  // `--pass-environment` pattern as Fly, plus explicit `env:`).
  let mcpProxyProc: BunSubprocess | undefined;
  try {
    mcpProxyProc = runtime.spawn(
      [
        "mcp-proxy",
        "--host",
        cfg.mcpProxyHost,
        "--port",
        String(cfg.mcpProxyPort),
        "--pass-environment",
        "--allow-origin",
        "*",
        "--named-server-config",
        cfg.mcpProxyConfigPath,
      ],
      { env: spawnEnv, stderr: "pipe", stdout: "pipe" },
    );
  } catch (err) {
    throw new Error(
      `dev-tunnel: failed to spawn mcp-proxy (is it installed and on PATH? \`pip install mcp-proxy\` or see docs/DEVELOPMENT.md): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  void pipeStreamToLogger(mcpProxyProc.stdout, "mcp-proxy", "info", logger);
  void pipeStreamToLogger(mcpProxyProc.stderr, "mcp-proxy", "warn", logger);

  try {
    await waitForReachable(`http://${cfg.mcpProxyHost}:${cfg.mcpProxyPort}/`, {
      intervalMs: HEALTHCHECK_INTERVAL_MS,
      timeoutMs: HEALTHCHECK_TIMEOUT_MS,
    });
  } catch (err) {
    await stopSubprocess(mcpProxyProc, "mcp-proxy", logger);
    throw err;
  }
  logger.info({ port: cfg.mcpProxyPort }, "mcp-proxy ready");

  // Step 2: start mcp-gateway as a separate Bun subprocess. We previously
  // ran the gateway in-process via Bun.serve, but interactive-shell helpers
  // (notably socket-firewall) hook the parent bun process and intercept
  // its outbound/inbound TCP, which makes the in-process listener return
  // "Socket Firewall Connection Required" 405s to ngrok. Spawning the
  // gateway as a child Bun process mirrors the Fly sidecar layout and
  // stays outside that hook surface.
  let mcpGatewayProc: BunSubprocess | undefined;
  try {
    mcpGatewayProc = runtime.spawn(["bun", "src/features/mcp-gateway/server.ts"], {
      env: {
        ...spawnEnv,
        MCP_GATEWAY_DISABLE_CLIENT_IP_CHECK: "true",
        MCP_GATEWAY_HOST: cfg.mcpGatewayHost,
        MCP_GATEWAY_PORT: String(cfg.mcpGatewayPort),
        MCP_GATEWAY_TOKEN: cfg.mcpGatewayToken,
        MCP_GATEWAY_UPSTREAM_URL: `http://${cfg.mcpProxyHost}:${cfg.mcpProxyPort}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
  } catch (err) {
    await stopSubprocess(mcpProxyProc, "mcp-proxy", logger);
    throw new Error(
      `dev-tunnel: failed to spawn mcp-gateway: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  void pipeStreamToLogger(mcpGatewayProc.stdout, "mcp-gateway", "info", logger);
  void pipeStreamToLogger(mcpGatewayProc.stderr, "mcp-gateway", "warn", logger);

  try {
    await waitForReachable(`http://${cfg.mcpGatewayHost}:${cfg.mcpGatewayPort}/healthz`, {
      intervalMs: HEALTHCHECK_INTERVAL_MS,
      timeoutMs: HEALTHCHECK_TIMEOUT_MS,
    });
  } catch (err) {
    await stopSubprocess(mcpGatewayProc, "mcp-gateway", logger);
    await stopSubprocess(mcpProxyProc, "mcp-proxy", logger);
    throw err;
  }
  logger.info({ port: cfg.mcpGatewayPort }, "mcp-gateway subprocess ready");

  // Step 3: open ngrok tunnel pointing at the gateway.
  let listener: { close(): Promise<void>; url(): string | undefined | null } | undefined;
  try {
    const ngrokModule = (await import("@ngrok/ngrok")) as unknown as {
      forward(config: {
        addr: number;
        authtoken: string;
        onStatusChange?: (status: string) => void;
      }): Promise<{ close(): Promise<void>; url(): string | undefined | null }>;
    };
    listener = await ngrokModule.forward({
      addr: cfg.mcpGatewayPort,
      authtoken: cfg.authtoken,
      onStatusChange: (status: string) => {
        logger.info({ status }, "ngrok status changed");
      },
    });
  } catch (err) {
    await stopSubprocess(mcpGatewayProc, "mcp-gateway", logger);
    await stopSubprocess(mcpProxyProc, "mcp-proxy", logger);
    throw err;
  }

  const publicUrl = listener.url();
  if (!publicUrl) {
    await listener.close().catch(() => undefined);
    await stopSubprocess(mcpGatewayProc, "mcp-gateway", logger);
    await stopSubprocess(mcpProxyProc, "mcp-proxy", logger);
    throw new Error("dev-tunnel: ngrok listener returned no public URL");
  }
  logger.info({ publicUrl, targetServers }, "ngrok tunnel up");

  // Step 4: reconcile mcp_servers rows so Managed Agents will call the tunnel.
  try {
    syncDevTunnelServers({
      db: opts.db,
      logger,
      publicBaseUrl: publicUrl,
      serverNames: targetServers,
      tokenEnvName: TOKEN_ENV_NAME,
    });
  } catch (err) {
    try {
      await listener.close();
    } catch (closeErr) {
      logger.warn({ err: closeErr }, "dev-tunnel: failed to close ngrok listener");
    }
    await stopSubprocess(mcpGatewayProc, "mcp-gateway", logger);
    await stopSubprocess(mcpProxyProc, "mcp-proxy", logger);
    throw err;
  }

  const handle: DevTunnelHandle = {
    publicUrl,
    async stop() {
      logger.info("stopping dev tunnel");
      try {
        await listener?.close();
      } catch (err) {
        logger.warn({ err }, "dev-tunnel: failed to close ngrok listener");
      }
      await stopSubprocess(mcpGatewayProc, "mcp-gateway", logger);
      await stopSubprocess(mcpProxyProc, "mcp-proxy", logger);
    },
  };

  return handle;
}
