import type {
  BetaManagedAgentsCredential,
  CredentialCreateParams,
  CredentialUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import type { BetaManagedAgentsVault } from "@anthropic-ai/sdk/resources/beta/vaults/vaults";
import type { Logger } from "pino";

import { createLogger } from "@/shared/logging";

const AUTO_DISPLAY_NAME = "maestro auto";

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

type McpCredentialAuthType = "mcp_oauth" | "static_bearer";

type ExistingMcpCredential = EnsuredMcpCredential & {
  authType: McpCredentialAuthType;
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

function toEnsuredMcpCredential(credential: ExistingMcpCredential): EnsuredMcpCredential {
  return {
    credentialId: credential.credentialId,
    managedByUs: credential.managedByUs,
    mcpServerUrl: credential.mcpServerUrl,
  };
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
   * credential. When the caller asks to refresh a bearer token, only an
   * existing `static_bearer` credential is updated; `mcp_oauth` credentials
   * are not rewritten as bearer credentials. The bearer token is whatever the
   * caller resolved (typically `process.env[server.tokenEnvName]`).
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

    const existingByUrl = new Map<string, ExistingMcpCredential>();
    const existingStaticBearerByUrl = new Map<string, ExistingMcpCredential>();
    for await (const credentialEntry of credentialsApi.list(context.vaultId)) {
      const credentialAuth = credentialEntry.auth;
      if (credentialAuth.type !== "static_bearer" && credentialAuth.type !== "mcp_oauth") {
        continue;
      }

      const mcpServerUrl = credentialAuth.mcp_server_url;
      // First match wins. Anthropic does not return order guarantees, so if
      // there are duplicates the caller should clean them up out-of-band.
      const existingCredential: ExistingMcpCredential = {
        authType: credentialAuth.type,
        credentialId: credentialEntry.id,
        managedByUs: false,
        mcpServerUrl,
      };
      if (!existingByUrl.has(mcpServerUrl)) {
        existingByUrl.set(mcpServerUrl, existingCredential);
      }
      if (credentialAuth.type === "static_bearer" && !existingStaticBearerByUrl.has(mcpServerUrl)) {
        existingStaticBearerByUrl.set(mcpServerUrl, existingCredential);
      }
    }

    const ensured: EnsuredMcpCredential[] = [];
    for (const server of context.servers) {
      const bearerToken =
        typeof server.token === "string" && server.token.length > 0 ? server.token : undefined;
      const shouldRefreshBearerToken = server.updateExisting === true && bearerToken !== undefined;
      const existing = shouldRefreshBearerToken
        ? existingStaticBearerByUrl.get(server.mcpServerUrl)
        : existingByUrl.get(server.mcpServerUrl);
      if (existing) {
        if (shouldRefreshBearerToken && bearerToken !== undefined) {
          await requireCredentialUpdateApi(credentialsApi)(
            existing.credentialId,
            buildCredentialUpdateParams({ token: bearerToken, vaultId: context.vaultId }),
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
        const ensuredCredential = toEnsuredMcpCredential(existing);
        logger.info(
          {
            authType: existing.authType,
            credentialId: ensuredCredential.credentialId,
            managedByUs: ensuredCredential.managedByUs,
            mcpServerUrl: server.mcpServerUrl,
            vaultId: context.vaultId,
          },
          "Reused existing MCP credential",
        );
        ensured.push(ensuredCredential);
        context.onCredentialEnsured?.(ensuredCredential);
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
      const existingCredential: ExistingMcpCredential = {
        ...ensuredCredential,
        authType: "static_bearer",
      };
      existingByUrl.set(server.mcpServerUrl, existingCredential);
      existingStaticBearerByUrl.set(server.mcpServerUrl, existingCredential);
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
