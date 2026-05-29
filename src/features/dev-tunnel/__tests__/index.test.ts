import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type StartDevTunnelOptions, startDevTunnel } from "@/features/dev-tunnel";
import type { McpServerRow as McpServer } from "@/shared/persistence/schemas";

type RecordedUpdate = {
  id: number;
  kind: "update";
  payload: unknown;
};

type FakeDb = {
  createMcpServer: (input: unknown) => McpServer;
  getMcpServerByName: (name: string) => McpServer | null;
  listMcpServers: (opts?: { enabledOnly?: boolean }) => McpServer[];
  records: RecordedUpdate[];
  rows: McpServer[];
  updateMcpServer: (id: number, input: unknown) => McpServer;
};

const tempDirs: string[] = [];

function nullLogger(): StartDevTunnelOptions["logger"] {
  const childLogger = {
    info: (..._args: unknown[]) => undefined,
    warn: (..._args: unknown[]) => undefined,
  };

  return {
    child: () => childLogger,
  } as unknown as StartDevTunnelOptions["logger"];
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
  const records: RecordedUpdate[] = [];

  return {
    createMcpServer(input) {
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
}

describe("startDevTunnel", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("disables stale tunnel rows before returning when the target config is empty", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "dev-tunnel-test-"));
    tempDirs.push(tempDir);
    const configPath = join(tempDir, "mcp-proxy.json");
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));

    const db = makeFakeDb([
      makeRow({
        id: 1,
        name: "figma",
        tokenEnvName: "MCP_GATEWAY_TOKEN",
        url: "https://old.ngrok.app/servers/figma/mcp",
      }),
      makeRow({
        id: 2,
        name: "notion",
        tokenEnvName: "NOTION_TOKEN",
        url: "https://example.com/mcp",
      }),
    ]);

    const handle = await startDevTunnel({
      db: db as unknown as StartDevTunnelOptions["db"],
      env: {
        ENABLE_DEV_TUNNEL: "true",
        MCP_GATEWAY_TOKEN: "gateway-token",
        MCP_PROXY_CONFIG: configPath,
        NGROK_AUTHTOKEN: "ngrok-token",
      },
      logger: nullLogger(),
    });

    expect(handle).toBeUndefined();
    expect(db.records).toEqual([
      {
        id: 1,
        kind: "update",
        payload: { enabled: false },
      },
    ]);
    expect(db.rows.find((row) => row.name === "figma")?.enabled).toBe(false);
    expect(db.rows.find((row) => row.name === "notion")?.enabled).toBe(true);
  });
});
