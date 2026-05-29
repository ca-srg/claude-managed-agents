import type {
  AgentCreateParams,
  AgentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsUserMessageEventParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type { Logger } from "pino";

import type { ensureEnvironment, ensureEnvironmentForRepo } from "@/shared/agents/environment";
import { hashDefinition } from "@/shared/agents/hash";
import { buildRepoChatAgentDefinition } from "@/shared/agents/repo-chat";
import type { Config } from "@/shared/config";
import { BUILTIN_GITHUB_MCP_NAME } from "@/shared/constants";
import type {
  GitHubAuthProvider,
  GitHubRepositoryAccess,
  GitHubRepositoryAuthorization,
} from "@/shared/github";
import type { createDbModule, McpServer } from "@/shared/persistence/db";
import type { RepoChatMessageRow } from "@/shared/persistence/schemas";
import type { runSession } from "@/shared/session";
import type {
  EnsuredMcpCredential,
  ensureMcpCredentials,
  ensureVault,
  ResolvedMcpCredential,
  releaseVault,
} from "@/shared/vault";

type DbModule = ReturnType<typeof createDbModule>;

export type RepositoryChatDb = Pick<
  DbModule,
  | "getRepoChatState"
  | "getRepoEnvironment"
  | "listMcpServers"
  | "setRepoChatAgentState"
  | "setRepoChatEnvironmentState"
  | "setRepoEnvironmentAnthropicState"
>;

type AgentsApiClient = {
  beta: {
    agents: {
      create(params: AgentCreateParams): PromiseLike<{ id: string; version: number }>;
      update(
        agentId: string,
        params: AgentUpdateParams,
      ): PromiseLike<{ id: string; version: number }>;
    };
  };
};

type SessionApiClient = {
  beta: {
    sessions: {
      create(params: SessionCreateParams): PromiseLike<{ id: string }>;
      delete(sessionId: string): PromiseLike<unknown>;
      events: {
        send(
          sessionId: string,
          params: { events: BetaManagedAgentsUserMessageEventParams[] },
        ): PromiseLike<unknown>;
      };
    };
  };
};

export type RepositoryChatAnthropicClient = AgentsApiClient &
  SessionApiClient &
  Parameters<typeof ensureEnvironment>[0] &
  Parameters<typeof ensureEnvironmentForRepo>[0] &
  Parameters<typeof ensureVault>[0] &
  Parameters<typeof ensureMcpCredentials>[0] &
  Parameters<typeof releaseVault>[0] &
  Parameters<typeof runSession>[0];

export type RepositoryChatContextFlags = {
  includeMcp: boolean;
  includeRecentRuns: boolean;
  includeRepository: boolean;
  includeSettings: boolean;
};

export type RepositoryChatTurnInput = {
  context: RepositoryChatContextFlags;
  dashboardContext: string;
  history: RepoChatMessageRow[];
  message: string;
  repo: string;
  repoName: string;
  repoOwner: string;
};

export type RepositoryChatTurnResult = {
  content: string;
  sessionId: string;
};

export type RepositoryChatDeps = {
  anthropicClient: RepositoryChatAnthropicClient;
  config: Config;
  db: RepositoryChatDb;
  ensureEnvironment: typeof ensureEnvironment;
  ensureEnvironmentForRepo: typeof ensureEnvironmentForRepo;
  ensureMcpCredentials: typeof ensureMcpCredentials;
  ensureVault: typeof ensureVault;
  githubAuth: GitHubAuthProvider;
  logger: Logger;
  releaseVault: typeof releaseVault;
  runSession: typeof runSession;
  timeoutMs?: number;
};

type EnsuredRepoChatAgent = {
  agentId: string;
  agentVersion: number;
};

const DEFAULT_CHAT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 12;

function toUpdateParams(definition: AgentCreateParams, version: number): AgentUpdateParams {
  return {
    version,
    ...(typeof definition.description === "undefined"
      ? {}
      : { description: definition.description }),
    ...(typeof definition.mcp_servers === "undefined"
      ? {}
      : { mcp_servers: definition.mcp_servers }),
    ...(typeof definition.metadata === "undefined" ? {} : { metadata: definition.metadata }),
    ...(typeof definition.model === "undefined" ? {} : { model: definition.model }),
    ...(typeof definition.name === "undefined" ? {} : { name: definition.name }),
    ...(typeof definition.system === "undefined" ? {} : { system: definition.system }),
    ...(typeof definition.tools === "undefined" ? {} : { tools: definition.tools }),
  };
}

async function ensureRepoChatAgent(deps: RepositoryChatDeps): Promise<EnsuredRepoChatAgent> {
  const mcpServers = deps.db.listMcpServers();
  const definition = buildRepoChatAgentDefinition(deps.config, mcpServers);
  const definitionHash = hashDefinition(definition);
  const state = deps.db.getRepoChatState();
  const existingAgentId = state?.agentId ?? null;
  const existingAgentVersion = state?.agentVersion ?? null;
  const hasAgentState = existingAgentId !== null && existingAgentVersion !== null;

  if (hasAgentState && state?.agentDefinitionHash === definitionHash) {
    return { agentId: existingAgentId, agentVersion: existingAgentVersion };
  }

  const agent = hasAgentState
    ? await deps.anthropicClient.beta.agents.update(
        existingAgentId,
        toUpdateParams(definition, existingAgentVersion),
      )
    : await deps.anthropicClient.beta.agents.create(definition);

  deps.db.setRepoChatAgentState({
    agentDefinitionHash: definitionHash,
    agentId: agent.id,
    agentVersion: agent.version,
  });

  return { agentId: agent.id, agentVersion: agent.version };
}

async function ensureChatEnvironment(deps: RepositoryChatDeps, repo: string): Promise<string> {
  const repoEnvRow = deps.db.getRepoEnvironment(repo);
  if (repoEnvRow !== null) {
    const ensured = await deps.ensureEnvironmentForRepo(deps.anthropicClient, {
      cached: {
        definitionHash: repoEnvRow.definitionHash,
        environmentId: repoEnvRow.environmentId,
      },
      packages: repoEnvRow.packages,
      repo,
    });

    if (ensured.created || ensured.updated) {
      deps.db.setRepoEnvironmentAnthropicState(repo, {
        definitionHash: ensured.hash,
        environmentId: ensured.environmentId,
      });
    }

    return ensured.environmentId;
  }

  const state = deps.db.getRepoChatState();
  const existingEnvironmentId = state?.environmentId ?? null;
  const existingEnvironmentDefinitionHash = state?.environmentDefinitionHash ?? null;
  const hasEnvironmentState =
    existingEnvironmentId !== null && existingEnvironmentDefinitionHash !== null;
  const cached = hasEnvironmentState
    ? {
        definitionHash: existingEnvironmentDefinitionHash,
        environmentId: existingEnvironmentId,
      }
    : null;
  const ensured = await deps.ensureEnvironment(deps.anthropicClient, cached);

  if (ensured.created || cached === null || cached.environmentId !== ensured.environmentId) {
    deps.db.setRepoChatEnvironmentState({
      environmentDefinitionHash: ensured.hash,
      environmentId: ensured.environmentId,
    });
  }

  return ensured.environmentId;
}

function isBuiltinGitHubMcp(server: McpServer): boolean {
  return server.isBuiltin && server.name === BUILTIN_GITHUB_MCP_NAME;
}

async function resolveRepositoryAuthorization(
  input: RepositoryChatTurnInput,
  deps: RepositoryChatDeps,
): Promise<GitHubRepositoryAccess | GitHubRepositoryAuthorization> {
  return deps.githubAuth.resolveRepositoryAccess(input.repoOwner, input.repoName);
}

function resolveMcpCredentials(
  servers: ReadonlyArray<McpServer>,
  options: {
    githubAuth: GitHubRepositoryAuthorization;
    requireToken: boolean;
  },
): ResolvedMcpCredential[] {
  const resolved: ResolvedMcpCredential[] = [];
  for (const server of servers) {
    const shouldUseGitHubAppToken = isBuiltinGitHubMcp(server);
    if (!shouldUseGitHubAppToken && server.tokenEnvName.length === 0) {
      continue;
    }

    const token = shouldUseGitHubAppToken
      ? options.githubAuth.authorizationToken
      : process.env[server.tokenEnvName];
    if ((typeof token !== "string" || token.length === 0) && options.requireToken) {
      throw new Error(
        `MCP server "${server.name}" requires environment variable ${server.tokenEnvName} to be set`,
      );
    }

    const credential: ResolvedMcpCredential = {
      mcpServerUrl: server.url,
      name: server.name,
    };
    const hasResolvedToken = typeof token === "string" && token.length > 0;
    if (hasResolvedToken) {
      credential.token = token;
    }
    if (shouldUseGitHubAppToken || hasResolvedToken) {
      credential.updateExisting = true;
    }
    resolved.push(credential);
  }
  return resolved;
}

async function ensureChatVault(
  deps: RepositoryChatDeps,
  enabledMcpServers: ReadonlyArray<McpServer>,
  githubAuth: GitHubRepositoryAuthorization,
): Promise<{
  credentials: Array<{ credentialId: string; managed: boolean }>;
  managedVault: boolean;
  vaultId: string | undefined;
}> {
  if (enabledMcpServers.length === 0) {
    return { credentials: [], managedVault: false, vaultId: undefined };
  }

  const vault = await deps.ensureVault(deps.anthropicClient, {
    configVaultId: deps.config.vaultId,
  });
  const credentials: Array<{ credentialId: string; managed: boolean }> = [];
  const credentialIds = new Set<string>();
  const recordCredential = (credential: EnsuredMcpCredential) => {
    if (credentialIds.has(credential.credentialId)) {
      return;
    }

    credentialIds.add(credential.credentialId);
    credentials.push({ credentialId: credential.credentialId, managed: credential.managedByUs });
  };

  await deps.ensureMcpCredentials(deps.anthropicClient, {
    onCredentialEnsured: recordCredential,
    servers: resolveMcpCredentials(enabledMcpServers, {
      githubAuth,
      requireToken: vault.managedByUs,
    }),
    vaultId: vault.vaultId,
  });

  return { credentials, managedVault: vault.managedByUs, vaultId: vault.vaultId };
}

function formatHistory(history: RepoChatMessageRow[]): string {
  const recent = history.slice(-MAX_HISTORY_MESSAGES);
  if (recent.length === 0) {
    return "No previous local chat messages.";
  }

  return recent
    .map((message) => {
      const role = message.role === "user" ? "User" : "Assistant";
      return `${role}: ${message.content.trim()}`;
    })
    .join("\n\n");
}

function contextFlagLines(context: RepositoryChatContextFlags): string {
  return [
    `- Repository settings: ${context.includeSettings ? "included" : "not requested"}`,
    `- MCP availability: ${context.includeMcp ? "included" : "not requested"}`,
    `- Repository contents: ${context.includeRepository ? "included" : "not requested"}`,
    `- Recent runs: ${context.includeRecentRuns ? "included" : "not requested"}`,
  ].join("\n");
}

function buildTurnPrompt(input: RepositoryChatTurnInput): string {
  const repositoryInstruction = input.context.includeRepository
    ? `The repository is mounted at /workspace/${input.repoName}. Inspect it only with read-only commands or read-only MCP calls when needed.`
    : "The user did not request repository contents for this turn; prefer dashboard configuration context unless contents are necessary to answer safely.";

  return `Repository chat turn

Repository: ${input.repo}
GitHub URL: https://github.com/${input.repo}

Requested context scopes:
${contextFlagLines(input.context)}

Dashboard context snapshot:
${input.dashboardContext}

Conversation history stored by the dashboard:
${formatHistory(input.history)}

Current user question:
${input.message.trim()}

Instructions for this turn:
- Answer the current question, using the dashboard context and repository/MCP inspection only when useful.
- ${repositoryInstruction}
- Stay read-only. Do not change files, repository state, issues, PRs, MCP settings, or dashboard settings.
- If the answer depends on repository files, cite the file paths you inspected.
- If the answer depends on MCP configuration, cite the MCP server names and env var names, never token values.`;
}

function extractAgentMessageText(event: BetaManagedAgentsSessionEvent): string | null {
  if (event.type !== "agent.message") {
    return null;
  }

  const text = event.content
    .flatMap((contentBlock) => (contentBlock.type === "text" ? [contentBlock.text] : []))
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

async function readLatestAssistantMessage(
  client: RepositoryChatAnthropicClient,
  sessionId: string,
): Promise<string | null> {
  let latest: string | null = null;
  for await (const event of client.beta.sessions.events.list(sessionId, {
    limit: 200,
    order: "asc",
  })) {
    const text = extractAgentMessageText(event);
    if (text !== null) {
      latest = text;
    }
  }

  return latest;
}

export async function runRepositoryChatTurn(
  input: RepositoryChatTurnInput,
  deps: RepositoryChatDeps,
): Promise<RepositoryChatTurnResult> {
  const logger = deps.logger.child({ component: "repo-chat", repo: input.repo });
  const githubAuth = await resolveRepositoryAuthorization(input, deps);
  const agent = await ensureRepoChatAgent(deps);
  const environmentId = await ensureChatEnvironment(deps, input.repo);
  const enabledMcpServers = deps.db.listMcpServers().filter((server) => server.enabled);
  const vault = await ensureChatVault(deps, enabledMcpServers, githubAuth);
  let sessionId: string | undefined;

  try {
    const session = await deps.anthropicClient.beta.sessions.create({
      agent: agent.agentId,
      environment_id: environmentId,
      resources: [
        {
          authorization_token: githubAuth.authorizationToken,
          checkout: { name: deps.config.pr.base ?? "main", type: "branch" },
          mount_path: `/workspace/${input.repoName}`,
          type: "github_repository",
          url: `https://github.com/${input.repo}`,
        },
      ],
      ...(vault.vaultId === undefined ? {} : { vault_ids: [vault.vaultId] }),
    });
    sessionId = session.id;

    await deps.anthropicClient.beta.sessions.events.send(sessionId, {
      events: [
        {
          content: [{ text: buildTurnPrompt(input), type: "text" }],
          type: "user.message",
        },
      ],
    });

    const result = await deps.runSession(deps.anthropicClient, {
      handlers: {},
      logger,
      model: deps.config.models.child,
      sessionId,
      timeouts: { maxWallClockMs: deps.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS },
    });

    if (result.errored) {
      throw new Error("Managed Agents chat session errored before completing a response");
    }

    if (result.timedOut) {
      throw new Error("Managed Agents chat session timed out before completing a response");
    }

    const content = await readLatestAssistantMessage(deps.anthropicClient, sessionId);
    if (content === null) {
      throw new Error("Managed Agents chat session completed without an assistant message");
    }

    return { content, sessionId };
  } finally {
    if (sessionId !== undefined) {
      try {
        await deps.anthropicClient.beta.sessions.delete(sessionId);
      } catch (error) {
        logger.warn({ err: error, sessionId }, "failed to delete repository chat session");
      }
    }

    if (vault.vaultId !== undefined) {
      try {
        await deps.releaseVault(deps.anthropicClient, {
          credentials: vault.credentials,
          managedVault: vault.managedVault,
          vaultId: vault.vaultId,
        });
      } catch (error) {
        logger.warn(
          { err: error, vaultId: vault.vaultId },
          "failed to release repository chat vault",
        );
      }
    }
  }
}
