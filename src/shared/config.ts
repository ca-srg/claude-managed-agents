import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export const ConfigSchema = z
  .object({
    models: z
      .object({
        child: z.string().default("claude-sonnet-4-6"),
        parent: z.string().default("claude-opus-4-8"),
      })
      .default({ child: "claude-sonnet-4-6", parent: "claude-opus-4-8" }),
    maxSubIssues: z.number().int().default(10),
    maxRunMinutes: z.number().int().default(120),
    maxChildMinutes: z.number().int().default(30),
    pr: z
      .object({
        draft: z.boolean().default(false),
        base: z.string().optional(),
      })
      .default({ draft: false }),
    commitStyle: z.string().default("conventional"),
    git: z
      .object({
        authorName: z.string().default("claude-agent[bot]"),
        authorEmail: z.string().default("claude-agent@users.noreply.github.com"),
      })
      .default({
        authorName: "claude-agent[bot]",
        authorEmail: "claude-agent@users.noreply.github.com",
      }),
    vaultId: z.string().optional(),
    /**
     * Claude Console workspace slug used to deep-link recorded Managed Agents
     * sessions from the dashboard. Overridable via the `CONSOLE_WORKSPACE` env
     * var for multi-workspace organizations. When omitted, the dashboard falls
     * back to {@link DEFAULT_CONSOLE_WORKSPACE}.
     */
    consoleWorkspace: z.string().optional(),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG_FILE_NAMES = ["maestro.config.ts", "maestro.config.json"];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function applyEnvOverrides(base: unknown, env: NodeJS.ProcessEnv): unknown {
  const hasModelOverride =
    typeof env.PARENT_MODEL !== "undefined" || typeof env.CHILD_MODEL !== "undefined";
  const hasTopLevelOverride =
    typeof env.MAX_SUB_ISSUES !== "undefined" ||
    typeof env.MAX_RUN_MINUTES !== "undefined" ||
    typeof env.VAULT_ID !== "undefined" ||
    typeof env.CONSOLE_WORKSPACE !== "undefined";

  if (!hasModelOverride && !hasTopLevelOverride) {
    return base;
  }

  const baseRecord = isObjectRecord(base) ? base : {};
  const baseModels = isObjectRecord(baseRecord.models) ? baseRecord.models : {};

  return {
    ...baseRecord,
    ...(hasModelOverride
      ? {
          models: {
            ...baseModels,
            ...(typeof env.PARENT_MODEL === "undefined" ? {} : { parent: env.PARENT_MODEL }),
            ...(typeof env.CHILD_MODEL === "undefined" ? {} : { child: env.CHILD_MODEL }),
          },
        }
      : {}),
    ...(typeof env.MAX_SUB_ISSUES === "undefined"
      ? {}
      : { maxSubIssues: Number(env.MAX_SUB_ISSUES) }),
    ...(typeof env.MAX_RUN_MINUTES === "undefined"
      ? {}
      : { maxRunMinutes: Number(env.MAX_RUN_MINUTES) }),
    ...(typeof env.VAULT_ID === "undefined" ? {} : { vaultId: env.VAULT_ID }),
    ...(typeof env.CONSOLE_WORKSPACE === "undefined"
      ? {}
      : { consoleWorkspace: env.CONSOLE_WORKSPACE }),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveConfigPath(configPath?: string): Promise<string | undefined> {
  if (typeof configPath === "string") {
    return resolve(configPath);
  }

  for (const candidate of DEFAULT_CONFIG_FILE_NAMES) {
    const resolvedCandidate = resolve(candidate);

    if (await fileExists(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }

  return undefined;
}

async function loadConfigSource(configPath: string): Promise<unknown> {
  if (configPath.endsWith(".json")) {
    const fileContents = await readFile(configPath, "utf8");
    return JSON.parse(fileContents) as unknown;
  }

  if (configPath.endsWith(".ts")) {
    const importedModule = (await import(pathToFileURL(configPath).href)) as {
      default?: unknown;
    };

    return typeof importedModule.default === "undefined" ? importedModule : importedModule.default;
  }

  throw new Error(`Unsupported config file extension: ${configPath}`);
}

export async function loadConfig(configPath?: string): Promise<Config> {
  const resolvedConfigPath = await resolveConfigPath(configPath);
  const parsedConfig =
    typeof resolvedConfigPath === "undefined" ? {} : await loadConfigSource(resolvedConfigPath);
  const configWithEnvOverrides = applyEnvOverrides(parsedConfig, process.env);

  return ConfigSchema.strict().parse(configWithEnvOverrides);
}
