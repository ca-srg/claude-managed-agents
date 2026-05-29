import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

type ServerProcess = {
  exited: Promise<number>;
  kill(signal?: string): boolean;
  stderr: ReadableStream<Uint8Array> | null;
  stdout: ReadableStream<Uint8Array> | null;
};

declare const Bun: {
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

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

let child: ServerProcess | undefined;
let baseUrl = "";
let dbDir: string | undefined;
let stdout = "";
let stderr = "";
let exitCode: number | undefined;
let streamPumps: Promise<void>[] = [];

function randomHighPort(): number {
  return 30_000 + Math.floor(Math.random() * 20_000);
}

function testToken(value: string | undefined, fallback: string): string {
  return value?.trim() ? value : fallback;
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
    // Expected when the spawned server is terminated during teardown.
  }
}

function serverDiagnostics(): string {
  return `\n--- stdout ---\n${stdout.slice(-4_000)}\n--- stderr ---\n${stderr.slice(-4_000)}`;
}

async function waitForServerReady(): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (exitCode !== undefined) {
      throw new Error(`server exited before readiness (code ${exitCode})${serverDiagnostics()}`);
    }

    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await Bun.sleep(150);
  }

  throw new Error(`server did not become ready: ${String(lastError)}${serverDiagnostics()}`);
}

async function fetchText(
  path: string,
  init?: RequestInit,
): Promise<{ body: string; response: Response }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.text();
  return { body, response };
}

async function postForm(
  path: string,
  fields: Record<string, string>,
): Promise<{ body: string; response: Response }> {
  return fetchText(path, {
    body: new URLSearchParams(fields),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });
}

function promptBody(label: string): string {
  return `${label}\nunique prompts e2e body ${Date.now()} ${Math.random()}`;
}

function hiddenRevisionIds(html: string): number[] {
  return [...html.matchAll(/name="revision_id" value="(\d+)"/g)].map((match) =>
    Number(match[1]),
  );
}

function renderedRevisionIds(html: string): number[] {
  return [...html.matchAll(/<span[^>]*>#(\d+)<\/span>/g)].map((match) => Number(match[1]));
}

function expectNoStore(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}

const TEST_GITHUB_APP_PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----",
  "test-private-key-material-used-only-for-prompts-e2e",
  "-----END PRIVATE KEY-----",
].join("\\n");

beforeAll(async () => {
  const port = randomHighPort();
  dbDir = await mkdtemp(join(tmpdir(), "github-issue-agent-prompts-e2e-"));
  const dbPath = join(dbDir, "dashboard.db");
  baseUrl = `http://127.0.0.1:${port}`;

  child = Bun.spawn(["bun", "run", "index.ts"], {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: testToken(process.env.ANTHROPIC_API_KEY, "sk-ant-test-fake"),
      DB_PATH: dbPath,
      GITHUB_APP_ID: testToken(process.env.GITHUB_APP_ID, "12345"),
      GITHUB_APP_PRIVATE_KEY: testToken(
        process.env.GITHUB_APP_PRIVATE_KEY,
        TEST_GITHUB_APP_PRIVATE_KEY,
      ),
      HOST: "127.0.0.1",
      LOG_LEVEL: "fatal",
      PORT: String(port),
    },
    stderr: "pipe",
    stdout: "pipe",
  });

  void child.exited.then((code: number) => {
    exitCode = code;
  });

  streamPumps = [
    consumeStream(child.stdout, (chunk) => {
      stdout += chunk;
    }),
    consumeStream(child.stderr, (chunk) => {
      stderr += chunk;
    }),
  ];

  await waitForServerReady();
}, STARTUP_TIMEOUT_MS + 5_000);

afterAll(async () => {
  if (child !== undefined) {
    try {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(SHUTDOWN_TIMEOUT_MS).then(() => false),
      ]);
      if (!exited) {
        child.kill("SIGKILL");
        await child.exited;
      }
    } finally {
      await Promise.allSettled(streamPumps);
    }
  }

  if (dbDir !== undefined) {
    await rm(dbDir, { force: true, recursive: true });
  }
});

describe("prompts e2e", () => {
  test("GET /prompts returns all prompt keys and no-store", async () => {
    const { body, response } = await fetchText("/prompts");

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('data-prompt-key="parent.system"');
    expect(body).toContain('data-prompt-key="child.system"');
    expect(body).toContain('data-prompt-key="parent.runtime"');
    expect(body).toContain('data-prompt-key="child.runtime"');
  });

  test("GET /prompts/parent.system returns editable detail and seeded history", async () => {
    const { body, response } = await fetchText("/prompts/parent.system");

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toContain("parent.system");
    expect(body).toContain('action="/prompts/parent.system"');
    expect(body).toMatch(/class="prompt-form\b[^"]*"/);
    expect(body).toMatch(/class="prompt-history-list\b[^"]*"/);
    expect(body).toMatch(/class="prompt-history-source seed\b[^"]*"/);
  });

  test("GET /prompts/parent.runtime returns read-only detail without edit form", async () => {
    const { body, response } = await fetchText("/prompts/parent.runtime");

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toContain("parent.runtime");
    expect(body).toMatch(/<pre[^>]*class="prompt-readonly\b[^"]*"/);
    expect(body).toContain("This is a hardcoded runtime template. Read-only in MVP.");
    expect(body).not.toContain('action="/prompts/parent.runtime"');
    expect(body).not.toMatch(/class="prompt-history-list\b[^"]*"/);
  });

  test("GET /prompts/bogus.key returns 404", async () => {
    const { body, response } = await fetchText("/prompts/bogus.key");

    expect(response.status).toBe(404);
    expectNoStore(response);
    expect(body).toContain("404");
  });

  test("GET /prompts/parent.system?no_change=1 renders no-change notice", async () => {
    const { body, response } = await fetchText("/prompts/parent.system?no_change=1");

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toMatch(/class="prompt-no-changes-banner\b[^"]*"/);
    expect(body).toContain("Saved with same content — no new revision created.");
  });

  test("GET /prompts/child.system returns editable seeded prompt", async () => {
    const { body, response } = await fetchText("/prompts/child.system");

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toContain("child.system");
    expect(body).toContain('action="/prompts/child.system"');
    expect(body).toContain('name="body"');
  });

  test("POST save /prompts/parent.system valid body redirects and normalizes CRLF", async () => {
    const bodyText = "Updated parent prompt\r\nwith normalized line endings";

    const { response } = await postForm("/prompts/parent.system", { body: bodyText });
    const detail = await fetchText("/prompts/parent.system");

    expect(response.status).toBe(302);
    expectNoStore(response);
    expect(response.headers.get("Location")).toBe("/prompts/parent.system");
    expect(detail.body).toContain("Updated parent prompt\nwith normalized line endings");
  });

  test("POST save /prompts/parent.system identical body redirects with no_change", async () => {
    const bodyText = promptBody("Identical parent prompt body");

    const first = await postForm("/prompts/parent.system", { body: bodyText });
    const second = await postForm("/prompts/parent.system", { body: bodyText });

    expect(first.response.status).toBe(302);
    expectNoStore(first.response);
    expect(first.response.headers.get("Location")).toBe("/prompts/parent.system");
    expect(second.response.status).toBe(302);
    expectNoStore(second.response);
    expect(second.response.headers.get("Location")).toBe("/prompts/parent.system?no_change=1");
  });

  test("POST validation /prompts/parent.system empty body returns 400", async () => {
    const { response } = await postForm("/prompts/parent.system", { body: "" });

    expect(response.status).toBe(400);
    expectNoStore(response);
  });

  test("POST validation /prompts/parent.system body over 102400 chars returns 400", async () => {
    const { response } = await postForm("/prompts/parent.system", { body: "x".repeat(102_401) });

    expect(response.status).toBe(400);
    expectNoStore(response);
  });

  test("POST validation /prompts/parent.system whitespace-only body returns 400", async () => {
    const { response } = await postForm("/prompts/parent.system", { body: " ".repeat(12) });

    expect(response.status).toBe(400);
    expectNoStore(response);
  });

  test("POST validation /prompts/parent.runtime valid body returns 400", async () => {
    const { response } = await postForm("/prompts/parent.runtime", {
      body: "Runtime body remains read only",
    });

    expect(response.status).toBe(400);
    expectNoStore(response);
  });

  test("POST validation /prompts/bogus.key valid body returns 400", async () => {
    const { response } = await postForm("/prompts/bogus.key", {
      body: "Valid body for invalid prompt key",
    });

    expect(response.status).toBe(400);
    expectNoStore(response);
  });

  test("POST validation /prompts/parent.system trimmed body shorter than 10 returns 400", async () => {
    const { response } = await postForm("/prompts/parent.system", { body: "     short    " });

    expect(response.status).toBe(400);
    expectNoStore(response);
  });

  test("GET /prompts/parent.system shows edit history, current badge, diff, and restore forms", async () => {
    const firstBody = promptBody("First history parent prompt body");
    const secondBody = promptBody("Second history parent prompt body");

    await postForm("/prompts/parent.system", { body: firstBody });
    await postForm("/prompts/parent.system", { body: secondBody });
    const { body, response } = await fetchText("/prompts/parent.system");

    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(body).toMatch(/class="prompt-history-list\b[^"]*"/);
    expect(body).toMatch(/class="diff-viewer\b[^"]*"/);
    expect(body).toMatch(/class="prompt-history-source edit\b[^"]*"/);
    expect(body).toMatch(/class="prompt-badge editable\b[^"]*"/);
    expect(body).toContain("First history parent prompt body");
    expect(body).toContain("Second history parent prompt body");
    expect(hiddenRevisionIds(body).length >= 1).toBe(true);
    expect(renderedRevisionIds(body).length >= 3).toBe(true);
  });

  test("POST restore /prompts/parent.system valid prior revision redirects", async () => {
    const firstBody = promptBody("First restorable parent prompt body");
    const secondBody = promptBody("Second current parent prompt body");

    await postForm("/prompts/parent.system", { body: firstBody });
    await postForm("/prompts/parent.system", { body: secondBody });
    const beforeRestore = await fetchText("/prompts/parent.system");
    const priorRevisionId = hiddenRevisionIds(beforeRestore.body).at(0);

    expect(priorRevisionId).toBeDefined();
    if (priorRevisionId === undefined) {
      throw new Error("expected a prior revision restore form");
    }

    const restored = await postForm("/prompts/parent.system/restore", {
      revision_id: String(priorRevisionId),
    });
    const afterRestore = await fetchText("/prompts/parent.system");

    expect(restored.response.status).toBe(302);
    expectNoStore(restored.response);
    expect(restored.response.headers.get("Location")).toBe("/prompts/parent.system");
    expect(afterRestore.body).toContain(firstBody);
    expect(afterRestore.body).toMatch(/class="prompt-history-source restore\b[^"]*"/);
  });

  test("POST restore /prompts/parent.system current revision redirects with already_current", async () => {
    const currentBody = promptBody("Already current parent prompt body");

    await postForm("/prompts/parent.system", { body: currentBody });
    const detail = await fetchText("/prompts/parent.system");
    const currentRevisionId = Math.max(...renderedRevisionIds(detail.body));

    const restored = await postForm("/prompts/parent.system/restore", {
      revision_id: String(currentRevisionId),
    });
    const notice = await fetchText("/prompts/parent.system?already_current=1");

    expect(restored.response.status).toBe(302);
    expectNoStore(restored.response);
    expect(restored.response.headers.get("Location")).toBe("/prompts/parent.system?already_current=1");
    expect(notice.body).toContain("Already at this revision — restore had no effect.");
  });

  test("POST restore /prompts/parent.system child revision_id returns 404", async () => {
    await postForm("/prompts/child.system", { body: promptBody("Child-owned prompt body") });
    const childDetail = await fetchText("/prompts/child.system");
    const childRevisionId = Math.max(...renderedRevisionIds(childDetail.body));

    const { response } = await postForm("/prompts/parent.system/restore", {
      revision_id: String(childRevisionId),
    });

    expect(response.status).toBe(404);
    expectNoStore(response);
  });

  test("POST restore validation /prompts/parent.system invalid revision_id returns 400", async () => {
    for (const revisionId of ["0", "-1", "1.5"]) {
      const { response } = await postForm("/prompts/parent.system/restore", {
        revision_id: revisionId,
      });

      expect(response.status).toBe(400);
      expectNoStore(response);
    }
  });

  test("POST restore /prompts/parent.system non-existent revision_id returns 404", async () => {
    const { response } = await postForm("/prompts/parent.system/restore", {
      revision_id: "99999",
    });

    expect(response.status).toBe(404);
    expectNoStore(response);
  });
});
