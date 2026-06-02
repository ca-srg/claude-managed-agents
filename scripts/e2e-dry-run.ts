import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Env = NodeJS.ProcessEnv;
type ServerProcess = ReturnType<typeof Bun.spawn>;

type DryRunConfig = {
  anthropicApiKey: string;
  githubAppId: string;
  githubAppInstallationId?: string;
  githubAppPrivateKey?: string;
  githubAppPrivateKeyPath?: string;
  issue: number;
  repo: string;
  timeoutMs: number;
};

type ServerHandle = {
  baseUrl: string;
  dbDir: string;
  dbPath: string;
  exitCode: () => number | undefined;
  logs: () => { stderr: string; stdout: string };
  proc: ServerProcess;
  pumps: Promise<void>[];
};

type SseEvent = {
  data: string;
  event: string;
  id?: string;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const SERVER_STARTUP_TIMEOUT_MS = 15_000;
const SERVER_SHUTDOWN_TIMEOUT_MS = 5_000;

function skip(reason: string): number {
  process.stdout.write(`e2e-dry-run: skipping (${reason})\n`);
  return 0;
}

function parsePositiveInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }

  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseTimeoutMs(raw: string | undefined): number {
  const value = parsePositiveInteger(raw);
  return value ?? DEFAULT_TIMEOUT_MS;
}

function readConfig(env: Env): DryRunConfig | { skipReason: string } {
  const missing: string[] = [];
  const anthropicApiKey = env.ANTHROPIC_API_KEY?.trim();
  const githubAppId = env.GITHUB_APP_ID?.trim();
  const githubAppPrivateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  const githubAppPrivateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  const repo = env.TEST_REPO?.trim();
  const issue = parsePositiveInteger(env.TEST_ISSUE);

  if (env.E2E_DRY_RUN !== "1") {
    missing.push("E2E_DRY_RUN=1");
  }
  if (!anthropicApiKey) {
    missing.push("ANTHROPIC_API_KEY");
  }
  if (!githubAppId) {
    missing.push("GITHUB_APP_ID");
  }
  if (!githubAppPrivateKey && !githubAppPrivateKeyPath) {
    missing.push("GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH");
  }
  if (!repo) {
    missing.push("TEST_REPO=<owner>/<repo>");
  } else if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    missing.push("TEST_REPO=<owner>/<repo>");
  }
  if (issue === undefined) {
    missing.push("TEST_ISSUE=<positive int>");
  }

  if (missing.length > 0) {
    return { skipReason: `missing ${missing.join(", ")}` };
  }

  return {
    anthropicApiKey: anthropicApiKey ?? "",
    githubAppId: githubAppId ?? "",
    githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID?.trim() || undefined,
    githubAppPrivateKey: githubAppPrivateKey || undefined,
    githubAppPrivateKeyPath: githubAppPrivateKeyPath || undefined,
    issue: issue ?? 0,
    repo: repo ?? "",
    timeoutMs: parseTimeoutMs(env.E2E_DRY_RUN_TIMEOUT_MS),
  };
}

function randomHighPort(): number {
  return 30_000 + Math.floor(Math.random() * 20_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function consumeStream(
  stream: ReadableStream<Uint8Array> | null,
  onChunk: (chunk: string) => void,
): Promise<void> {
  if (stream === null) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        onChunk(decoder.decode(value, { stream: true }));
      }
    }

    const rest = decoder.decode();
    if (rest.length > 0) {
      onChunk(rest);
    }
  } catch {
    // The reader is expected to be interrupted when the child process is killed.
  }
}

function formatDiagnostics(handle: ServerHandle | undefined): string {
  if (handle === undefined) {
    return "";
  }

  const logs = handle.logs();
  const stdout = logs.stdout.slice(-4_000);
  const stderr = logs.stderr.slice(-4_000);
  return `\n--- server stdout ---\n${stdout}\n--- server stderr ---\n${stderr}`;
}

async function spawnServer(config: DryRunConfig): Promise<ServerHandle> {
  const port = randomHighPort();
  const dbDir = await mkdtemp(join(tmpdir(), "github-issue-agent-dry-run-"));
  const dbPath = join(dbDir, "dashboard.db");
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;

  const proc = Bun.spawn(["bun", "run", "index.ts"], {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: config.anthropicApiKey,
      DB_PATH: dbPath,
      GITHUB_APP_ID: config.githubAppId,
      ...(config.githubAppInstallationId === undefined
        ? {}
        : { GITHUB_APP_INSTALLATION_ID: config.githubAppInstallationId }),
      ...(config.githubAppPrivateKey === undefined
        ? {}
        : { GITHUB_APP_PRIVATE_KEY: config.githubAppPrivateKey }),
      ...(config.githubAppPrivateKeyPath === undefined
        ? {}
        : { GITHUB_APP_PRIVATE_KEY_PATH: config.githubAppPrivateKeyPath }),
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  void proc.exited.then((code) => {
    exitCode = code;
  });

  const pumps = [
    consumeStream(proc.stdout, (chunk) => {
      stdout += chunk;
    }),
    consumeStream(proc.stderr, (chunk) => {
      stderr += chunk;
    }),
  ];

  const handle: ServerHandle = {
    baseUrl: `http://127.0.0.1:${port}`,
    dbDir,
    dbPath,
    exitCode: () => exitCode,
    logs: () => ({ stderr, stdout }),
    proc,
    pumps,
  };

  await waitForServerReady(handle);
  return handle;
}

async function waitForServerReady(handle: ServerHandle): Promise<void> {
  const deadline = Date.now() + SERVER_STARTUP_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const exitCode = handle.exitCode();
    if (exitCode !== undefined) {
      throw new Error(`server exited before readiness (code ${exitCode})`);
    }

    if (handle.logs().stdout.includes("Listening on")) {
      return;
    }

    try {
      const response = await fetch(`${handle.baseUrl}/`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await Bun.sleep(150);
  }

  throw new Error(`server did not become ready: ${errorMessage(lastError)}`);
}

async function stopServer(handle: ServerHandle | undefined): Promise<void> {
  if (handle === undefined) {
    return;
  }

  try {
    handle.proc.kill("SIGTERM");
    const exited = await Promise.race([
      handle.proc.exited.then(() => true),
      Bun.sleep(SERVER_SHUTDOWN_TIMEOUT_MS).then(() => false),
    ]);

    if (!exited) {
      handle.proc.kill("SIGKILL");
      await handle.proc.exited;
    }
  } finally {
    await Promise.allSettled(handle.pumps);
    await rm(handle.dbDir, { force: true, recursive: true });
  }
}

async function startDryRun(handle: ServerHandle, config: DryRunConfig): Promise<string> {
  const response = await fetch(`${handle.baseUrl}/api/runs`, {
    body: JSON.stringify({ dryRun: true, issue: config.issue, repo: config.repo }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`POST /api/runs failed (${response.status}): ${body}`);
  }

  const parsed = JSON.parse(body) as { runId?: unknown };
  if (typeof parsed.runId !== "string" || parsed.runId.length === 0) {
    throw new Error(`POST /api/runs response did not include runId: ${body}`);
  }

  return parsed.runId;
}

async function registerRepository(handle: ServerHandle, config: DryRunConfig): Promise<void> {
  const form = new URLSearchParams();
  form.set("repo", config.repo);

  const response = await fetch(`${handle.baseUrl}/repositories`, {
    body: form,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });
  const body = await response.text();

  if (response.status !== 302 && response.status !== 303) {
    throw new Error(`POST /repositories failed (${response.status}): ${body}`);
  }
}

function parseSseFrame(frame: string): SseEvent | null {
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const rawLine of frame.split("\n")) {
    if (rawLine.length === 0 || rawLine.startsWith(":")) {
      continue;
    }

    const separator = rawLine.indexOf(":");
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    const rawValue = separator === -1 ? "" : rawLine.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "event") {
      event = value;
    } else if (field === "id") {
      id = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0 && id === undefined && event === "message") {
    return null;
  }

  return { data: dataLines.join("\n"), event, id };
}

function parsePayload(event: SseEvent): unknown {
  try {
    return JSON.parse(event.data);
  } catch (error) {
    throw new Error(`invalid JSON in ${event.event} SSE event: ${errorMessage(error)}`);
  }
}

function assertCompletePayload(payload: unknown): { decompositionPlan: unknown } {
  if (typeof payload !== "object" || payload === null || !("decompositionPlan" in payload)) {
    throw new Error(`complete event missing decompositionPlan: ${JSON.stringify(payload)}`);
  }

  const decompositionPlan = payload.decompositionPlan;
  if (!decompositionPlan) {
    throw new Error(`complete event decompositionPlan was empty: ${JSON.stringify(payload)}`);
  }

  return { decompositionPlan };
}

async function waitForCompleteEvent(
  handle: ServerHandle,
  runId: string,
  timeoutMs: number,
): Promise<{ decompositionPlan: unknown }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${handle.baseUrl}/api/runs/${runId}/events`, {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GET /api/runs/${runId}/events failed (${response.status})`);
    }
    if (response.body === null) {
      throw new Error("SSE response body was empty");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }

      buffer = `${buffer}${decoder.decode(value, { stream: true })}`.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseFrame(frame);

        if (event !== null) {
          if (event.event === "error") {
            throw new Error(`run emitted error event: ${event.data}`);
          }
          if (event.event === "complete") {
            return assertCompletePayload(parsePayload(event));
          }
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for complete SSE event`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  throw new Error("SSE stream closed before complete event");
}

export async function main(env: Env): Promise<number> {
  const config = readConfig(env);
  if ("skipReason" in config) {
    return skip(config.skipReason);
  }

  let handle: ServerHandle | undefined;
  try {
    handle = await spawnServer(config);
    await registerRepository(handle, config);
    const runId = await startDryRun(handle, config);
    const payload = await waitForCompleteEvent(handle, runId, config.timeoutMs);
    process.stdout.write(`DECOMPOSITION_PLAN=${JSON.stringify(payload.decompositionPlan)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`e2e-dry-run: failed: ${errorMessage(error)}${formatDiagnostics(handle)}\n`);
    return 1;
  } finally {
    await stopServer(handle);
  }
}

if (import.meta.main) {
  process.exit(await main(process.env));
}
