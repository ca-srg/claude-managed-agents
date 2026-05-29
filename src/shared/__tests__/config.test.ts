import { describe, expect, it, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";

import { loadConfig } from "../config";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "github-issue-config-"));
}

function cleanupTempDir(directoryPath: string): void {
  rmSync(directoryPath, { force: true, recursive: true });
}

function writeTsConfig(directoryPath: string, fileName: string, configSource: string): string {
  const filePath = join(directoryPath, fileName);
  writeFileSync(filePath, `export default ${configSource};\n`);
  return filePath;
}

function writeJsonConfig(directoryPath: string, fileName: string, jsonSource: string): string {
  const filePath = join(directoryPath, fileName);
  writeFileSync(filePath, `${jsonSource}\n`);
  return filePath;
}

async function expectZodError(resultPromise: Promise<unknown>): Promise<ZodError> {
  try {
    await resultPromise;
  } catch (error) {
    if (error instanceof ZodError) {
      return error;
    }

    throw error;
  }

  throw new Error("Expected config loading to fail with ZodError");
}

async function withEnv(
  environmentPatch: NodeJS.ProcessEnv,
  run: () => Promise<void>,
): Promise<void> {
  const previousEnvironment = { ...process.env };

  for (const [key, value] of Object.entries(environmentPatch)) {
    if (typeof value === "undefined") {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  try {
    await run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnvironment)) {
        delete process.env[key];
      }
    }

    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (typeof value === "undefined") {
        delete process.env[key];
        continue;
      }

      process.env[key] = value;
    }
  }
}

async function withWorkingDirectory(
  directoryPath: string,
  run: () => Promise<void>,
): Promise<void> {
  const previousWorkingDirectory = process.cwd();
  process.chdir(directoryPath);

  try {
    await run();
  } finally {
    process.chdir(previousWorkingDirectory);
  }
}

describe("loadConfig", () => {
  test("parses a valid JSON config file", async () => {
    const directoryPath = createTempDir();

    try {
      const configPath = writeJsonConfig(
        directoryPath,
        "github-issue-agent.config.json",
        JSON.stringify({
          commitStyle: "squash",
          git: {
            authorEmail: "bot@example.com",
            authorName: "bot",
          },
          maxChildMinutes: 45,
          maxRunMinutes: 90,
          maxSubIssues: 7,
          models: {
            child: "claude-sonnet-4-6",
            parent: "claude-opus-4-7",
          },
          pr: {
            base: "release",
            draft: false,
          },
          vaultId: "vault_123",
        }),
      );

      const config = await loadConfig(configPath);

      expect(config).toEqual({
        commitStyle: "squash",
        git: {
          authorEmail: "bot@example.com",
          authorName: "bot",
        },
        maxChildMinutes: 45,
        maxRunMinutes: 90,
        maxSubIssues: 7,
        models: {
          child: "claude-sonnet-4-6",
          parent: "claude-opus-4-7",
        },
        pr: {
          base: "release",
          draft: false,
        },
        vaultId: "vault_123",
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  it("reports zod field paths for invalid config", async () => {
    const directoryPath = createTempDir();

    try {
      const configPath = writeTsConfig(
        directoryPath,
        "invalid.config.ts",
        '{ models: { child: 123 }, maxSubIssues: "five" }',
      );

      const zodError = await expectZodError(loadConfig(configPath));

      expect(zodError.issues.some((issue) => issue.path.join(".") === "models.child")).toBe(true);
      expect(zodError.issues.some((issue) => issue.path.join(".") === "maxSubIssues")).toBe(true);
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  it("returns default models when no config file or env overrides are present", async () => {
    const directoryPath = createTempDir();

    try {
      await withEnv(
        {
          CHILD_MODEL: undefined,
          MAX_RUN_MINUTES: undefined,
          MAX_SUB_ISSUES: undefined,
          PARENT_MODEL: undefined,
          VAULT_ID: undefined,
        },
        async () => {
          await withWorkingDirectory(directoryPath, async () => {
            const config = await loadConfig();

            expect(config.models).toEqual({
              child: "claude-sonnet-4-6",
              parent: "claude-opus-4-7",
            });
          });
        },
      );
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  it("applies env overrides after parsing the config file", async () => {
    const directoryPath = createTempDir();

    try {
      const configPath = writeTsConfig(
        directoryPath,
        "env-override.config.ts",
        '{ models: { parent: "claude-opus-4-7", child: "claude-sonnet-4-6" }, maxSubIssues: 5 }',
      );

      await withEnv({ PARENT_MODEL: "claude-opus-4-8-override" }, async () => {
        const config = await loadConfig(configPath);

        expect(config.models.parent).toBe("claude-opus-4-8-override");
        expect(config.models.child).toBe("claude-sonnet-4-6");
        expect(config.maxSubIssues).toBe(5);
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  it("applies defaults when optional fields are omitted", async () => {
    const directoryPath = createTempDir();

    try {
      writeTsConfig(
        directoryPath,
        "github-issue-agent.config.ts",
        '{ models: { parent: "claude-opus-4-7", child: "claude-sonnet-4-6" } }',
      );

      await withWorkingDirectory(directoryPath, async () => {
        const config = await loadConfig();

        expect(config).toEqual({
          commitStyle: "conventional",
          git: {
            authorEmail: "claude-agent@users.noreply.github.com",
            authorName: "claude-agent[bot]",
          },
          maxChildMinutes: 30,
          maxRunMinutes: 120,
          maxSubIssues: 10,
          models: {
            child: "claude-sonnet-4-6",
            parent: "claude-opus-4-7",
          },
          pr: {
            draft: false,
          },
        });
      });
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  it("rejects thinking as an unknown config key", async () => {
    const directoryPath = createTempDir();

    try {
      const configPath = writeTsConfig(
        directoryPath,
        "thinking.config.ts",
        '{ models: { parent: "claude-opus-4-7", child: "claude-sonnet-4-6" }, thinking: { budget_tokens: 100 } }',
      );

      const zodError = await expectZodError(loadConfig(configPath));

      expect(
        zodError.issues.some(
          (issue) => issue.code === "unrecognized_keys" && issue.keys.includes("thinking"),
        ),
      ).toBe(true);
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  it("rejects reasoningEffort as an unknown config key", async () => {
    const directoryPath = createTempDir();

    try {
      const configPath = writeTsConfig(
        directoryPath,
        "reasoning.config.ts",
        '{ models: { parent: "claude-opus-4-7", child: "claude-sonnet-4-6" }, reasoningEffort: "max" }',
      );

      const zodError = await expectZodError(loadConfig(configPath));

      expect(
        zodError.issues.some(
          (issue) => issue.code === "unrecognized_keys" && issue.keys.includes("reasoningEffort"),
        ),
      ).toBe(true);
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  it("rejects budget_tokens as an unknown config key", async () => {
    const directoryPath = createTempDir();

    try {
      const configPath = writeTsConfig(
        directoryPath,
        "budget.config.ts",
        '{ models: { parent: "claude-opus-4-7", child: "claude-sonnet-4-6" }, budget_tokens: 100 }',
      );

      const zodError = await expectZodError(loadConfig(configPath));

      expect(
        zodError.issues.some(
          (issue) => issue.code === "unrecognized_keys" && issue.keys.includes("budget_tokens"),
        ),
      ).toBe(true);
    } finally {
      cleanupTempDir(directoryPath);
    }
  });

  it("rejects other unknown keys via strict schema", async () => {
    const directoryPath = createTempDir();

    try {
      const configPath = writeTsConfig(
        directoryPath,
        "unknown.config.ts",
        '{ models: { parent: "claude-opus-4-7", child: "claude-sonnet-4-6" }, unexpected: true }',
      );

      const zodError = await expectZodError(loadConfig(configPath));

      expect(
        zodError.issues.some(
          (issue) => issue.code === "unrecognized_keys" && issue.keys.includes("unexpected"),
        ),
      ).toBe(true);
    } finally {
      cleanupTempDir(directoryPath);
    }
  });
});
