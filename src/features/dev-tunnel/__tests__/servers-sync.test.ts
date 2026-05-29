import { describe, expect, test } from "bun:test";

import { buildServerUrl, syncDevTunnelServers } from "@/features/dev-tunnel/servers-sync";
import type { McpServerRow as McpServer } from "@/shared/persistence/schemas";

type RecordedCreate = {
  kind: "create";
  payload: unknown;
};
type RecordedUpdate = {
  id: number;
  kind: "update";
  payload: unknown;
};

type FakeDb = {
  createMcpServer: (input: unknown) => McpServer;
  getMcpServerByName: (name: string) => McpServer | null;
  listMcpServers: (opts?: { enabledOnly?: boolean }) => McpServer[];
  records: (RecordedCreate | RecordedUpdate)[];
  rows: McpServer[];
  updateMcpServer: (id: number, input: unknown) => McpServer;
};

function nullLogger() {
  return {
    info: (..._args: unknown[]) => undefined,
    warn: (..._args: unknown[]) => undefined,
  };
}

function makeRow(overrides: Partial<McpServer> & { id: number; name: string }): McpServer {
  return {
    createdAt: "2026-05-27T00:00:00Z",
    enabled: true,
    isBuiltin: false,
    permissionPolicy: "always_allow",
    tokenEnvName: "MCP_GATEWAY_TOKEN",
    updatedAt: "2026-05-27T00:00:00Z",
    url: "https://example.invalid/servers/x/mcp",
    ...overrides,
  };
}

function makeFakeDb(initial: McpServer[] = []): FakeDb {
  const rows = [...initial];
  const records: (RecordedCreate | RecordedUpdate)[] = [];

  const db: FakeDb = {
    createMcpServer(input) {
      records.push({ kind: "create", payload: input });
      const inputAsRow = input as Partial<McpServer> & { name: string };
      const created = makeRow({
        ...inputAsRow,
        id: rows.length + 1,
      });
      rows.push(created);
      return created;
    },
    getMcpServerByName(name) {
      return rows.find((row) => row.name === name) ?? null;
    },
    listMcpServers(opts) {
      if (opts?.enabledOnly === true) {
        return rows.filter((row) => row.enabled);
      }
      return [...rows];
    },
    records,
    rows,
    updateMcpServer(id, input) {
      records.push({ id, kind: "update", payload: input });
      const idx = rows.findIndex((row) => row.id === id);
      const existing = rows[idx];
      if (idx === -1 || existing === undefined) {
        throw new Error(`fake db: row ${id} not found`);
      }
      const patch = input as Partial<McpServer>;
      const updated: McpServer = { ...existing, ...patch };
      rows[idx] = updated;
      return updated;
    },
  };

  return db;
}

describe("buildServerUrl", () => {
  test("composes the streamable HTTP path", () => {
    expect(buildServerUrl("https://abc.ngrok.app", "figma")).toBe(
      "https://abc.ngrok.app/servers/figma/mcp",
    );
  });

  test("strips trailing slashes from the base URL", () => {
    expect(buildServerUrl("https://abc.ngrok.app/", "figma")).toBe(
      "https://abc.ngrok.app/servers/figma/mcp",
    );
    expect(buildServerUrl("https://abc.ngrok.app///", "figma")).toBe(
      "https://abc.ngrok.app/servers/figma/mcp",
    );
  });
});

describe("syncDevTunnelServers", () => {
  test("creates a row when no matching name exists", () => {
    const db = makeFakeDb();
    syncDevTunnelServers({
      db,
      logger: nullLogger(),
      publicBaseUrl: "https://abc.ngrok.app",
      serverNames: ["figma"],
      tokenEnvName: "MCP_GATEWAY_TOKEN",
    });

    expect(db.records).toEqual([
      {
        kind: "create",
        payload: {
          enabled: true,
          name: "figma",
          permissionPolicy: "always_allow",
          tokenEnvName: "MCP_GATEWAY_TOKEN",
          url: "https://abc.ngrok.app/servers/figma/mcp",
        },
      },
    ]);
  });

  test("updates a non-builtin row when the url drifts", () => {
    const db = makeFakeDb([
      makeRow({
        id: 7,
        name: "figma",
        tokenEnvName: "MCP_GATEWAY_TOKEN",
        url: "https://old.ngrok.app/servers/figma/mcp",
      }),
    ]);

    syncDevTunnelServers({
      db,
      logger: nullLogger(),
      publicBaseUrl: "https://new.ngrok.app",
      serverNames: ["figma"],
      tokenEnvName: "MCP_GATEWAY_TOKEN",
    });

    expect(db.records).toEqual([
      {
        id: 7,
        kind: "update",
        payload: {
          enabled: true,
          tokenEnvName: "MCP_GATEWAY_TOKEN",
          url: "https://new.ngrok.app/servers/figma/mcp",
        },
      },
    ]);
  });

  test("re-enables a disabled non-builtin row", () => {
    const db = makeFakeDb([
      makeRow({
        enabled: false,
        id: 3,
        name: "figma",
        url: "https://abc.ngrok.app/servers/figma/mcp",
      }),
    ]);

    syncDevTunnelServers({
      db,
      logger: nullLogger(),
      publicBaseUrl: "https://abc.ngrok.app",
      serverNames: ["figma"],
      tokenEnvName: "MCP_GATEWAY_TOKEN",
    });

    expect(db.records).toHaveLength(1);
    expect(db.records[0]).toMatchObject({
      id: 3,
      kind: "update",
      payload: { enabled: true },
    });
  });

  test("is a no-op when the row already matches", () => {
    const db = makeFakeDb([
      makeRow({
        enabled: true,
        id: 1,
        name: "figma",
        tokenEnvName: "MCP_GATEWAY_TOKEN",
        url: "https://abc.ngrok.app/servers/figma/mcp",
      }),
    ]);

    syncDevTunnelServers({
      db,
      logger: nullLogger(),
      publicBaseUrl: "https://abc.ngrok.app",
      serverNames: ["figma"],
      tokenEnvName: "MCP_GATEWAY_TOKEN",
    });

    expect(db.records).toEqual([]);
  });

  test("skips builtin rows even on name collision", () => {
    const db = makeFakeDb([
      makeRow({
        id: 1,
        isBuiltin: true,
        name: "github",
        url: "https://api.githubcopilot.com/mcp/",
      }),
    ]);

    syncDevTunnelServers({
      db,
      logger: nullLogger(),
      publicBaseUrl: "https://abc.ngrok.app",
      serverNames: ["github"],
      tokenEnvName: "MCP_GATEWAY_TOKEN",
    });

    expect(db.records).toEqual([]);
    // builtin row is untouched
    expect(db.rows[0]?.url).toBe("https://api.githubcopilot.com/mcp/");
  });

  test("handles multiple server names independently", () => {
    const db = makeFakeDb([
      makeRow({
        id: 1,
        name: "figma",
        tokenEnvName: "OLD_TOKEN",
        url: "https://abc.ngrok.app/servers/figma/mcp",
      }),
    ]);

    syncDevTunnelServers({
      db,
      logger: nullLogger(),
      publicBaseUrl: "https://abc.ngrok.app",
      serverNames: ["figma", "playwright"],
      tokenEnvName: "MCP_GATEWAY_TOKEN",
    });

    expect(db.records).toHaveLength(2);
    expect(db.records[0]).toMatchObject({ id: 1, kind: "update" });
    expect(db.records[1]).toMatchObject({ kind: "create" });
    expect((db.records[1] as { payload: { name: string } }).payload.name).toBe("playwright");
  });

  test("disables stale dev-tunnel rows that are no longer targeted", () => {
    const db = makeFakeDb([
      makeRow({
        id: 1,
        name: "figma",
        tokenEnvName: "MCP_GATEWAY_TOKEN",
        url: "https://old.ngrok.app/servers/figma/mcp",
      }),
      makeRow({
        id: 2,
        name: "playwright",
        tokenEnvName: "MCP_GATEWAY_TOKEN",
        url: "https://old.ngrok.app/servers/playwright/mcp",
      }),
      makeRow({
        id: 3,
        name: "notion",
        tokenEnvName: "NOTION_TOKEN",
        url: "https://example.com/mcp",
      }),
    ]);

    syncDevTunnelServers({
      db,
      logger: nullLogger(),
      publicBaseUrl: "https://new.ngrok.app",
      serverNames: ["figma"],
      tokenEnvName: "MCP_GATEWAY_TOKEN",
    });

    expect(db.records).toEqual([
      {
        id: 2,
        kind: "update",
        payload: { enabled: false },
      },
      {
        id: 1,
        kind: "update",
        payload: {
          enabled: true,
          tokenEnvName: "MCP_GATEWAY_TOKEN",
          url: "https://new.ngrok.app/servers/figma/mcp",
        },
      },
    ]);
    expect(db.rows.find((row) => row.name === "playwright")?.enabled).toBe(false);
    expect(db.rows.find((row) => row.name === "notion")?.enabled).toBe(true);
  });

  test("disables all stale dev-tunnel rows when the target list is empty", () => {
    const db = makeFakeDb([
      makeRow({
        id: 1,
        name: "figma",
        tokenEnvName: "MCP_GATEWAY_TOKEN",
        url: "https://old.ngrok.app/servers/figma/mcp",
      }),
      makeRow({
        id: 2,
        name: "playwright",
        tokenEnvName: "MCP_GATEWAY_TOKEN",
        url: "https://old.ngrok.app/servers/playwright/mcp",
      }),
      makeRow({
        id: 3,
        name: "notion",
        tokenEnvName: "NOTION_TOKEN",
        url: "https://example.com/mcp",
      }),
    ]);

    syncDevTunnelServers({
      db,
      logger: nullLogger(),
      publicBaseUrl: "https://unused.ngrok.app",
      serverNames: [],
      tokenEnvName: "MCP_GATEWAY_TOKEN",
    });

    expect(db.records).toEqual([
      {
        id: 1,
        kind: "update",
        payload: { enabled: false },
      },
      {
        id: 2,
        kind: "update",
        payload: { enabled: false },
      },
    ]);
    expect(db.rows.find((row) => row.name === "figma")?.enabled).toBe(false);
    expect(db.rows.find((row) => row.name === "playwright")?.enabled).toBe(false);
    expect(db.rows.find((row) => row.name === "notion")?.enabled).toBe(true);
  });

  test("does not disable stale builtin rows even when they use the gateway token", () => {
    const db = makeFakeDb([
      makeRow({
        id: 1,
        isBuiltin: true,
        name: "github",
        tokenEnvName: "MCP_GATEWAY_TOKEN",
        url: "https://api.githubcopilot.com/mcp/",
      }),
    ]);

    syncDevTunnelServers({
      db,
      logger: nullLogger(),
      publicBaseUrl: "https://abc.ngrok.app",
      serverNames: ["figma"],
      tokenEnvName: "MCP_GATEWAY_TOKEN",
    });

    expect(db.records).toEqual([
      {
        kind: "create",
        payload: {
          enabled: true,
          name: "figma",
          permissionPolicy: "always_allow",
          tokenEnvName: "MCP_GATEWAY_TOKEN",
          url: "https://abc.ngrok.app/servers/figma/mcp",
        },
      },
    ]);
    expect(db.rows.find((row) => row.name === "github")?.enabled).toBe(true);
  });
});
