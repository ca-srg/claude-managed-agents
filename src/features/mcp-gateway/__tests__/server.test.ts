import { describe, expect, test } from "bun:test";

import { buildUpstreamRequestUrl, createMcpGatewayHandler } from "@/features/mcp-gateway/server";

type BunServer = {
  port: number;
  stop(force?: boolean): void;
};

type UpstreamHit = {
  body: string;
  headers: Record<string, string>;
  method: string;
  path: string;
  search: string;
};

type Upstream = {
  hits: UpstreamHit[];
  server: BunServer;
  url: string;
};

declare const Bun: {
  serve(options: {
    fetch: (request: Request) => Response | Promise<Response>;
    hostname?: string;
    port?: number;
  }): BunServer;
};

const TOKEN = "test-gateway-token";
const CLAUDE_MANAGED_AGENT_IP = "160.79.104.42";
const NON_CLAUDE_IP = "198.51.100.42";

function authorizedHeaders(clientIp = CLAUDE_MANAGED_AGENT_IP): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "cf-connecting-ip": clientIp,
  };
}

function startUpstream(): Upstream {
  const hits: UpstreamHit[] = [];

  const server = Bun.serve({
    async fetch(request) {
      const url = new URL(request.url);
      const body =
        request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
      const headers: Record<string, string> = {};
      for (const [name, value] of request.headers) {
        headers[name.toLowerCase()] = value;
      }

      hits.push({
        body,
        headers,
        method: request.method,
        path: url.pathname,
        search: url.search,
      });

      return new Response(`upstream ok ${request.method} ${url.pathname}`, {
        headers: { "content-type": "text/plain", "x-upstream": "1" },
        status: 200,
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });

  return { hits, server, url: `http://127.0.0.1:${server.port}` };
}

async function withUpstream<T>(testBody: (upstream: Upstream) => Promise<T>): Promise<T> {
  const upstream = startUpstream();

  try {
    return await testBody(upstream);
  } finally {
    upstream.server.stop(true);
  }
}

function firstHit(upstream: Upstream): UpstreamHit {
  const hit = upstream.hits[0];
  if (hit === undefined) {
    throw new Error("expected upstream to have received at least one request");
  }
  return hit;
}

describe("createMcpGatewayHandler", () => {
  test("returns 200 for the health check without auth", async () => {
    await withUpstream(async (upstream) => {
      const handler = createMcpGatewayHandler({ token: TOKEN, upstreamUrl: upstream.url });

      const response = await handler(new Request("http://127.0.0.1:8097/healthz"));

      expect(response.status).toBe(200);
      expect(upstream.hits).toHaveLength(0);
    });
  });

  test("rejects requests without an Authorization header", async () => {
    await withUpstream(async (upstream) => {
      const handler = createMcpGatewayHandler({ token: TOKEN, upstreamUrl: upstream.url });

      const response = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp", { method: "POST" }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(upstream.hits).toHaveLength(0);
    });
  });

  test("rejects requests with a wrong bearer token", async () => {
    await withUpstream(async (upstream) => {
      const handler = createMcpGatewayHandler({ token: TOKEN, upstreamUrl: upstream.url });

      const response = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp", {
          headers: { ...authorizedHeaders(), authorization: "Bearer wrong-token" },
          method: "POST",
        }),
      );

      expect(response.status).toBe(401);
      expect(upstream.hits).toHaveLength(0);
    });
  });

  test("rejects requests without a client IP even when the token matches", async () => {
    await withUpstream(async (upstream) => {
      const handler = createMcpGatewayHandler({ token: TOKEN, upstreamUrl: upstream.url });

      const response = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp", {
          headers: { authorization: `Bearer ${TOKEN}` },
          method: "POST",
        }),
      );

      expect(response.status).toBe(403);
      expect(upstream.hits).toHaveLength(0);
    });
  });

  test("rejects requests from outside the Claude Managed Agents outbound CIDR", async () => {
    await withUpstream(async (upstream) => {
      const handler = createMcpGatewayHandler({ token: TOKEN, upstreamUrl: upstream.url });

      const response = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp", {
          headers: authorizedHeaders(NON_CLAUDE_IP),
          method: "POST",
        }),
      );

      expect(response.status).toBe(403);
      expect(upstream.hits).toHaveLength(0);
    });
  });

  test("matches the Claude Managed Agents outbound CIDR boundaries", async () => {
    await withUpstream(async (upstream) => {
      const handler = createMcpGatewayHandler({ token: TOKEN, upstreamUrl: upstream.url });

      const lowerBoundaryResponse = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp", {
          headers: authorizedHeaders("160.79.104.0"),
          method: "POST",
        }),
      );
      const upperBoundaryResponse = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp", {
          headers: authorizedHeaders("160.79.111.255"),
          method: "POST",
        }),
      );
      const beforeRangeResponse = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp", {
          headers: authorizedHeaders("160.79.103.255"),
          method: "POST",
        }),
      );
      const afterRangeResponse = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp", {
          headers: authorizedHeaders("160.79.112.0"),
          method: "POST",
        }),
      );

      expect(lowerBoundaryResponse.status).toBe(200);
      expect(upperBoundaryResponse.status).toBe(200);
      expect(beforeRangeResponse.status).toBe(403);
      expect(afterRangeResponse.status).toBe(403);
      expect(upstream.hits).toHaveLength(2);
    });
  });

  test("forwards path, query, method, and body to the upstream when the token matches", async () => {
    await withUpstream(async (upstream) => {
      const handler = createMcpGatewayHandler({ token: TOKEN, upstreamUrl: upstream.url });

      const response = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp?trace=1", {
          body: '{"hello":"world"}',
          headers: {
            ...authorizedHeaders(),
            "content-type": "application/json",
            "x-forwarded-for": NON_CLAUDE_IP,
          },
          method: "POST",
        }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("x-upstream")).toBe("1");
      expect(await response.text()).toBe("upstream ok POST /servers/figma/mcp");

      expect(upstream.hits).toHaveLength(1);
      const hit = firstHit(upstream);
      expect(hit.method).toBe("POST");
      expect(hit.path).toBe("/servers/figma/mcp");
      expect(hit.search).toBe("?trace=1");
      expect(hit.body).toBe('{"hello":"world"}');
      expect(hit.headers.authorization).toBeUndefined();
      expect(hit.headers["content-type"]).toBe("application/json");
      expect(hit.headers["x-forwarded-for"]).toBe(CLAUDE_MANAGED_AGENT_IP);
      expect(hit.headers["x-forwarded-host"]).toBe("127.0.0.1:8097");
      expect(hit.headers["x-forwarded-proto"]).toBe("http");
    });
  });

  test("rejects X-Forwarded-For-only requests even when the leftmost IP is allowed", async () => {
    await withUpstream(async (upstream) => {
      const handler = createMcpGatewayHandler({ token: TOKEN, upstreamUrl: upstream.url });

      const response = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp", {
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "x-forwarded-for": `${CLAUDE_MANAGED_AGENT_IP}, 10.0.0.1`,
          },
          method: "POST",
        }),
      );

      expect(response.status).toBe(403);
      expect(upstream.hits).toHaveLength(0);
    });
  });

  test("allows overriding the permitted client CIDR list", async () => {
    await withUpstream(async (upstream) => {
      const handler = createMcpGatewayHandler({
        allowedClientCidrs: ["198.51.100.0/24"],
        token: TOKEN,
        upstreamUrl: upstream.url,
      });

      const response = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp", {
          headers: authorizedHeaders(NON_CLAUDE_IP),
          method: "POST",
        }),
      );

      expect(response.status).toBe(200);
      expect(upstream.hits).toHaveLength(1);
    });
  });

  test("rejects invalid client CIDR configuration", () => {
    expect(() =>
      createMcpGatewayHandler({
        allowedClientCidrs: ["160.79.104.0/33"],
        token: TOKEN,
        upstreamUrl: "http://127.0.0.1:8096",
      }),
    ).toThrow("invalid IPv4 prefix length");
  });

  test("bypasses the CIDR allowlist when disableClientIpCheck is true", async () => {
    await withUpstream(async (upstream) => {
      const handler = createMcpGatewayHandler({
        disableClientIpCheck: true,
        token: TOKEN,
        upstreamUrl: upstream.url,
      });

      // No CF-Connecting-IP header at all, would normally be rejected with 403.
      const response = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp", {
          headers: { authorization: `Bearer ${TOKEN}` },
          method: "POST",
        }),
      );

      expect(response.status).toBe(200);
      expect(upstream.hits).toHaveLength(1);
    });
  });

  test("still rejects unauthorized requests when disableClientIpCheck is true", async () => {
    await withUpstream(async (upstream) => {
      const handler = createMcpGatewayHandler({
        disableClientIpCheck: true,
        token: TOKEN,
        upstreamUrl: upstream.url,
      });

      const response = await handler(
        new Request("http://127.0.0.1:8097/servers/figma/mcp", {
          headers: { authorization: "Bearer wrong-token" },
          method: "POST",
        }),
      );

      expect(response.status).toBe(401);
      expect(upstream.hits).toHaveLength(0);
    });
  });

  test("returns 502 when the upstream is unreachable", async () => {
    const handler = createMcpGatewayHandler({
      token: TOKEN,
      // Reserved discard port; connection refused.
      upstreamUrl: "http://127.0.0.1:9",
    });

    const response = await handler(
      new Request("http://127.0.0.1:8097/servers/figma/mcp", {
        headers: authorizedHeaders(),
        method: "POST",
      }),
    );

    expect(response.status).toBe(502);
  });
});

describe("buildUpstreamRequestUrl", () => {
  test("preserves path and query against a bare-origin upstream", () => {
    const url = buildUpstreamRequestUrl(
      "http://localhost:8097/servers/figma/mcp?trace=1",
      "http://127.0.0.1:8096",
    );

    expect(url.origin).toBe("http://127.0.0.1:8096");
    expect(url.pathname).toBe("/servers/figma/mcp");
    expect(url.search).toBe("?trace=1");
  });

  test("appends to a base path on the upstream", () => {
    const url = buildUpstreamRequestUrl(
      "http://localhost:8097/servers/figma/mcp",
      "http://127.0.0.1:8096/base/",
    );

    expect(url.pathname).toBe("/base/servers/figma/mcp");
  });
});
