import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";

import { BUILTIN_GITHUB_MCP_TOKEN_ENV } from "@/shared/constants";
import { createDbModule, type McpServer } from "@/shared/persistence/db";

const BUILTIN_GITHUB_MCP = {
  name: "github",
  tokenEnvName: BUILTIN_GITHUB_MCP_TOKEN_ENV,
  url: "https://api.githubcopilot.com/mcp/",
} as const;

type DbModule = ReturnType<typeof createDbModule>;
type TestMcpServerInput = {
  enabled?: boolean;
  name: string;
  permissionPolicy?: "always_allow" | "always_ask";
  tokenEnvName: string;
  url: string;
};

function mcpServerInput(
  name: string,
  overrides: Partial<Omit<TestMcpServerInput, "name">> = {},
): TestMcpServerInput {
  return {
    name,
    tokenEnvName: `${name.toUpperCase().replaceAll("-", "_")}_TOKEN`,
    url: `https://${name}.example.com/mcp`,
    ...overrides,
  };
}

function expectSingleServer(servers: McpServer[]): McpServer {
  expect(servers).toHaveLength(1);

  const server = servers[0];
  if (server === undefined) {
    throw new Error("Expected exactly one MCP server");
  }

  return server;
}

function getBuiltinServer(dbModule: DbModule): McpServer {
  const server = dbModule.getMcpServerByName(BUILTIN_GITHUB_MCP.name);
  if (server === null) {
    throw new Error("Expected builtin GitHub MCP server to exist");
  }

  return server;
}

function expectZodError(callback: () => unknown): void {
  try {
    callback();
  } catch (error) {
    expect(error instanceof ZodError).toBe(true);
    return;
  }

  throw new Error("Expected callback to throw a ZodError");
}

describe("MCP server DB functions", () => {
  let dbModule: DbModule;

  beforeEach(() => {
    dbModule = createDbModule(":memory:");
    dbModule.initDb();
  });

  afterEach(() => {
    dbModule.close();
  });

  test("initDb seeds the builtin GitHub MCP server", () => {
    const server = expectSingleServer(dbModule.listMcpServers());

    expect(server).toMatchObject({
      enabled: true,
      isBuiltin: true,
      name: BUILTIN_GITHUB_MCP.name,
      permissionPolicy: "always_allow",
      tokenEnvName: BUILTIN_GITHUB_MCP.tokenEnvName,
      url: BUILTIN_GITHUB_MCP.url,
    });
    expect(server.id > 0).toBe(true);
  });

  test("initDb seeds the builtin server idempotently", () => {
    dbModule.initDb();

    const servers = dbModule.listMcpServers();

    expect(servers).toHaveLength(1);
    expect(servers.filter((server) => server.name === BUILTIN_GITHUB_MCP.name)).toHaveLength(1);
  });

  test("initDb normalizes the builtin GitHub MCP token placeholder", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "mcp-token-placeholder-"));
    const dbPath = join(tempDir, "dashboard.db");

    try {
      const firstModule = createDbModule(dbPath);
      firstModule.initDb();
      const builtin = getBuiltinServer(firstModule);
      firstModule.updateMcpServer(builtin.id, { tokenEnvName: "LEGACY_GITHUB_MCP_SECRET" });
      firstModule.close();

      const secondModule = createDbModule(dbPath);
      secondModule.initDb();
      expect(getBuiltinServer(secondModule).tokenEnvName).toBe(BUILTIN_GITHUB_MCP.tokenEnvName);
      secondModule.close();
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  test("createMcpServer inserts a non-builtin enabled server by default", () => {
    const created = dbModule.createMcpServer(mcpServerInput("linear"));

    expect(created).toMatchObject({
      enabled: true,
      isBuiltin: false,
      name: "linear",
      permissionPolicy: "always_allow",
      tokenEnvName: "LINEAR_TOKEN",
      url: "https://linear.example.com/mcp",
    });
    expect(created.id >= 2).toBe(true);
  });

  test("createMcpServer allows an unauthenticated server without token env", () => {
    const created = dbModule.createMcpServer({
      name: "public-docs",
      url: "https://public-docs.example.com/mcp",
    });

    expect(created).toMatchObject({
      enabled: true,
      isBuiltin: false,
      name: "public-docs",
      permissionPolicy: "always_allow",
      tokenEnvName: "",
      url: "https://public-docs.example.com/mcp",
    });
  });

  test("createMcpServer rejects duplicate names", () => {
    dbModule.createMcpServer(mcpServerInput("linear"));

    expect(() =>
      dbModule.createMcpServer(
        mcpServerInput("linear", {
          tokenEnvName: "LINEAR_OTHER_TOKEN",
          url: "https://linear-other.example.com/mcp",
        }),
      ),
    ).toThrow('mcp server "linear" already exists');
  });

  test("getMcpServerById and getMcpServerByName return rows or null", () => {
    const created = dbModule.createMcpServer(mcpServerInput("slack"));

    expect(dbModule.getMcpServerById(created.id)).toEqual(created);
    expect(dbModule.getMcpServerByName("slack")).toEqual(created);
    expect(dbModule.getMcpServerById(9999)).toBeNull();
    expect(dbModule.getMcpServerByName("missing")).toBeNull();
  });

  test("listMcpServers includes all servers, filters enabled only, and orders builtin first", () => {
    dbModule.createMcpServer(mcpServerInput("zeta"));
    dbModule.createMcpServer(mcpServerInput("alpha", { enabled: false }));

    const allServers = dbModule.listMcpServers();
    const enabledServers = dbModule.listMcpServers({ enabledOnly: true });

    expect(allServers.map((server) => server.name)).toEqual(["github", "alpha", "zeta"]);
    expect(enabledServers.map((server) => server.name)).toEqual(["github", "zeta"]);
    expect(enabledServers.every((server) => server.enabled)).toBe(true);
  });

  test("updateMcpServer updates all mutable fields for non-builtin servers", () => {
    const created = dbModule.createMcpServer(mcpServerInput("notion"));

    const updated = dbModule.updateMcpServer(created.id, {
      enabled: false,
      permissionPolicy: "always_ask",
      tokenEnvName: "NOTION_TOKEN_V2",
      url: "https://notion.example.com/mcp/v2",
    });

    expect(updated).toMatchObject({
      enabled: false,
      id: created.id,
      isBuiltin: false,
      name: "notion",
      permissionPolicy: "always_ask",
      tokenEnvName: "NOTION_TOKEN_V2",
      url: "https://notion.example.com/mcp/v2",
    });
    expect(dbModule.getMcpServerById(created.id)).toEqual(updated);
  });

  test("updateMcpServer can clear token env for unauthenticated servers", () => {
    const created = dbModule.createMcpServer(mcpServerInput("public-api"));

    const updated = dbModule.updateMcpServer(created.id, { tokenEnvName: "" });

    expect(updated.tokenEnvName).toBe("");
    expect(dbModule.getMcpServerById(created.id)?.tokenEnvName).toBe("");
  });

  test("updateMcpServer keeps builtin url immutable while updating other fields", () => {
    const builtin = getBuiltinServer(dbModule);

    const updated = dbModule.updateMcpServer(builtin.id, {
      enabled: true,
      permissionPolicy: "always_ask",
      tokenEnvName: "GH_MCP_TOKEN",
      url: "https://example.com/should-not-persist",
    });

    expect(updated).toMatchObject({
      enabled: true,
      id: builtin.id,
      isBuiltin: true,
      name: BUILTIN_GITHUB_MCP.name,
      permissionPolicy: "always_ask",
      tokenEnvName: "GH_MCP_TOKEN",
      url: BUILTIN_GITHUB_MCP.url,
    });
  });

  test("updateMcpServer rejects disabling the builtin GitHub MCP server", () => {
    const builtin = getBuiltinServer(dbModule);

    expect(() => dbModule.updateMcpServer(builtin.id, { enabled: false })).toThrow(
      "builtin GitHub MCP server cannot be disabled",
    );
    expect(dbModule.getMcpServerById(builtin.id)?.enabled).toBe(true);
  });

  test("setMcpServerEnabled toggles an existing server", () => {
    const created = dbModule.createMcpServer(mcpServerInput("toggle"));

    expect(dbModule.setMcpServerEnabled(created.id, false)).toEqual({ updated: true });
    expect(dbModule.getMcpServerById(created.id)?.enabled).toBe(false);

    expect(dbModule.setMcpServerEnabled(created.id, true)).toEqual({ updated: true });
    expect(dbModule.getMcpServerById(created.id)?.enabled).toBe(true);
  });

  test("setMcpServerEnabled rejects disabling the builtin GitHub MCP server", () => {
    const builtin = getBuiltinServer(dbModule);

    expect(() => dbModule.setMcpServerEnabled(builtin.id, false)).toThrow(
      "builtin GitHub MCP server cannot be disabled",
    );
    expect(dbModule.getMcpServerById(builtin.id)?.enabled).toBe(true);
  });

  test("deleteMcpServer removes non-builtin servers", () => {
    const created = dbModule.createMcpServer(mcpServerInput("temporary"));

    expect(dbModule.deleteMcpServer(created.id)).toEqual({ deleted: true });
    expect(dbModule.getMcpServerById(created.id)).toBeNull();
  });

  test("deleteMcpServer does not remove builtin servers", () => {
    const builtin = getBuiltinServer(dbModule);

    expect(dbModule.deleteMcpServer(builtin.id)).toEqual({ deleted: false });
    expect(dbModule.getMcpServerById(builtin.id)).toEqual(builtin);
  });

  test("createMcpServer validates name, url, non-empty tokenEnvName, and permissionPolicy", () => {
    for (const name of ["", "   ", "a".repeat(65)]) {
      expectZodError(() =>
        dbModule.createMcpServer({
          name,
          tokenEnvName: "INVALID_NAME_TOKEN",
          url: "https://valid.example.com/mcp",
        }),
      );
    }

    for (const [index, url] of ["file:///tmp/mcp", ""].entries()) {
      expectZodError(() =>
        dbModule.createMcpServer({
          name: `invalid-url-${index}`,
          tokenEnvName: "INVALID_URL_TOKEN",
          url,
        }),
      );
    }

    for (const [index, tokenEnvName] of ["1TOKEN", "TOKEN-NAME"].entries()) {
      expectZodError(() =>
        dbModule.createMcpServer({
          name: `invalid-token-${index}`,
          tokenEnvName,
          url: "https://valid.example.com/mcp",
        }),
      );
    }

    expectZodError(() =>
      dbModule.createMcpServer({
        name: "invalid-policy",
        permissionPolicy: "always_ask_user",
        tokenEnvName: "INVALID_POLICY_TOKEN",
        url: "https://valid.example.com/mcp",
      }),
    );
  });
});
