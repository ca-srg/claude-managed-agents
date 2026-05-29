import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ServerProcess = {
  exited: Promise<number>;
  kill(signal?: string): boolean;
  stderr: ReadableStream<Uint8Array> | null;
  stdout: ReadableStream<Uint8Array> | null;
};

const TEST_GITHUB_APP_PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "test-private-key-material-used-only-for-startup-tests",
  "-----END PRIVATE KEY-----",
].join("\\n");

declare const Bun: {
  env: NodeJS.ProcessEnv;
  sleep(ms: number): Promise<void>;
  spawn(
    command: string[],
    options: {
      env: NodeJS.ProcessEnv;
      stderr: "pipe";
      stdout: "pipe";
    },
  ): ServerProcess;
};

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("failed to reserve TCP port")));
        return;
      }

      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

describe("index.ts HTTP entrypoint", () => {
  let tmpDir: string;
  let dbPath: string;
  let port: number;
  let child: ServerProcess | undefined;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "index-test-"));
    dbPath = join(tmpDir, "dashboard.db");
    port = await getAvailablePort();
  });

  afterEach(async () => {
    if (child) {
      try {
        child.kill("SIGTERM");
        await child.exited;
      } catch {
        // Process may already have exited in failure-path tests.
      }
      child = undefined;
    }

    try {
      rmSync(tmpDir, { force: true, recursive: true });
    } catch {
      // Best-effort cleanup for temporary test directories.
    }
  });

  async function spawnIndex(env: Record<string, string> = {}) {
    child = Bun.spawn(["bun", "run", "index.ts"], {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-ant-test",
        DB_PATH: dbPath,
        GITHUB_APP_ID: "12345",
        GITHUB_APP_INSTALLATION_ID: "",
        GITHUB_APP_PRIVATE_KEY: TEST_GITHUB_APP_PRIVATE_KEY,
        GITHUB_APP_PRIVATE_KEY_PATH: "",
        HOST: "127.0.0.1",
        PORT: String(port),
        ...env,
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) {
          return;
        }
      } catch {
        // Server is still booting.
      }

      await Bun.sleep(120);
    }

    throw new Error("server failed to start");
  }

  test("starts and serves /", async () => {
    await spawnIndex();

    const response = await fetch(`http://127.0.0.1:${port}/`);

    expect(response.status).toBe(200);
  });

  test("serves /runs/new", async () => {
    await spawnIndex();

    const response = await fetch(`http://127.0.0.1:${port}/runs/new`);

    expect(response.status).toBe(200);
  });

  test("serves GET /api/runs", async () => {
    await spawnIndex();

    const response = await fetch(`http://127.0.0.1:${port}/api/runs`);
    const body = (await response.json()) as { runs?: unknown };

    expect(response.status).toBe(200);
    expect("runs" in body).toBe(true);
    expect(Array.isArray(body.runs)).toBe(true);
  });

  test("graceful shutdown via SIGINT", async () => {
    await spawnIndex();

    child?.kill("SIGINT");
    const exitCode = await child?.exited;
    child = undefined;

    expect(exitCode).toBe(0);
  });

  test("exits with error when ANTHROPIC_API_KEY is missing", async () => {
    const missingKeyPort = await getAvailablePort();
    const proc = Bun.spawn(["bun", "run", "index.ts"], {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "",
        DB_PATH: dbPath,
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: TEST_GITHUB_APP_PRIVATE_KEY,
        HOST: "127.0.0.1",
        PORT: String(missingKeyPort),
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
  });

  test("exits with error when GitHub App authentication is missing", async () => {
    const missingAuthPort = await getAvailablePort();
    const proc = Bun.spawn(["bun", "run", "index.ts"], {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-ant-test",
        DB_PATH: dbPath,
        GITHUB_APP_ID: "",
        GITHUB_APP_INSTALLATION_ID: "",
        GITHUB_APP_PRIVATE_KEY: "",
        GITHUB_APP_PRIVATE_KEY_PATH: "",
        HOST: "127.0.0.1",
        PORT: String(missingAuthPort),
      },
      stderr: "pipe",
      stdout: "pipe",
    });

    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
  });

  test("orphan resync on startup aborts running runs", async () => {
    const { createDbModule } = await import("@/shared/persistence/db");
    const seedDb = createDbModule(dbPath);
    seedDb.initDb();
    seedDb.insertRun({
      branch: "test/orphan",
      issueNumber: 1,
      repo: "owner/name",
      runId: "orphan-run-id",
      sessionIds: [],
      startedAt: new Date().toISOString(),
      subIssues: [],
    });
    seedDb.setRunStatus("orphan-run-id", "running");
    seedDb.close();

    await spawnIndex();

    const verifyDb = createDbModule(dbPath);
    const run = verifyDb.listRuns({ limit: 10_000 }).find((item) => item.runId === "orphan-run-id");
    verifyDb.close();

    expect(run?.status).toBe("aborted");
  });
});
