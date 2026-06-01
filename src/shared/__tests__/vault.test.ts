import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BetaManagedAgentsCredential,
  CredentialCreateParams,
  CredentialUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import type { BetaManagedAgentsVault } from "@anthropic-ai/sdk/resources/beta/vaults/vaults";
import type { Logger } from "pino";

import { GITHUB_MCP_URL } from "@/shared/constants";

import { createLogger } from "../logging";
import {
  createVaultModule,
  type EnsuredMcpCredential,
  type ResolvedMcpCredential,
  VaultApiUnavailable,
} from "../vault";

const createdTempDirectories: string[] = [];
const SAMPLE_MCP_TOKEN = "ghs_1234567890abcdefghij1234567890abcdef";
const SAMPLE_GITHUB_SERVER: ResolvedMcpCredential = {
  name: "github",
  mcpServerUrl: GITHUB_MCP_URL,
  token: SAMPLE_MCP_TOKEN,
};
const ISO_TIMESTAMP = "2026-04-23T00:00:00.000Z";

type CredentialUpdateInvocation = {
  credentialId: string;
  params: CredentialUpdateParams;
};

type MockVaultClientOptions = {
  createdCredentialId?: string;
  createdCredentialIds?: string[];
  createdVaultId?: string;
  credentialCreateImplementation?: (invocationCount: number) => Promise<void>;
  credentialUpdateImplementation?: (invocationCount: number) => Promise<void>;
  listedCredentials?: BetaManagedAgentsCredential[];
  retrievedVaultId?: string;
};

async function createTempLogFile(): Promise<string> {
  const directoryPath = await mkdtemp(join(tmpdir(), "github-issue-vault-"));
  createdTempDirectories.push(directoryPath);
  return join(directoryPath, "vault.log");
}

async function flushLogger(logFile: string): Promise<Array<Record<string, unknown>>> {
  const logContent = await readFile(logFile, "utf8");

  return logContent
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createVaultRecord(vaultId: string): BetaManagedAgentsVault {
  return {
    id: vaultId,
    archived_at: null,
    created_at: ISO_TIMESTAMP,
    display_name: "github-issue-agent auto",
    metadata: {},
    type: "vault",
    updated_at: ISO_TIMESTAMP,
  };
}

function createCredentialRecord(
  credentialId: string,
  mcpServerUrl: string,
): BetaManagedAgentsCredential {
  return {
    id: credentialId,
    archived_at: null,
    auth: {
      mcp_server_url: mcpServerUrl,
      type: "static_bearer",
    },
    created_at: ISO_TIMESTAMP,
    display_name: "github-issue-agent auto",
    metadata: {},
    type: "vault_credential",
    updated_at: ISO_TIMESTAMP,
    vault_id: "vlt_test",
  };
}

function createCredentialStream(
  credentials: BetaManagedAgentsCredential[],
): AsyncIterable<BetaManagedAgentsCredential> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const credentialEntry of credentials) {
        yield credentialEntry;
      }
    },
  };
}

function createLoggerSpy(): { logger: Logger; warnCalls: unknown[][] } {
  const warnCalls: unknown[][] = [];
  const childLogger = {
    info: () => undefined,
    warn: (...args: unknown[]) => {
      warnCalls.push(args);
    },
  } as unknown as Logger;

  return {
    logger: {
      child: () => childLogger,
    } as unknown as Logger,
    warnCalls,
  };
}

function createMockVaultClient(options: MockVaultClientOptions = {}) {
  const createVaultInvocations: Array<{ display_name: string }> = [];
  const retrieveVaultInvocations: string[] = [];
  const listCredentialInvocations: string[] = [];
  const createCredentialInvocations: Array<{ params: CredentialCreateParams; vaultId: string }> =
    [];
  const updateCredentialInvocations: CredentialUpdateInvocation[] = [];

  let credentialUpdateCount = 0;

  const client = {
    beta: {
      vaults: {
        create: async (params: { display_name: string }) => {
          createVaultInvocations.push(params);
          return createVaultRecord(options.createdVaultId ?? "vlt_created");
        },
        credentials: {
          create: async (vaultId: string, params: CredentialCreateParams) => {
            createCredentialInvocations.push({ params, vaultId });
            const createdCredentialIndex = createCredentialInvocations.length - 1;
            await options.credentialCreateImplementation?.(createdCredentialIndex + 1);
            return createCredentialRecord(
              options.createdCredentialIds?.[createdCredentialIndex] ??
                options.createdCredentialId ??
                "vcrd_created",
              params.auth.mcp_server_url,
            );
          },
          list: (vaultId: string) => {
            listCredentialInvocations.push(vaultId);
            return createCredentialStream(options.listedCredentials ?? []);
          },
          update: async (credentialId: string, params: CredentialUpdateParams) => {
            updateCredentialInvocations.push({ credentialId, params });
            credentialUpdateCount += 1;
            await options.credentialUpdateImplementation?.(credentialUpdateCount);
            return { id: credentialId };
          },
        },
        retrieve: async (vaultId: string) => {
          retrieveVaultInvocations.push(vaultId);
          return createVaultRecord(options.retrievedVaultId ?? vaultId);
        },
      },
    },
  };

  return {
    client,
    createCredentialInvocations,
    createVaultInvocations,
    listCredentialInvocations,
    retrieveVaultInvocations,
    updateCredentialInvocations,
  };
}

afterEach(async () => {
  await Promise.all(
    createdTempDirectories
      .splice(0)
      .map((directoryPath) => rm(directoryPath, { force: true, recursive: true })),
  );
});

describe("vault helpers", () => {
  test("ensureVault creates a vault when configVaultId is absent", async () => {
    const mockVaultClient = createMockVaultClient({ createdVaultId: "vlt_auto" });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(vaultModule.ensureVault(mockVaultClient.client, {})).resolves.toEqual({
      managedByUs: true,
      vaultId: "vlt_auto",
    });

    expect(mockVaultClient.createVaultInvocations).toEqual([
      {
        display_name: "github-issue-agent auto",
      },
    ]);
    expect(mockVaultClient.retrieveVaultInvocations).toEqual([]);
  });

  test("ensureVault reuses an explicit configVaultId", async () => {
    const mockVaultClient = createMockVaultClient({ retrievedVaultId: "vault_preconfigured" });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureVault(mockVaultClient.client, {
        configVaultId: "vault_preconfigured",
      }),
    ).resolves.toEqual({ managedByUs: false, vaultId: "vault_preconfigured" });

    expect(mockVaultClient.retrieveVaultInvocations).toEqual(["vault_preconfigured"]);
    expect(mockVaultClient.createVaultInvocations).toEqual([]);
  });

  test("ensureMcpCredentials creates a static_bearer credential bound to GITHUB_MCP_URL", async () => {
    const mockVaultClient = createMockVaultClient({ createdCredentialId: "vcrd_auto" });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureMcpCredentials(mockVaultClient.client, {
        servers: [SAMPLE_GITHUB_SERVER],
        vaultId: "vlt_auto",
      }),
    ).resolves.toEqual([
      { credentialId: "vcrd_auto", managedByUs: true, mcpServerUrl: GITHUB_MCP_URL },
    ]);

    expect(mockVaultClient.listCredentialInvocations).toEqual(["vlt_auto"]);
    expect(mockVaultClient.createCredentialInvocations).toEqual([
      {
        params: {
          auth: {
            mcp_server_url: GITHUB_MCP_URL,
            token: SAMPLE_MCP_TOKEN,
            type: "static_bearer",
          },
          display_name: "github-issue-agent auto (github)",
        },
        vaultId: "vlt_auto",
      },
    ]);
  });

  test("ensureMcpCredentials returns an empty array without listing credentials for empty servers", async () => {
    const mockVaultClient = createMockVaultClient();
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureMcpCredentials(mockVaultClient.client, {
        servers: [],
        vaultId: "vlt_empty",
      }),
    ).resolves.toEqual([]);

    expect(mockVaultClient.listCredentialInvocations).toEqual([]);
    expect(mockVaultClient.createCredentialInvocations).toEqual([]);
  });

  test("ensureMcpCredentials creates one credential per server URL", async () => {
    const linearServer: ResolvedMcpCredential = {
      name: "linear",
      mcpServerUrl: "https://linear.example.com/mcp/",
      token: "lin_1234567890abcdefghij1234567890abcdef",
    };
    const mockVaultClient = createMockVaultClient({
      createdCredentialIds: ["vcrd_github", "vcrd_linear"],
    });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureMcpCredentials(mockVaultClient.client, {
        servers: [SAMPLE_GITHUB_SERVER, linearServer],
        vaultId: "vlt_multi",
      }),
    ).resolves.toEqual([
      { credentialId: "vcrd_github", managedByUs: true, mcpServerUrl: GITHUB_MCP_URL },
      {
        credentialId: "vcrd_linear",
        managedByUs: true,
        mcpServerUrl: "https://linear.example.com/mcp/",
      },
    ]);

    expect(mockVaultClient.listCredentialInvocations).toEqual(["vlt_multi"]);
    expect(mockVaultClient.createCredentialInvocations).toEqual([
      {
        params: {
          auth: {
            mcp_server_url: GITHUB_MCP_URL,
            token: SAMPLE_MCP_TOKEN,
            type: "static_bearer",
          },
          display_name: "github-issue-agent auto (github)",
        },
        vaultId: "vlt_multi",
      },
      {
        params: {
          auth: {
            mcp_server_url: "https://linear.example.com/mcp/",
            token: "lin_1234567890abcdefghij1234567890abcdef",
            type: "static_bearer",
          },
          display_name: "github-issue-agent auto (linear)",
        },
        vaultId: "vlt_multi",
      },
    ]);
  });

  test("ensureMcpCredentials reuses credentials created earlier in the same call", async () => {
    const duplicateGithubServer: ResolvedMcpCredential = {
      name: "github-duplicate",
      mcpServerUrl: GITHUB_MCP_URL,
      token: "ghs_duplicate1234567890abcdefghij123456",
    };
    const mockVaultClient = createMockVaultClient({ createdCredentialId: "vcrd_github" });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureMcpCredentials(mockVaultClient.client, {
        servers: [SAMPLE_GITHUB_SERVER, duplicateGithubServer],
        vaultId: "vlt_duplicates",
      }),
    ).resolves.toEqual([
      { credentialId: "vcrd_github", managedByUs: true, mcpServerUrl: GITHUB_MCP_URL },
      { credentialId: "vcrd_github", managedByUs: true, mcpServerUrl: GITHUB_MCP_URL },
    ]);

    expect(mockVaultClient.createCredentialInvocations).toHaveLength(1);
    expect(mockVaultClient.createCredentialInvocations[0]?.params.auth.mcp_server_url).toBe(
      GITHUB_MCP_URL,
    );
  });

  test("ensureMcpCredentials reports credentials as soon as they are created", async () => {
    const linearServer: ResolvedMcpCredential = {
      name: "linear",
      mcpServerUrl: "https://linear.example.com/mcp/",
      token: "lin_1234567890abcdefghij1234567890abcdef",
    };
    const ensuredCredentials: EnsuredMcpCredential[] = [];
    const mockVaultClient = createMockVaultClient({
      createdCredentialIds: ["vcrd_github", "vcrd_linear"],
      credentialCreateImplementation: async (invocationCount) => {
        if (invocationCount === 2) {
          throw new Error("credential create failed");
        }
      },
    });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureMcpCredentials(mockVaultClient.client, {
        onCredentialEnsured: (credential) => {
          ensuredCredentials.push(credential);
        },
        servers: [SAMPLE_GITHUB_SERVER, linearServer],
        vaultId: "vlt_partial",
      }),
    ).rejects.toThrow("credential create failed");

    expect(ensuredCredentials).toEqual([
      { credentialId: "vcrd_github", managedByUs: true, mcpServerUrl: GITHUB_MCP_URL },
    ]);
  });

  test("ensureMcpCredentials reuses an existing credential when the MCP URL matches", async () => {
    const mockVaultClient = createMockVaultClient({
      listedCredentials: [
        createCredentialRecord("vcrd_existing", GITHUB_MCP_URL),
        createCredentialRecord("vcrd_other", "https://example.com/mcp/"),
      ],
    });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureMcpCredentials(mockVaultClient.client, {
        servers: [SAMPLE_GITHUB_SERVER],
        vaultId: "vlt_existing",
      }),
    ).resolves.toEqual([
      { credentialId: "vcrd_existing", managedByUs: false, mcpServerUrl: GITHUB_MCP_URL },
    ]);

    expect(mockVaultClient.listCredentialInvocations).toEqual(["vlt_existing"]);
    expect(mockVaultClient.createCredentialInvocations).toEqual([]);
  });

  test("ensureMcpCredentials reuses an existing credential without a local token", async () => {
    const mockVaultClient = createMockVaultClient({
      listedCredentials: [createCredentialRecord("vcrd_existing", GITHUB_MCP_URL)],
    });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureMcpCredentials(mockVaultClient.client, {
        servers: [
          {
            name: SAMPLE_GITHUB_SERVER.name,
            mcpServerUrl: SAMPLE_GITHUB_SERVER.mcpServerUrl,
          },
        ],
        vaultId: "vlt_existing",
      }),
    ).resolves.toEqual([
      { credentialId: "vcrd_existing", managedByUs: false, mcpServerUrl: GITHUB_MCP_URL },
    ]);

    expect(mockVaultClient.createCredentialInvocations).toEqual([]);
  });

  test("ensureMcpCredentials updates an existing credential token when requested", async () => {
    const mockVaultClient = createMockVaultClient({
      listedCredentials: [createCredentialRecord("vcrd_existing", GITHUB_MCP_URL)],
    });
    const { logger, warnCalls } = createLoggerSpy();
    const vaultModule = createVaultModule({ logger });

    await expect(
      vaultModule.ensureMcpCredentials(mockVaultClient.client, {
        servers: [
          {
            ...SAMPLE_GITHUB_SERVER,
            updateExisting: true,
          },
        ],
        vaultId: "vlt_existing",
      }),
    ).resolves.toEqual([
      { credentialId: "vcrd_existing", managedByUs: false, mcpServerUrl: GITHUB_MCP_URL },
    ]);

    expect(mockVaultClient.createCredentialInvocations).toEqual([]);
    expect(mockVaultClient.updateCredentialInvocations).toEqual([
      {
        credentialId: "vcrd_existing",
        params: {
          auth: {
            token: SAMPLE_MCP_TOKEN,
            type: "static_bearer",
          },
          vault_id: "vlt_existing",
        },
      },
    ]);
    expect(warnCalls).toEqual([
      [
        {
          credentialId: "vcrd_existing",
          mcpServerUrl: GITHUB_MCP_URL,
          vaultId: "vlt_existing",
        },
        "Updated existing MCP credential token; concurrent runs sharing this vault will overwrite each other's bearer token. Consider using a managed vault per run for repository-scoped credentials.",
      ],
    ]);
  });

  test("ensureMcpCredentials requires a token when creating a missing credential", async () => {
    const mockVaultClient = createMockVaultClient();
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureMcpCredentials(mockVaultClient.client, {
        servers: [
          {
            name: SAMPLE_GITHUB_SERVER.name,
            mcpServerUrl: SAMPLE_GITHUB_SERVER.mcpServerUrl,
          },
        ],
        vaultId: "vlt_missing",
      }),
    ).rejects.toThrow(/requires a bearer token/);

    expect(mockVaultClient.createCredentialInvocations).toEqual([]);
  });

  test("ensureMcpCredentials creates only missing credentials when some URLs already exist", async () => {
    const jiraServer: ResolvedMcpCredential = {
      name: "jira",
      mcpServerUrl: "https://jira.example.com/mcp/",
      token: "jira_1234567890abcdefghij1234567890abcdef",
    };
    const mockVaultClient = createMockVaultClient({
      createdCredentialId: "vcrd_jira",
      listedCredentials: [createCredentialRecord("vcrd_existing_github", GITHUB_MCP_URL)],
    });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(
      vaultModule.ensureMcpCredentials(mockVaultClient.client, {
        servers: [SAMPLE_GITHUB_SERVER, jiraServer],
        vaultId: "vlt_mixed",
      }),
    ).resolves.toEqual([
      {
        credentialId: "vcrd_existing_github",
        managedByUs: false,
        mcpServerUrl: GITHUB_MCP_URL,
      },
      {
        credentialId: "vcrd_jira",
        managedByUs: true,
        mcpServerUrl: "https://jira.example.com/mcp/",
      },
    ]);

    expect(mockVaultClient.createCredentialInvocations).toEqual([
      {
        params: {
          auth: {
            mcp_server_url: "https://jira.example.com/mcp/",
            token: "jira_1234567890abcdefghij1234567890abcdef",
            type: "static_bearer",
          },
          display_name: "github-issue-agent auto (jira)",
        },
        vaultId: "vlt_mixed",
      },
    ]);
  });

  test("ensureMcpCredentials never logs the raw token value", async () => {
    const logFile = await createTempLogFile();
    const mockVaultClient = createMockVaultClient({ createdCredentialId: "vcrd_logged" });
    const vaultModule = createVaultModule({ logger: createLogger({ level: "info", logFile }) });

    await vaultModule.ensureMcpCredentials(mockVaultClient.client, {
      servers: [SAMPLE_GITHUB_SERVER],
      vaultId: "vlt_logged",
    });
    await vaultModule.flushLogs();

    const logEntries = await flushLogger(logFile);
    const serializedLogs = JSON.stringify(logEntries);

    expect(serializedLogs).not.toContain(SAMPLE_MCP_TOKEN);
    expect(serializedLogs.includes("[REDACTED]") || !serializedLogs.includes("github_token")).toBe(
      true,
    );
  });

  test("throws VaultApiUnavailable when the SDK vault namespace is missing", async () => {
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });

    await expect(vaultModule.ensureVault({}, {})).rejects.toBeInstanceOf(VaultApiUnavailable);
    await expect(vaultModule.ensureVault({}, {})).rejects.toThrow(/vaultId.*credential/i);
  });

  test("throws VaultApiUnavailable when the SDK credentials namespace is missing", async () => {
    const vaultModule = createVaultModule({ logger: createLogger({ level: "silent" }) });
    const client = {
      beta: {
        vaults: {
          create: async (params: { display_name: string }) =>
            createVaultRecord(params.display_name),
          retrieve: async (vaultId: string) => createVaultRecord(vaultId),
        },
      },
    };

    await expect(
      vaultModule.ensureMcpCredentials(client, {
        servers: [SAMPLE_GITHUB_SERVER],
        vaultId: "vlt_missing_credentials",
      }),
    ).rejects.toBeInstanceOf(VaultApiUnavailable);
    await expect(
      vaultModule.ensureMcpCredentials(client, {
        servers: [SAMPLE_GITHUB_SERVER],
        vaultId: "vlt_missing_credentials",
      }),
    ).rejects.toThrow(/vaultId.*credential/i);
  });
});
