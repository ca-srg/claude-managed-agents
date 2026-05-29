#!/usr/bin/env bun

import { createHash, timingSafeEqual } from "node:crypto";
import process from "node:process";

import { createLogger } from "@/shared/logging";

type BunServer = {
  stop(force?: boolean): void;
};

type BunRuntime = {
  serve(options: {
    fetch: (request: Request) => Response | Promise<Response>;
    hostname: string;
    idleTimeout?: number;
    port: number;
  }): BunServer;
};

declare const Bun: BunRuntime;

type GatewayEnv = {
  allowedClientCidrs: string[];
  disableClientIpCheck: boolean;
  host: string;
  logLevel?: string;
  port: number;
  token: string;
  upstreamUrl: URL;
};

export type McpGatewayOptions = {
  allowedClientCidrs?: readonly string[];
  /**
   * Skip the `CF-Connecting-IP` based CIDR allowlist entirely.
   *
   * Production keeps this `false` so the gateway only accepts traffic that
   * Cloudflare Tunnel has annotated with a single trusted client IP from the
   * Claude Managed Agents outbound CIDR. Local development tunnels
   * (e.g. ngrok) do not provide that header, so the dev supervisor sets
   * `MCP_GATEWAY_DISABLE_CLIENT_IP_CHECK=true` to bypass the check while
   * still enforcing the Bearer token.
   */
  disableClientIpCheck?: boolean;
  logger?: Pick<ReturnType<typeof createLogger>, "debug" | "error" | "info" | "warn">;
  token: string;
  upstreamUrl: string | URL;
};

type Ipv4CidrRange = {
  mask: number;
  network: number;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8097;
const DEFAULT_UPSTREAM_URL = "http://127.0.0.1:8096";
const DEFAULT_ALLOWED_CLIENT_CIDRS = ["160.79.104.0/21"] as const;
const HEALTH_PATH = "/healthz";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requiredEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    process.stderr.write(`${name} is required\n`);
    process.exit(1);
  }

  return value;
}

function optionalEnv(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function parsePort(rawPort: string | undefined): number {
  const port = Number.parseInt(rawPort ?? String(DEFAULT_PORT), 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    process.stderr.write("MCP_GATEWAY_PORT must be an integer between 1 and 65535\n");
    process.exit(1);
  }

  return port;
}

function parseUrl(name: string, rawUrl: string | undefined): URL {
  try {
    const url = new URL(rawUrl ?? DEFAULT_UPSTREAM_URL);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("protocol must be http or https");
    }

    return url;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${name} must be a valid http(s) URL: ${message}\n`);
    process.exit(1);
  }
}

function parseIpv4Address(value: string): number | undefined {
  const parts = value.trim().split(".");

  if (parts.length !== 4) {
    return undefined;
  }

  let address = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return undefined;
    }

    const octet = Number.parseInt(part, 10);
    if (octet < 0 || octet > 255) {
      return undefined;
    }

    address = address * 256 + octet;
  }

  return address >>> 0;
}

function ipv4MaskForPrefixLength(prefixLength: number): number {
  return prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
}

function parseIpv4CidrRange(cidr: string): Ipv4CidrRange {
  const trimmedCidr = cidr.trim();
  const [rawAddress, rawPrefixLength, extra] = trimmedCidr.split("/");

  if (typeof rawAddress !== "string" || rawAddress.length === 0 || extra !== undefined) {
    throw new Error(`${cidr} is not a valid IPv4 CIDR`);
  }

  const address = parseIpv4Address(rawAddress);
  if (typeof address === "undefined") {
    throw new Error(`${cidr} has an invalid IPv4 address`);
  }

  if (typeof rawPrefixLength !== "undefined" && !/^\d+$/.test(rawPrefixLength)) {
    throw new Error(`${cidr} has an invalid IPv4 prefix length`);
  }

  const prefixLength =
    typeof rawPrefixLength === "undefined" ? 32 : Number.parseInt(rawPrefixLength, 10);

  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    throw new Error(`${cidr} has an invalid IPv4 prefix length`);
  }

  const mask = ipv4MaskForPrefixLength(prefixLength);

  return {
    mask,
    network: (address & mask) >>> 0,
  };
}

function compileIpv4CidrRanges(cidrs: readonly string[]): Ipv4CidrRange[] {
  if (cidrs.length === 0) {
    throw new Error("at least one IPv4 CIDR is required");
  }

  return cidrs.map(parseIpv4CidrRange);
}

function parseAllowedClientCidrs(rawCidrs: string | undefined): string[] {
  const configuredCidrs = optionalEnv(rawCidrs);
  if (typeof configuredCidrs === "undefined") {
    return [...DEFAULT_ALLOWED_CLIENT_CIDRS];
  }

  const cidrs = configuredCidrs
    .split(",")
    .map((cidr) => cidr.trim())
    .filter((cidr) => cidr.length > 0);

  try {
    compileIpv4CidrRanges(cidrs);
    return cidrs;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `MCP_GATEWAY_ALLOWED_CLIENT_CIDRS must contain IPv4 CIDR ranges: ${message}\n`,
    );
    process.exit(1);
  }
}

function parseBooleanEnv(name: string, value: string | undefined): boolean {
  const raw = optionalEnv(value);
  if (raw === undefined) {
    return false;
  }

  const normalized = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  process.stderr.write(`${name} must be a boolean-like value (true/false/1/0/yes/no)\n`);
  process.exit(1);
}

export function readGatewayEnv(env: NodeJS.ProcessEnv): GatewayEnv {
  return {
    allowedClientCidrs: parseAllowedClientCidrs(env.MCP_GATEWAY_ALLOWED_CLIENT_CIDRS),
    disableClientIpCheck: parseBooleanEnv(
      "MCP_GATEWAY_DISABLE_CLIENT_IP_CHECK",
      env.MCP_GATEWAY_DISABLE_CLIENT_IP_CHECK,
    ),
    host: optionalEnv(env.MCP_GATEWAY_HOST) ?? DEFAULT_HOST,
    logLevel: optionalEnv(env.LOG_LEVEL),
    port: parsePort(env.MCP_GATEWAY_PORT),
    token: requiredEnv("MCP_GATEWAY_TOKEN", env.MCP_GATEWAY_TOKEN),
    upstreamUrl: parseUrl("MCP_GATEWAY_UPSTREAM_URL", env.MCP_GATEWAY_UPSTREAM_URL),
  };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeTokenEquals(actualToken: string, expectedToken: string): boolean {
  return timingSafeEqual(sha256(actualToken), sha256(expectedToken));
}

function parseBearerToken(authorizationHeader: string | null): string | undefined {
  if (authorizationHeader === null) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match?.[1];
}

function isAuthorized(request: Request, expectedToken: string): boolean {
  const actualToken = parseBearerToken(request.headers.get("authorization"));
  return typeof actualToken === "string" && safeTokenEquals(actualToken, expectedToken);
}

function extractFirstHeaderIp(headerValue: string | null): string | undefined {
  if (headerValue === null) {
    return undefined;
  }

  const firstValue = headerValue.split(",")[0]?.trim();
  if (typeof firstValue === "undefined" || firstValue.length === 0) {
    return undefined;
  }

  if (firstValue.toLowerCase() === "unknown") {
    return undefined;
  }

  return /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(firstValue)?.[1] ?? firstValue;
}

function extractClientIp(request: Request): string | undefined {
  // The Fly deployment binds the gateway to localhost and exposes it only via
  // Cloudflare Tunnel. Trust Cloudflare's single-hop client IP header for
  // authorization, and do not fall back to X-Forwarded-For because the leftmost
  // value can be supplied by the client at the edge.
  return extractFirstHeaderIp(request.headers.get("cf-connecting-ip"));
}

function isClientIpAllowed(
  clientIp: string | undefined,
  ranges: readonly Ipv4CidrRange[],
): boolean {
  if (typeof clientIp === "undefined") {
    return false;
  }

  const address = parseIpv4Address(clientIp);
  if (typeof address === "undefined") {
    return false;
  }

  return ranges.some((range) => {
    const maskedAddress = (address & range.mask) >>> 0;
    return maskedAddress === range.network;
  });
}

function copyRequestHeaders(request: Request): Headers {
  const headers = new Headers();

  for (const [name, value] of request.headers) {
    const lowerName = name.toLowerCase();

    if (
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      lowerName === "authorization" ||
      lowerName === "host" ||
      lowerName === "x-forwarded-for"
    ) {
      continue;
    }

    headers.append(name, value);
  }

  const forwardedFor = request.headers.get("cf-connecting-ip");
  if (forwardedFor !== null) {
    headers.set("x-forwarded-for", forwardedFor);
  }

  const requestUrl = new URL(request.url);
  headers.set("x-forwarded-host", request.headers.get("host") ?? requestUrl.host);
  headers.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""));

  return headers;
}

function copyResponseHeaders(response: Response): Headers {
  const headers = new Headers();

  for (const [name, value] of response.headers) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      headers.append(name, value);
    }
  }

  return headers;
}

export function buildUpstreamRequestUrl(requestUrl: string | URL, upstreamUrl: string | URL): URL {
  const incoming = new URL(requestUrl);
  const upstream = new URL(upstreamUrl);
  const upstreamBasePath = upstream.pathname === "/" ? "" : upstream.pathname.replace(/\/$/, "");

  upstream.pathname = `${upstreamBasePath}${incoming.pathname}`;
  upstream.search = incoming.search;

  return upstream;
}

function createProxyRequestInit(request: Request): RequestInit & { duplex?: "half" } {
  const init: RequestInit & { duplex?: "half" } = {
    headers: copyRequestHeaders(request),
    method: request.method,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  return init;
}

export function createMcpGatewayHandler(options: McpGatewayOptions) {
  const allowedClientCidrs = options.allowedClientCidrs ?? DEFAULT_ALLOWED_CLIENT_CIDRS;
  const allowedClientRanges = compileIpv4CidrRanges(allowedClientCidrs);
  const disableClientIpCheck = options.disableClientIpCheck ?? false;
  const upstreamUrl = new URL(options.upstreamUrl);
  const logger = options.logger;

  return async function handleMcpGatewayRequest(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === HEALTH_PATH) {
      return Response.json({ ok: true });
    }

    if (!isAuthorized(request, options.token)) {
      logger?.warn(
        { method: request.method, path: requestUrl.pathname },
        "MCP gateway rejected request",
      );
      return new Response("Unauthorized", {
        headers: { "www-authenticate": "Bearer" },
        status: 401,
      });
    }

    if (!disableClientIpCheck) {
      const clientIp = extractClientIp(request);
      if (!isClientIpAllowed(clientIp, allowedClientRanges)) {
        logger?.warn(
          {
            allowedClientCidrs,
            clientIp: clientIp ?? "unknown",
            method: request.method,
            path: requestUrl.pathname,
          },
          "MCP gateway rejected request from disallowed client IP",
        );
        return new Response("Forbidden", { status: 403 });
      }
    }

    const targetUrl = buildUpstreamRequestUrl(requestUrl, upstreamUrl);

    try {
      logger?.debug(
        { method: request.method, path: requestUrl.pathname },
        "MCP gateway proxying request",
      );
      const upstreamResponse = await fetch(targetUrl, createProxyRequestInit(request));

      return new Response(upstreamResponse.body, {
        headers: copyResponseHeaders(upstreamResponse),
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
      });
    } catch (error) {
      logger?.error(
        {
          err: error,
          method: request.method,
          path: requestUrl.pathname,
          upstreamOrigin: targetUrl.origin,
        },
        "MCP gateway upstream request failed",
      );

      return new Response("Bad Gateway", { status: 502 });
    }
  };
}

function startGateway(runtime: BunRuntime, env: GatewayEnv): BunServer {
  const logger = createLogger({ level: env.logLevel }).child({ component: "mcp-gateway" });
  const server = runtime.serve({
    fetch: createMcpGatewayHandler({
      allowedClientCidrs: env.allowedClientCidrs,
      disableClientIpCheck: env.disableClientIpCheck,
      logger,
      token: env.token,
      upstreamUrl: env.upstreamUrl,
    }),
    hostname: env.host,
    idleTimeout: 0,
    port: env.port,
  });

  logger.info(
    {
      allowedClientCidrs: env.allowedClientCidrs,
      disableClientIpCheck: env.disableClientIpCheck,
      host: env.host,
      port: env.port,
      upstreamUrl: env.upstreamUrl.href,
    },
    "MCP gateway started",
  );

  return server;
}

if (import.meta.main) {
  startGateway(Bun, readGatewayEnv(process.env));
}
