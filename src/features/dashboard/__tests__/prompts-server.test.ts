import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "@/features/dashboard/server";
import { createDbModule } from "@/shared/persistence/db";
import { getDefaultPrompt } from "@/shared/prompts/defaults";

type DbModule = ReturnType<typeof createDbModule>;

const openDbs: DbModule[] = [];

function createAppWithDb(seed?: (db: DbModule) => void) {
  const db = createDbModule(":memory:");
  openDbs.push(db);
  db.initDb();
  seed?.(db);
  return { app: createApp({ db }), db };
}

function request(path: string): Request {
  return new Request(`http://localhost${path}`);
}

function postFormRequest(path: string, fields: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, {
    body: new URLSearchParams(fields).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe("prompt routes", () => {
  test("GET /prompts returns 200 HTML with all prompt keys and no-store", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(request("/prompts"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toContain("<!doctype html>");
    expect(body).toContain('data-prompt-key="parent.system"');
    expect(body).toContain('data-prompt-key="child.system"');
    expect(body).toContain('data-prompt-key="parent.runtime"');
    expect(body).toContain('data-prompt-key="child.runtime"');
  });

  test("GET /prompts/parent.system returns editable detail with form, history, and diff", async () => {
    const { app } = createAppWithDb((db) => {
      const initialBody = getDefaultPrompt("parent.system");
      db.seedPromptIfMissing("parent.system", initialBody);
      db.savePromptRevision({
        body: `${initialBody}\nEdited body line`,
        key: "parent.system",
        source: "edit",
      });
    });

    const response = await app.request(request("/prompts/parent.system"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("parent.system");
    expect(body).toContain('action="/prompts/parent.system"');
    expect(body).toMatch(/class="prompt-form\b[^"]*"/);
    expect(body).toMatch(/class="prompt-history-list\b[^"]*"/);
    expect(body).toMatch(/class="diff-viewer\b[^"]*"/);
    expect(body).toContain("Edited body line");
  });

  test("GET /prompts/parent.runtime returns read-only detail without revisions", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(request("/prompts/parent.runtime"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("parent.runtime");
    expect(body).toMatch(/<pre[^>]*class="prompt-readonly\b[^"]*"/);
    expect(body).not.toContain('action="/prompts/parent.runtime"');
    expect(body).not.toMatch(/class="prompt-history-list\b[^"]*"/);
  });

  test("GET /prompts/bogus.key returns 404 through c.notFound", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(request("/prompts/bogus.key"));
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toContain("<!doctype html>");
    expect(body).toContain("Not Found");
  });

  test("GET /prompts/parent.system?no_change=1 renders no-change notice", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(request("/prompts/parent.system?no_change=1"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toMatch(/class="prompt-no-changes-banner\b[^"]*"/);
    expect(body).toContain("Saved with same content — no new revision created.");
  });

  test("GET /prompts/child.system falls back to default prompt body when DB is empty", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(request("/prompts/child.system"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toContain(getDefaultPrompt("child.system"));
  });

  test("POST save /prompts/parent.system valid body redirects with no-store", async () => {
    const { app, db } = createAppWithDb();
    const promptBody = "Updated parent prompt\r\nwith normalized line endings";

    const response = await app.request(
      postFormRequest("/prompts/parent.system", { body: promptBody }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Location")).toBe("/prompts/parent.system");
    expect(db.getPrompt("parent.system")?.body).toBe(
      "Updated parent prompt\nwith normalized line endings",
    );
  });

  test("POST save /prompts/parent.system identical body redirects with no_change", async () => {
    const { app } = createAppWithDb();
    const promptBody = "Identical prompt body that is long enough";

    const firstResponse = await app.request(
      postFormRequest("/prompts/parent.system", { body: promptBody }),
    );
    const secondResponse = await app.request(
      postFormRequest("/prompts/parent.system", { body: promptBody }),
    );

    expect(firstResponse.status).toBe(302);
    expect(firstResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(firstResponse.headers.get("Location")).toBe("/prompts/parent.system");
    expect(secondResponse.status).toBe(302);
    expect(secondResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(secondResponse.headers.get("Location")).toBe("/prompts/parent.system?no_change=1");
  });

  test("POST validation /prompts/parent.system empty body returns 400", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(postFormRequest("/prompts/parent.system", { body: "" }));

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("POST validation /prompts/parent.system body over 102400 chars returns 400", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(
      postFormRequest("/prompts/parent.system", { body: "x".repeat(102401) }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("POST validation /prompts/parent.system whitespace-only body returns 400", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(
      postFormRequest("/prompts/parent.system", { body: " ".repeat(12) }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("POST validation /prompts/parent.runtime valid body returns 400", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(
      postFormRequest("/prompts/parent.runtime", { body: "Runtime body remains read only" }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("POST validation /prompts/bogus.key valid body returns 400", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(
      postFormRequest("/prompts/bogus.key", { body: "Valid body for invalid prompt key" }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("POST validation /prompts/parent.system trimmed body shorter than 10 returns 400", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(
      postFormRequest("/prompts/parent.system", { body: "     short    " }),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("POST restore /prompts/parent.system valid prior revision redirects", async () => {
    const firstBody = "First restorable parent prompt body";
    const secondBody = "Second current parent prompt body";
    let firstRevisionId = 0;
    const { app, db } = createAppWithDb((db) => {
      db.seedPromptIfMissing("parent.system", getDefaultPrompt("parent.system"));
      firstRevisionId = db.savePromptRevision({
        body: firstBody,
        key: "parent.system",
        source: "edit",
      }).revisionId;
      db.savePromptRevision({
        body: secondBody,
        key: "parent.system",
        source: "edit",
      });
    });

    const response = await app.request(
      postFormRequest("/prompts/parent.system/restore", {
        revision_id: String(firstRevisionId),
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Location")).toBe("/prompts/parent.system");
    expect(db.getPrompt("parent.system")?.body).toBe(firstBody);
  });

  test("POST restore /prompts/parent.system current revision redirects with already_current", async () => {
    let currentRevisionId = 0;
    const { app } = createAppWithDb((db) => {
      currentRevisionId = db.savePromptRevision({
        body: "Already current parent prompt body",
        key: "parent.system",
        source: "edit",
      }).revisionId;
    });

    const response = await app.request(
      postFormRequest("/prompts/parent.system/restore", {
        revision_id: String(currentRevisionId),
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Location")).toBe("/prompts/parent.system?already_current=1");
  });

  test("POST restore /prompts/parent.system child revision_id returns 404", async () => {
    let childRevisionId = 0;
    const { app, db } = createAppWithDb((db) => {
      childRevisionId = db.savePromptRevision({
        body: "Child prompt body owned by child key",
        key: "child.system",
        source: "edit",
      }).revisionId;
    });

    expect(db.getPromptRevision("parent.system", childRevisionId)).toBeNull();
    const response = await app.request(
      postFormRequest("/prompts/parent.system/restore", {
        revision_id: String(childRevisionId),
      }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("POST restore validation /prompts/parent.system invalid revision_id returns 400", async () => {
    const { app } = createAppWithDb();

    for (const revisionId of ["0", "-1", "1.5"]) {
      const response = await app.request(
        postFormRequest("/prompts/parent.system/restore", { revision_id: revisionId }),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("POST restore /prompts/parent.system non-existent revision_id returns 404", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(
      postFormRequest("/prompts/parent.system/restore", { revision_id: "99999" }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
