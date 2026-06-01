import type {
  BetaManagedAgentsCredential,
  CredentialCreateParams,
  CredentialUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import type { BetaManagedAgentsVault } from "@anthropic-ai/sdk/resources/beta/vaults/vaults";
import type { Logger } from "pino";

import { createLogger } from "@/shared/logging";

const AUTO_DISPLAY_NAME = "github-issue-agent auto";

export type EnsureVaultContext = {
  configVaultId?: string;
};

/**
 * MCP server plus an optional bearer token resolved by the caller. The Vault
 * module never reads env vars directly: it reuses existing credentials by URL
 * without a token, and only requires `token` when it must create a new one.
 */
export type ResolvedMcpCredential = {
  name: string;
  mcpServerUrl: string;
  token?: string;
  updateExisting?: boolean;
};

export type EnsureMcpCredentialsContext = {
  onCredentialEnsured?: (credential: EnsuredMcpCredential) => void;
  vaultId: string;
  servers: ReadonlyArray<ResolvedMcpCredential>;
};

export type EnsuredMcpCredential = {
  credentialId: string;
  managedByUs: boolean;
  mcpServerUrl: string;
};

export type UpdateMcpCredentialTokenContext = {
  credentialId: string;
  token: string;
  vaultId: string;
};

type VaultClient = {
  beta?: {
    vaults?: VaultsApi;
  };
};

type VaultsApi = {
  create: (params: { display_name: string }) => Promise<Pick<BetaManagedAgentsVault, "id">>;
  credentials?: CredentialsApi;
  retrieve: (vaultId: string) => Promise<Pick<BetaManagedAgentsVault, "id">>;
};

type CredentialsApi = {
  create: (
    vaultId: string,
    params: CredentialCreateParams,
  ) => Promise<Pick<BetaManagedAgentsCredential, "id">>;
  list: (vaultId: string) => AsyncIterable<BetaManagedAgentsCredential>;
  update?: (
    credentialId: string,
    params: CredentialUpdateParams,
  ) => Promise<Pick<BetaManagedAgentsCredential, "id">>;
};

type VaultModuleDependencies = {
  logger: Logger;
};

export class VaultApiUnavailable extends Error {
  constructor() {
    super(
      "Vault API unavailable in the installed SDK; configure vaultId with a pre-provisioned MCP credential.",
    );
    this.name = "VaultApiUnavailable";
  }
}

function buildCredentialCreateParams(input: {
  mcpServerUrl: string;
  serverName: string;
  token: string;
}): CredentialCreateParams {
  return {
    auth: {
      mcp_server_url: input.mcpServerUrl,
      token: input.token,
      type: "static_bearer",
    },
    display_name: `${AUTO_DISPLAY_NAME} (${input.serverName})`,
  };
}

function buildCredentialUpdateParams(input: {
  token: string;
  vaultId: string;
}): CredentialUpdateParams {
  return {
    auth: {
      token: input.token,
      type: "static_bearer",
    },
    vault_id: input.vaultId,
  };
}

function requireVaultsApi(client: VaultClient): VaultsApi {
  const vaultsApi = client.beta?.vaults;

  if (!vaultsApi) {
    throw new VaultApiUnavailable();
  }

  return vaultsApi;
}

function requireCredentialsApi(client: VaultClient): CredentialsApi {
  const credentialsApi = requireVaultsApi(client).credentials;

  if (!credentialsApi) {
    throw new VaultApiUnavailable();
  }

  return credentialsApi;
}

function requireCredentialUpdateApi(
  credentialsApi: CredentialsApi,
): NonNullable<CredentialsApi["update"]> {
  if (!credentialsApi.update) {
    throw new VaultApiUnavailable();
  }

  return credentialsApi.update;
}

export function createVaultModule(overrides: Partial<VaultModuleDependencies> = {}) {
  const dependencies: VaultModuleDependencies = {
    logger: createLogger({ level: "silent" }),
    ...overrides,
  };
  const logger = dependencies.logger.child({ component: "vault" });

  async function ensureVault(
    client: VaultClient,
    context: EnsureVaultContext,
  ): Promise<{ managedByUs: boolean; vaultId: string }> {
    const vaultsApi = requireVaultsApi(client);

    if (typeof context.configVaultId === "string" && context.configVaultId.length > 0) {
      const existingVault = await vaultsApi.retrieve(context.configVaultId);
      logger.info({ managedByUs: false, vaultId: existingVault.id }, "Reused configured vault");
      return {
        managedByUs: false,
        vaultId: existingVault.id,
      };
    }

    const createdVault = await vaultsApi.create({ display_name: AUTO_DISPLAY_NAME });
    logger.info({ managedByUs: true, vaultId: createdVault.id }, "Created managed vault");

    return {
      managedByUs: true,
      vaultId: createdVault.id,
    };
  }

  /**
   * Ensure one Vault credential per MCP server URL.
   *
   * Strategy: list existing credentials in the vault once and build a lookup
   * by `mcp_server_url`. For each requested server, reuse the matching
   * credential when present; otherwise create a new `static_bearer`
   * credential. The bearer token is whatever the caller resolved
   * (typically `process.env[server.tokenEnvName]`).
   *
   * Credentials we create are tagged `managedByUs: true` for callers that need
   * to distinguish them from reused credentials. Credentials we reused are
   * tagged `managedByUs: false` and left in place.
   */
  async function ensureMcpCredentials(
    client: VaultClient,
    context: EnsureMcpCredentialsContext,
  ): Promise<EnsuredMcpCredential[]> {
    const credentialsApi = requireCredentialsApi(client);

    if (context.servers.length === 0) {
      logger.info({ vaultId: context.vaultId }, "No MCP credentials to ensure");
      return [];
    }

    logger.info(
      { count: context.servers.length, vaultId: context.vaultId },
      "Ensuring MCP credentials",
    );

    const existingByUrl = new Map<string, EnsuredMcpCredential>();
    for await (const credentialEntry of credentialsApi.list(context.vaultId)) {
      // First match wins. Anthropic does not return order guarantees, so if
      // there are duplicates the caller should clean them up out-of-band.
      if (!existingByUrl.has(credentialEntry.auth.mcp_server_url)) {
        existingByUrl.set(credentialEntry.auth.mcp_server_url, {
          credentialId: credentialEntry.id,
          managedByUs: false,
          mcpServerUrl: credentialEntry.auth.mcp_server_url,
        });
      }
    }

    const ensured: EnsuredMcpCredential[] = [];
    for (const server of context.servers) {
      const existing = existingByUrl.get(server.mcpServerUrl);
      if (existing) {
        if (server.updateExisting && typeof server.token === "string" && server.token.length > 0) {
          await requireCredentialUpdateApi(credentialsApi)(
            existing.credentialId,
            buildCredentialUpdateParams({ token: server.token, vaultId: context.vaultId }),
          );
          logger.warn(
            {
              credentialId: existing.credentialId,
              mcpServerUrl: server.mcpServerUrl,
              vaultId: context.vaultId,
            },
            "Updated existing MCP credential token; concurrent runs sharing this vault will overwrite each other's bearer token. Consider using a managed vault per run for repository-scoped credentials.",
          );
        }
        logger.info(
          {
            credentialId: existing.credentialId,
            managedByUs: existing.managedByUs,
            mcpServerUrl: server.mcpServerUrl,
            vaultId: context.vaultId,
          },
          "Reused existing MCP credential",
        );
        ensured.push(existing);
        context.onCredentialEnsured?.(existing);
        continue;
      }

      if (typeof server.token !== "string" || server.token.length === 0) {
        throw new Error(
          `MCP server "${server.name}" requires a bearer token to create a Vault credential`,
        );
      }

      const created = await credentialsApi.create(
        context.vaultId,
        buildCredentialCreateParams({
          mcpServerUrl: server.mcpServerUrl,
          serverName: server.name,
          token: server.token,
        }),
      );
      logger.info(
        {
          credentialId: created.id,
          managedByUs: true,
          mcpServerUrl: server.mcpServerUrl,
          serverName: server.name,
          vaultId: context.vaultId,
        },
        "Created MCP credential",
      );
      const ensuredCredential: EnsuredMcpCredential = {
        credentialId: created.id,
        managedByUs: true,
        mcpServerUrl: server.mcpServerUrl,
      };
      existingByUrl.set(server.mcpServerUrl, ensuredCredential);
      ensured.push(ensuredCredential);
      context.onCredentialEnsured?.(ensuredCredential);
    }

    return ensured;
  }

  async function updateMcpCredentialToken(
    client: VaultClient,
    context: UpdateMcpCredentialTokenContext,
  ): Promise<void> {
    const credentialsApi = requireCredentialsApi(client);
    await requireCredentialUpdateApi(credentialsApi)(
      context.credentialId,
      buildCredentialUpdateParams({ token: context.token, vaultId: context.vaultId }),
    );
    logger.info(
      { credentialId: context.credentialId, vaultId: context.vaultId },
      "Updated MCP credential token",
    );
  }

  async function flushLogs(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      logger.flush((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  return {
    ensureMcpCredentials,
    ensureVault,
    flushLogs,
    updateMcpCredentialToken,
  };
}

const defaultVaultModule = createVaultModule();

export const { ensureMcpCredentials, ensureVault, updateMcpCredentialToken } = defaultVaultModule;
