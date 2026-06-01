import { z } from "zod";

import { RunOriginSchema } from "@/shared/run-origin";

const NonEmptyStringSchema = z.string().min(1);
const PositiveIntegerSchema = z.number().int().positive();
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const SubIssueSchema = z.object({
  issueId: PositiveIntegerSchema,
  issueNumber: PositiveIntegerSchema,
  taskId: NonEmptyStringSchema,
});

export const RunStateSchema = z.object({
  branch: NonEmptyStringSchema,
  issueNumber: PositiveIntegerSchema.nullable(),
  origin: RunOriginSchema.optional(),
  pid: PositiveIntegerSchema.optional(),
  prUrl: NonEmptyStringSchema.optional(),
  repo: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  sessionIds: z.array(NonEmptyStringSchema),
  startedAt: NonEmptyStringSchema,
  subIssues: z.array(SubIssueSchema),
  vaultId: NonEmptyStringSchema.optional(),
});

/**
 * Cumulative token usage for a session, aggregated client-side from
 * `span.model_request_end` events. The Anthropic Managed Agents Beta API
 * reports tokens but not cost; we compute cost in `@/shared/pricing`.
 *
 * `modelRequestCount` records how many `span.model_request_end` events were
 * observed (zero is valid: a session that never reaches model inference, e.g.
 * aborted before the first turn, has no usage).
 */
export const SessionUsageSchema = z.object({
  inputTokens: NonNegativeIntegerSchema,
  outputTokens: NonNegativeIntegerSchema,
  cacheCreationInputTokens: NonNegativeIntegerSchema,
  cacheReadInputTokens: NonNegativeIntegerSchema,
  modelRequestCount: NonNegativeIntegerSchema,
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

/** Zero-valued `SessionUsage` used as the default for new/placeholder sessions. */
export function emptySessionUsage(): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    modelRequestCount: 0,
  };
}

export const SessionResultSchema = z.object({
  aborted: z.boolean(),
  durationMs: NonNegativeIntegerSchema,
  errored: z.boolean(),
  eventsProcessed: NonNegativeIntegerSchema,
  idleReached: z.boolean(),
  lastEventId: z.union([NonEmptyStringSchema, z.undefined()]),
  /**
   * Model identifier used for cost attribution (e.g. `claude-opus-4-7`).
   * Undefined when the caller did not supply a model (e.g. unit tests). Cost
   * cannot be computed without a model, but token counts still aggregate.
   */
  model: z.union([NonEmptyStringSchema, z.undefined()]).optional(),
  sessionId: NonEmptyStringSchema,
  timedOut: z.boolean(),
  toolErrors: NonNegativeIntegerSchema,
  toolInvocations: NonNegativeIntegerSchema,
  usage: SessionUsageSchema.default(emptySessionUsage()),
});

/**
 * Per-(session, model) usage row stored in the `session_usage` table.
 * One session typically has exactly one row (session-level model is fixed
 * by the agent), but the schema allows multiple to handle future cases
 * where a session is rebound to a different model mid-flight.
 */
export const SessionUsageRowSchema = z.object({
  sessionId: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  inputTokens: NonNegativeIntegerSchema,
  outputTokens: NonNegativeIntegerSchema,
  cacheCreationInputTokens: NonNegativeIntegerSchema,
  cacheReadInputTokens: NonNegativeIntegerSchema,
  modelRequestCount: NonNegativeIntegerSchema,
  costUsd: z.number().nonnegative(),
});
export type SessionUsageRow = z.infer<typeof SessionUsageRowSchema>;

/** Aggregated usage across an arbitrary scope (run, repo, global). */
export const UsageAggregateSchema = z.object({
  inputTokens: NonNegativeIntegerSchema,
  outputTokens: NonNegativeIntegerSchema,
  cacheCreationInputTokens: NonNegativeIntegerSchema,
  cacheReadInputTokens: NonNegativeIntegerSchema,
  modelRequestCount: NonNegativeIntegerSchema,
  costUsd: z.number().nonnegative(),
});
export type UsageAggregate = z.infer<typeof UsageAggregateSchema>;

/** Empty aggregate used when a scope has no `session_usage` rows. */
export function emptyUsageAggregate(): UsageAggregate {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    modelRequestCount: 0,
    costUsd: 0,
  };
}

export const PromptKeySchema = z.enum([
  "parent.system",
  "child.system",
  "parent.runtime",
  "child.runtime",
]);

export type PromptKey = z.infer<typeof PromptKeySchema>;

export const EditablePromptKeySchema = z.enum(["parent.system", "child.system"]);
export type EditablePromptKey = z.infer<typeof EditablePromptKeySchema>;

export const PromptRowSchema = z.object({
  promptKey: PromptKeySchema,
  currentRevisionId: PositiveIntegerSchema,
  updatedAt: NonEmptyStringSchema,
});
export type PromptRow = z.infer<typeof PromptRowSchema>;

export const PromptRevisionSourceSchema = z.enum(["seed", "edit", "restore"]);
export type PromptRevisionSource = z.infer<typeof PromptRevisionSourceSchema>;

export const PromptRevisionRowSchema = z.object({
  id: PositiveIntegerSchema,
  promptKey: PromptKeySchema,
  body: NonEmptyStringSchema,
  createdAt: NonEmptyStringSchema,
  bodySha256: NonEmptyStringSchema,
  source: PromptRevisionSourceSchema,
});
export type PromptRevisionRow = z.infer<typeof PromptRevisionRowSchema>;

// 100KB max, min 10 chars, must contain non-whitespace
export const PromptSaveInputSchema = z.object({
  body: z
    .string()
    .min(10)
    .max(102400)
    .refine((s) => s.trim().length > 0, { message: "body must contain non-whitespace" }),
});
export type PromptSaveInput = z.infer<typeof PromptSaveInputSchema>;

export const RestoreInputSchema = z.object({
  promptKey: EditablePromptKeySchema,
  revisionId: PositiveIntegerSchema,
});
export type RestoreInput = z.infer<typeof RestoreInputSchema>;

// --- Per-repository prompt overrides ---

// `owner/name` slug, validated server-side wherever it is parsed.
const RepoSlugSchema = z
  .string()
  .min(3)
  .max(140)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
    {
      message: "repo must match owner/name",
    },
  );
export type RepoSlug = z.infer<typeof RepoSlugSchema>;
export { RepoSlugSchema };

// Repo-level prompts target either parent or child agent only.
// Runtime templates are not configurable per repo.
export const RepoPromptAgentSchema = z.enum(["parent", "child"]);
export type RepoPromptAgent = z.infer<typeof RepoPromptAgentSchema>;

// Sources for repo prompt revisions: only edits and restores.
// (Seeding does not apply because there is no default body.)
export const RepoPromptRevisionSourceSchema = z.enum(["edit", "restore"]);
export type RepoPromptRevisionSource = z.infer<typeof RepoPromptRevisionSourceSchema>;

export const RepoPromptRowSchema = z.object({
  repo: RepoSlugSchema,
  agent: RepoPromptAgentSchema,
  currentRevisionId: PositiveIntegerSchema,
  updatedAt: NonEmptyStringSchema,
});
export type RepoPromptRow = z.infer<typeof RepoPromptRowSchema>;

export const RepoPromptRevisionRowSchema = z.object({
  id: PositiveIntegerSchema,
  repo: RepoSlugSchema,
  agent: RepoPromptAgentSchema,
  body: NonEmptyStringSchema,
  createdAt: NonEmptyStringSchema,
  bodySha256: NonEmptyStringSchema,
  source: RepoPromptRevisionSourceSchema,
});
export type RepoPromptRevisionRow = z.infer<typeof RepoPromptRevisionRowSchema>;

// Same length window as the global prompt save schema for consistency.
export const RepoPromptSaveInputSchema = z.object({
  body: z
    .string()
    .min(10)
    .max(102400)
    .refine((s) => s.trim().length > 0, { message: "body must contain non-whitespace" }),
});
export type RepoPromptSaveInput = z.infer<typeof RepoPromptSaveInputSchema>;

export const RepoPromptRestoreInputSchema = z.object({
  repo: RepoSlugSchema,
  agent: RepoPromptAgentSchema,
  revisionId: PositiveIntegerSchema,
});
export type RepoPromptRestoreInput = z.infer<typeof RepoPromptRestoreInputSchema>;

export const RepoPromptIdentifierSchema = z.object({
  repo: RepoSlugSchema,
  agent: RepoPromptAgentSchema,
});
export type RepoPromptIdentifier = z.infer<typeof RepoPromptIdentifierSchema>;

// --- Per-repository environment package overrides ---

// All Anthropic-supported package managers (BetaPackagesParams).
export const RepoEnvironmentPackageManagerSchema = z.enum([
  "apt",
  "cargo",
  "gem",
  "go",
  "npm",
  "pip",
]);
export type RepoEnvironmentPackageManager = z.infer<typeof RepoEnvironmentPackageManagerSchema>;

// Single package spec (name optionally with version, manager-specific syntax).
// Conservative format: 1-200 chars, no whitespace, no control chars.
function containsControlChar(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }

  return false;
}

const PackageSpecSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !/\s/.test(s), { message: "package spec must not contain whitespace" })
  .refine((s) => !containsControlChar(s), {
    message: "package spec must not contain control chars",
  });

// Per-manager arrays. All optional; default empty array. Max 200 entries per manager (defensive).
export const RepoEnvironmentPackagesSchema = z
  .object({
    apt: z.array(PackageSpecSchema).max(200).default([]),
    cargo: z.array(PackageSpecSchema).max(200).default([]),
    gem: z.array(PackageSpecSchema).max(200).default([]),
    go: z.array(PackageSpecSchema).max(200).default([]),
    npm: z.array(PackageSpecSchema).max(200).default([]),
    pip: z.array(PackageSpecSchema).max(200).default([]),
  })
  .strict();
export type RepoEnvironmentPackages = z.infer<typeof RepoEnvironmentPackagesSchema>;

export const RepoEnvironmentRevisionSourceSchema = z.enum(["edit", "restore"]);
export type RepoEnvironmentRevisionSource = z.infer<typeof RepoEnvironmentRevisionSourceSchema>;

export const RepoEnvironmentRowSchema = z.object({
  repo: RepoSlugSchema,
  // Anthropic env ID; NULL until first run after a save.
  environmentId: z.string().min(1).nullable(),
  // SHA-256 of the canonical environment definition that was last sent to Anthropic; NULL until first run.
  definitionHash: z.string().min(1).nullable(),
  currentRevisionId: PositiveIntegerSchema,
  updatedAt: NonEmptyStringSchema,
});
export type RepoEnvironmentRow = z.infer<typeof RepoEnvironmentRowSchema>;

export const RepoEnvironmentRevisionRowSchema = z.object({
  id: PositiveIntegerSchema,
  repo: RepoSlugSchema,
  packages: RepoEnvironmentPackagesSchema,
  createdAt: NonEmptyStringSchema,
  packagesSha256: NonEmptyStringSchema,
  source: RepoEnvironmentRevisionSourceSchema,
});
export type RepoEnvironmentRevisionRow = z.infer<typeof RepoEnvironmentRevisionRowSchema>;

export const RepoEnvironmentSaveInputSchema = z.object({
  packages: RepoEnvironmentPackagesSchema,
});
export type RepoEnvironmentSaveInput = z.infer<typeof RepoEnvironmentSaveInputSchema>;

export const RepoEnvironmentRestoreInputSchema = z.object({
  repo: RepoSlugSchema,
  revisionId: PositiveIntegerSchema,
});
export type RepoEnvironmentRestoreInput = z.infer<typeof RepoEnvironmentRestoreInputSchema>;

export const RepoEnvironmentIdentifierSchema = z.object({
  repo: RepoSlugSchema,
});
export type RepoEnvironmentIdentifier = z.infer<typeof RepoEnvironmentIdentifierSchema>;

// --- MCP server configuration ---

// MCP server name as referenced from agent definitions (`mcp_server_name`).
// Anthropic API: 1-64 chars; alphanumeric, dash, underscore. We additionally
// require the first character to be alphanumeric to keep slugs readable.
export const McpServerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, {
    message: "mcp server name must be alphanumeric with optional - or _",
  });
export type McpServerName = z.infer<typeof McpServerNameSchema>;

// MCP server URL. Limited to http/https remote endpoints (stdio MCP servers
// are not supported by Managed Agents `mcp_servers`).
export const McpServerUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .url()
  .refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
    message: "mcp server url must be http(s)",
  });
export type McpServerUrl = z.infer<typeof McpServerUrlSchema>;

// Environment variable name that holds the bearer token for this MCP server.
// Standard POSIX env var name shape: [A-Z_][A-Z0-9_]*, case-insensitive in
// practice; we accept underscores and digits with a letter or underscore lead.
export const EnvVarNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
    message: "env var name must match [A-Za-z_][A-Za-z0-9_]*",
  });
export type EnvVarName = z.infer<typeof EnvVarNameSchema>;

// Remote MCP servers can be public/unauthenticated. In that case the token
// env-var field is intentionally blank and no Vault credential is created.
export const OptionalEnvVarNameSchema = z.union([EnvVarNameSchema, z.literal("")]);
export type OptionalEnvVarName = z.infer<typeof OptionalEnvVarNameSchema>;

// Mirrors `BetaManagedAgentsAlwaysAllowPolicy['type']` /
// `BetaManagedAgentsAlwaysAskPolicy['type']` from the Anthropic SDK.
export const McpPermissionPolicySchema = z.enum(["always_allow", "always_ask"]);
export type McpPermissionPolicy = z.infer<typeof McpPermissionPolicySchema>;

// Row shape returned from SQLite. `enabled` / `isBuiltin` are stored as
// integers (0/1) in SQLite but normalized to booleans in the public API.
export const McpServerRowSchema = z.object({
  id: PositiveIntegerSchema,
  name: McpServerNameSchema,
  url: McpServerUrlSchema,
  tokenEnvName: OptionalEnvVarNameSchema,
  permissionPolicy: McpPermissionPolicySchema,
  enabled: z.boolean(),
  isBuiltin: z.boolean(),
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
});
export type McpServerRow = z.infer<typeof McpServerRowSchema>;

// Input accepted by `createMcpServer`. `name` and `url` are required.
// `enabled` defaults to true; `permissionPolicy` defaults to `always_allow`.
export const McpServerCreateInputSchema = z.object({
  name: McpServerNameSchema,
  url: McpServerUrlSchema,
  tokenEnvName: OptionalEnvVarNameSchema.default(""),
  permissionPolicy: McpPermissionPolicySchema.default("always_allow"),
  enabled: z.boolean().default(true),
});
export type McpServerCreateInput = z.infer<typeof McpServerCreateInputSchema>;

// Input for `updateMcpServer`. The server is identified by id. For builtin
// rows (`is_builtin = 1`), only `tokenEnvName`, `permissionPolicy`, and
// `enabled` may be persisted; `name` and `url` are guarded by the DB layer.
export const McpServerUpdateInputSchema = z.object({
  name: McpServerNameSchema.optional(),
  url: McpServerUrlSchema.optional(),
  tokenEnvName: OptionalEnvVarNameSchema.optional(),
  permissionPolicy: McpPermissionPolicySchema.optional(),
  enabled: z.boolean().optional(),
});
export type McpServerUpdateInput = z.infer<typeof McpServerUpdateInputSchema>;

// --- Global agent registry / default environment state ---

export const AgentRegistryStateSchema = z.object({
  parentAgentId: NonEmptyStringSchema,
  parentAgentVersion: PositiveIntegerSchema,
  childAgentId: NonEmptyStringSchema,
  childAgentVersion: PositiveIntegerSchema,
  definitionHash: NonEmptyStringSchema,
  parentDefinitionHash: NonEmptyStringSchema.nullable(),
  childDefinitionHash: NonEmptyStringSchema.nullable(),
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
});

export const DefaultEnvironmentStateSchema = z.object({
  environmentId: NonEmptyStringSchema,
  definitionHash: NonEmptyStringSchema,
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
});

// --- Repository chat ---

export const RepoChatStateSchema = z.object({
  agentDefinitionHash: NonEmptyStringSchema.nullable(),
  agentId: NonEmptyStringSchema.nullable(),
  agentVersion: PositiveIntegerSchema.nullable(),
  environmentDefinitionHash: NonEmptyStringSchema.nullable(),
  environmentId: NonEmptyStringSchema.nullable(),
  updatedAt: NonEmptyStringSchema,
});
export type RepoChatState = z.infer<typeof RepoChatStateSchema>;

export const RepoChatThreadRowSchema = z.object({
  id: NonEmptyStringSchema,
  repo: RepoSlugSchema,
  title: NonEmptyStringSchema,
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
});
export type RepoChatThreadRow = z.infer<typeof RepoChatThreadRowSchema>;

export const RepoChatMessageRoleSchema = z.enum(["user", "assistant"]);
export type RepoChatMessageRole = z.infer<typeof RepoChatMessageRoleSchema>;

export const RepoChatMessageRowSchema = z.object({
  id: NonEmptyStringSchema,
  threadId: NonEmptyStringSchema,
  role: RepoChatMessageRoleSchema,
  content: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema.nullable(),
  createdAt: NonEmptyStringSchema,
});
export type RepoChatMessageRow = z.infer<typeof RepoChatMessageRowSchema>;

// --- Run-level types (T4) ---
export const RunStatusSchema = z.enum(["queued", "running", "completed", "failed", "aborted"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunPhaseSchema = z.enum([
  "preflight",
  "environment",
  "vault",
  "lock",
  "session_start",
  "decomposition",
  "child_execution",
  "finalize_pr",
  "cleanup",
  "aborted",
]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const RunEventKindSchema = z.enum([
  "phase",
  "session",
  "subIssue",
  "log",
  "complete",
  "error",
]);
export type RunEventKind = z.infer<typeof RunEventKindSchema>;

export const RunEventSchema = z.object({
  id: NonEmptyStringSchema,
  runId: NonEmptyStringSchema,
  ts: NonEmptyStringSchema,
  kind: RunEventKindSchema,
  payload: z.unknown(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const RunSummarySchema = z.object({
  runId: NonEmptyStringSchema,
  issueNumber: PositiveIntegerSchema.nullable(),
  origin: RunOriginSchema.optional(),
  repo: NonEmptyStringSchema,
  branch: NonEmptyStringSchema.optional(),
  startedAt: NonEmptyStringSchema,
  status: RunStatusSchema,
  phase: RunPhaseSchema.optional(),
  prUrl: NonEmptyStringSchema.optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;
