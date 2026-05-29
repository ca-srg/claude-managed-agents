import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "octokit";

const TEST_REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 200;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_CHARS = 60_000;

type RuntimeConfig = {
  anthropicApiKey: string;
  dbPath: string;
  githubAppId: string;
  githubAppInstallationId?: string;
  githubAppPrivateKey?: string;
  githubAppPrivateKeyPath?: string;
  host: string;
  issue: number;
  port: number;
  repo: string;
  timeoutMs: number;
};

type ProcessDiagnostics = {
  stderr: string;
  stdout: string;
};

type SseMessage = {
  data: string;
  event?: string;
  id?: string;
};

type HarnessResult = {
  prUrl: string;
  /**
   * `true` when the SSE stream surfaced at least one `session` run-event whose
   * `payload.kind` matched the Managed Agents thread lifecycle (`thread_created`
   * / `thread_message_sent` / `thread_message_received` / `thread_status_*`).
   * The harness keeps this best-effort: a successful run with no observable
   * thread events is still reported as a pass, but operators inspecting the
   * marker can confirm the coordinator topology actually delegated.
   */
  threadObserved: boolean;
};

type SpawnedServer = ReturnType<typeof Bun.spawn>;

class HarnessFailure extends Error {
  constructor(
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = "HarnessFailure";
  }
}

function shouldRun(env: NodeJS.ProcessEnv): true | { skipReason: string } {
  if (env.E2E !== "1") {
    return { skipReason: "E2E=1 not set; refusing to run integration harness" };
  }

  const repo = env.TEST_REPO?.trim();
  if (!repo || !TEST_REPO_PATTERN.test(repo)) {
    return { skipReason: "TEST_REPO=<owner>/<repo> required" };
  }

  const issue = Number.parseInt(env.TEST_ISSUE ?? "", 10);
  if (!Number.isInteger(issue) || issue <= 0) {
    return { skipReason: "TEST_ISSUE=<positive int> required" };
  }

  if (!env.ANTHROPIC_API_KEY) {
    return { skipReason: "ANTHROPIC_API_KEY required" };
  }

  if (!env.GITHUB_APP_ID) {
    return { skipReason: "GITHUB_APP_ID required" };
  }

  if (!env.GITHUB_APP_PRIVATE_KEY && !env.GITHUB_APP_PRIVATE_KEY_PATH) {
    return { skipReason: "GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH required" };
  }

  return true;
}

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseRequiredPositiveInteger(name: string, value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be set`);
  }

  return parsePositiveInteger(name, value, 1);
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n");
}

async function readGitHubAppPrivateKey(config: RuntimeConfig): Promise<string> {
  if (config.githubAppPrivateKey !== undefined && config.githubAppPrivateKey.trim().length > 0) {
    return normalizePrivateKey(config.githubAppPrivateKey);
  }

  if (
    config.githubAppPrivateKeyPath !== undefined &&
    config.githubAppPrivateKeyPath.trim().length > 0
  ) {
    return readFile(resolve(process.cwd(), config.githubAppPrivateKeyPath), "utf8");
  }

  throw new Error("GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH required");
}

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (owner === undefined || name === undefined || owner.length === 0 || name.length === 0) {
    throw new Error(`TEST_REPO must be owner/repo, got ${repo}`);
  }

  return { owner, repo: name };
}

function isGitHubHttpError(error: unknown): error is Error & { status: number } {
  return error instanceof Error && typeof (error as { status?: unknown }).status === "number";
}

function createGitHubAppPreflightError(config: RuntimeConfig, error: unknown): Error {
  const statusHint =
    isGitHubHttpError(error) && error.status === 404
      ? "GitHub returned 404 for the app installation lookup. This usually means the GitHub App identified by GITHUB_APP_ID is not installed on the TEST_REPO repository, the repository is not selected for that installation, or the App ID/private key pair belongs to a different GitHub App."
      : "GitHub App authentication or repository access failed.";

  return new Error(
    [
      `GitHub App installation preflight failed for ${config.repo}: ${formatError(error)}`,
      statusHint,
      `Action to fix: install the GitHub App from MY_GITHUB_APP_ID on ${config.repo} and grant Metadata: read, contents: write, issues: write, and pull_requests: write, or update MY_GITHUB_APP_ID/MY_GITHUB_APP_PRIVATE_KEY to the App already installed on that repository.`,
    ].join("\n"),
  );
}

async function verifyGitHubAppInstallation(config: RuntimeConfig): Promise<void> {
  const appId = parseRequiredPositiveInteger("GITHUB_APP_ID", config.githubAppId);
  const privateKey = await readGitHubAppPrivateKey(config);
  const { owner, repo } = splitRepo(config.repo);

  try {
    if (config.githubAppInstallationId !== undefined && config.githubAppInstallationId.trim().length > 0) {
      const installationId = parseRequiredPositiveInteger(
        "GITHUB_APP_INSTALLATION_ID",
        config.githubAppInstallationId,
      );
      const auth = createAppAuth({ appId, installationId, privateKey });
      const installationAuth = await auth({
        installationId,
        repositoryNames: [repo],
        type: "installation",
      });
      const repoOctokit = new Octokit({ auth: installationAuth.token });
      await repoOctokit.request("GET /repos/{owner}/{repo}", { owner, repo });
      return;
    }

    const appOctokit = new Octokit({
      auth: { appId, privateKey },
      authStrategy: createAppAuth,
    });
    await appOctokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
  } catch (error) {
    throw createGitHubAppPreflightError(config, error);
  }
}

function readRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const port = parsePositiveInteger(
    "E2E_PORT",
    env.E2E_PORT,
    30_000 + Math.floor(Math.random() * 1000),
  );
  const timeoutMs = parsePositiveInteger("E2E_TIMEOUT_MS", env.E2E_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  return {
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    dbPath: `/tmp/e2e-real-${Date.now()}-${port}.db`,
    githubAppId: env.GITHUB_APP_ID ?? "",
    githubAppInstallationId: env.GITHUB_APP_INSTALLATION_ID,
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
    githubAppPrivateKeyPath: env.GITHUB_APP_PRIVATE_KEY_PATH,
    host: DEFAULT_HOST,
    issue: Number.parseInt(env.TEST_ISSUE ?? "", 10),
    port,
    repo: env.TEST_REPO?.trim() ?? "",
    timeoutMs,
  };
}

function createChildEnv(env: NodeJS.ProcessEnv, config: RuntimeConfig): Record<string, string> {
  const childEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  return {
    ...childEnv,
    ANTHROPIC_API_KEY: config.anthropicApiKey,
    DB_PATH: config.dbPath,
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
    HOST: config.host,
    PORT: String(config.port),
  };
}

function appendCaptured(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length <= MAX_DIAGNOSTIC_CHARS ? next : next.slice(-MAX_DIAGNOSTIC_CHARS);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function abortMessage(signal: AbortSignal): string {
  if (signal.reason instanceof Error) {
    return signal.reason.message;
  }

  if (typeof signal.reason === "string") {
    return signal.reason;
  }

  return "operation aborted";
}

function diagnosticsText(diagnostics: ProcessDiagnostics): string {
  return [
    "--- server stdout ---",
    diagnostics.stdout.trimEnd() || "<empty>",
    "--- server stderr ---",
    diagnostics.stderr.trimEnd() || "<empty>",
  ].join("\n");
}

function failWithDiagnostics(error: unknown, diagnostics: ProcessDiagnostics): never {
  throw new HarnessFailure(formatError(error), diagnosticsText(diagnostics));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function collectStream(
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

      onChunk(decoder.decode(value, { stream: true }));
    }

    const tail = decoder.decode();
    if (tail.length > 0) {
      onChunk(tail);
    }
  } catch (error) {
    onChunk(`\n[stream read failed: ${formatError(error)}]\n`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(abortMessage(signal)));
      return;
    }

    let abortListener: (() => void) | undefined;
    const timeout = setTimeout(() => {
      if (abortListener !== undefined) {
        signal?.removeEventListener("abort", abortListener);
      }
      resolve();
    }, ms);

    abortListener = () => {
      clearTimeout(timeout);
      reject(new Error(signal === undefined ? "operation aborted" : abortMessage(signal)));
    };
    signal?.addEventListener("abort", abortListener, { once: true });
  });
}

function spawnServer(config: RuntimeConfig, env: NodeJS.ProcessEnv): {
  diagnostics: ProcessDiagnostics;
  proc: SpawnedServer;
} {
  const diagnostics: ProcessDiagnostics = { stderr: "", stdout: "" };
  const proc = Bun.spawn(["bun", "run", "index.ts"], {
    env: createChildEnv(env, config),
    stderr: "pipe",
    stdout: "pipe",
  });

  void collectStream(proc.stdout, (chunk) => {
    diagnostics.stdout = appendCaptured(diagnostics.stdout, chunk);
  });
  void collectStream(proc.stderr, (chunk) => {
    diagnostics.stderr = appendCaptured(diagnostics.stderr, chunk);
  });

  return { diagnostics, proc };
}

async function waitForServerReady(baseUrl: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "server did not return 200";

  while (Date.now() < deadline) {
    if (signal.aborted) {
      throw new Error(abortMessage(signal));
    }

    try {
      const response = await fetch(`${baseUrl}/`, { signal });
      await response.arrayBuffer().catch(() => undefined);

      if (response.status === 200) {
        return;
      }

      lastError = `GET / returned ${response.status}`;
    } catch (error) {
      if (signal.aborted) {
        throw new Error(abortMessage(signal));
      }

      lastError = formatError(error);
    }

    await sleep(READY_POLL_MS, signal);
  }

  throw new Error(`server readiness timed out after ${READY_TIMEOUT_MS}ms: ${lastError}`);
}

async function postRun(baseUrl: string, config: RuntimeConfig, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${baseUrl}/api/runs`, {
    body: JSON.stringify({ issue: config.issue, repo: config.repo }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal,
  });
  const responseText = await response.text();

  if (response.status !== 200) {
    throw new Error(`POST /api/runs returned ${response.status}: ${responseText}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`POST /api/runs returned invalid JSON: ${formatError(error)}`);
  }

  if (!isRecord(payload) || typeof payload.runId !== "string" || payload.runId.length === 0) {
    throw new Error(`POST /api/runs response missing runId: ${responseText}`);
  }

  return payload.runId;
}

function parseSseFrame(frame: string): SseMessage | undefined {
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let hasField = false;

  for (const rawLine of frame.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }

    hasField = true;
    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    const rawValue = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      event = value;
    } else if (field === "id") {
      id = value;
    }
  }

  if (!hasField) {
    return undefined;
  }

  return { data: dataLines.join("\n"), event, id };
}

function parseJsonPayload(data: string, event: string): unknown {
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new Error(`SSE ${event} event returned invalid JSON: ${formatError(error)}; data=${data}`);
  }
}

function payloadMessage(payload: unknown): string {
  if (isRecord(payload) && typeof payload.message === "string") {
    return payload.message;
  }

  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }

  return JSON.stringify(payload) ?? String(payload);
}

const THREAD_EVENT_KIND_PREFIXES = ["thread_created", "thread_message_", "thread_status_"];

function isThreadEventKind(kind: unknown): boolean {
  if (typeof kind !== "string") {
    return false;
  }

  return THREAD_EVENT_KIND_PREFIXES.some((prefix) => kind.startsWith(prefix));
}

type SseInspection = {
  prUrl?: string;
  threadObserved: boolean;
};

function inspectSseMessage(message: SseMessage): SseInspection {
  if (message.event === "error") {
    const payload = parseJsonPayload(message.data, "error");
    throw new Error(`run emitted error event: ${payloadMessage(payload)}`);
  }

  // Surface coordinator delegation as a best-effort signal. The session
  // run-event payload shape is `{ kind, sessionId, details? }` where `kind`
  // doubles as the thread lifecycle name once delegation occurs.
  if (message.event === "session" && message.data.length > 0) {
    try {
      const payload = JSON.parse(message.data) as unknown;
      if (isRecord(payload) && isThreadEventKind(payload.kind)) {
        return { threadObserved: true };
      }
    } catch {
      // Non-JSON or malformed session payloads are tolerated; SSE stream
      // integrity is checked by the run completion path itself.
    }
    return { threadObserved: false };
  }

  if (message.event !== "complete") {
    return { threadObserved: false };
  }

  const payload = parseJsonPayload(message.data, "complete");
  if (!isRecord(payload)) {
    throw new Error(`complete event payload must be an object: ${message.data}`);
  }

  if (payload.status !== "completed") {
    throw new Error(`complete event status was ${String(payload.status)}, expected completed`);
  }

  if (typeof payload.prUrl !== "string" || payload.prUrl.trim().length === 0) {
    throw new Error(`complete event missing prUrl: ${message.data}`);
  }

  return { prUrl: payload.prUrl, threadObserved: false };
}

async function waitForCompleteEvent(
  baseUrl: string,
  runId: string,
  signal: AbortSignal,
): Promise<HarnessResult> {
  const response = await fetch(`${baseUrl}/api/runs/${runId}/events`, {
    headers: { Accept: "text/event-stream" },
    signal,
  });

  if (response.status !== 200) {
    throw new Error(`GET /api/runs/${runId}/events returned ${response.status}: ${await response.text()}`);
  }

  if (response.body === null) {
    throw new Error("SSE response body is empty");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sseLog: string[] = [];
  let buffer = "";
  // Accumulate thread observation across the whole SSE lifetime — a single
  // delegation event anywhere in the stream is enough to flip this to true.
  let threadObserved = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let separatorIndex = buffer.indexOf("\n\n");

      while (separatorIndex !== -1) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const message = parseSseFrame(frame);
        if (message !== undefined) {
          sseLog.push(`${message.id ?? "<no-id>"} ${message.event ?? "message"} ${message.data}`);
          const inspection = inspectSseMessage(message);
          threadObserved = threadObserved || inspection.threadObserved;
          if (inspection.prUrl !== undefined) {
            return { prUrl: inspection.prUrl, threadObserved };
          }
        }

        separatorIndex = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`${abortMessage(signal)}; sse_log=${sseLog.join(" | ") || "<empty>"}`);
    }

    throw new Error(`${formatError(error)}; sse_log=${sseLog.join(" | ") || "<empty>"}`);
  } finally {
    reader.releaseLock();
  }

  throw new Error(`SSE stream ended before complete event; sse_log=${sseLog.join(" | ") || "<empty>"}`);
}

async function stopServer(proc: SpawnedServer): Promise<void> {
  try {
    proc.kill("SIGTERM");
  } catch {
    return;
  }

  const exited = await Promise.race([
    proc.exited.then(() => "exited" as const),
    sleep(SHUTDOWN_TIMEOUT_MS).then(() => "timeout" as const),
  ]);

  if (exited === "timeout") {
    try {
      proc.kill("SIGKILL");
    } catch {
      return;
    }

    await Promise.race([proc.exited, sleep(1_000)]);
  }
}

async function removeDatabaseFiles(dbPath: string): Promise<void> {
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
  ]);
}

async function runHarness(config: RuntimeConfig, env: NodeJS.ProcessEnv): Promise<HarnessResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`watchdog timeout after ${config.timeoutMs}ms`));
  }, config.timeoutMs);
  const { diagnostics, proc } = spawnServer(config, env);
  const baseUrl = `http://${config.host}:${config.port}`;

  try {
    await waitForServerReady(baseUrl, controller.signal);
    const runId = await postRun(baseUrl, config, controller.signal);
    return await waitForCompleteEvent(baseUrl, runId, controller.signal);
  } catch (error) {
    failWithDiagnostics(error, diagnostics);
  } finally {
    clearTimeout(timeout);
    await stopServer(proc);
    await removeDatabaseFiles(config.dbPath);
  }
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const gate = shouldRun(env);
  if (gate !== true) {
    process.stdout.write(`e2e-real: skipping (${gate.skipReason})\n`);
    process.exit(0);
  }

  try {
    const result = await runHarness(readRuntimeConfig(env), env);
    process.stdout.write(
      `E2E_REAL_PASS pr_url=${result.prUrl} thread_observed=${String(result.threadObserved)}\n`,
    );
    process.exit(0);
  } catch (error) {
    process.stderr.write(`E2E_REAL_FAIL ${formatError(error)}\n`);
    if (error instanceof HarnessFailure && error.details !== undefined) {
      process.stderr.write(`${error.details}\n`);
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  await main(process.env);
}
