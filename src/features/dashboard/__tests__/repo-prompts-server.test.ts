import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "@/features/dashboard/server";
import { createDbModule } from "@/shared/persistence/db";

type DbModule = ReturnType<typeof createDbModule>;

const REPO_OWNER = "octocat";
const REPO_NAME = "spoon-knife";
const REPO_SLUG = `${REPO_OWNER}/${REPO_NAME}`;

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

describe("repo prompt routes", () => {
  test("GET /repos/:owner/:name renders prompt slots and falls back when no override exists", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(request(`/repos/${REPO_OWNER}/${REPO_NAME}`));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("<!doctype html>");
    expect(body).toContain(REPO_SLUG);
    expect(body).toContain(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent`);
    expect(body).toContain(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/child`);
  });

  test("GET /repos/:owner/:name/prompts/parent shows configure state when no override exists", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(request(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent`));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toContain(`action="/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent"`);
    // Global prompt body must be visible for context
    expect(body).toContain("parent.system");
  });

  test("GET /repos/:owner/:name/prompts/bogus returns 400", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(request(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/bogus`));

    expect(response.status).toBe(400);
  });

  test("POST /repos/:owner/:name/prompts/parent saves and redirects, persists body verbatim", async () => {
    const { app, db } = createAppWithDb();
    const promptBody = "Repo override parent body that is plenty long enough.";

    const response = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent`, { body: promptBody }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent`,
    );
    expect(db.getRepoPrompt(REPO_SLUG, "parent")?.body).toBe(promptBody);
  });

  test("POST identical body redirects with no_change=1", async () => {
    const { app } = createAppWithDb();
    const promptBody = "Repo override parent body that is plenty long enough.";

    await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent`, { body: promptBody }),
    );
    const second = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent`, { body: promptBody }),
    );

    expect(second.status).toBe(302);
    expect(second.headers.get("Location")).toBe(
      `/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent?no_change=1`,
    );
  });

  test("POST validation rejects empty/short bodies and unknown agents", async () => {
    const { app } = createAppWithDb();

    const empty = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent`, { body: "" }),
    );
    const tooShort = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent`, { body: "  short  " }),
    );
    const bogus = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/bogus`, {
        body: "Sufficiently long override body to pass length checks",
      }),
    );

    expect(empty.status).toBe(400);
    expect(tooShort.status).toBe(400);
    expect(bogus.status).toBe(400);
  });

  test("POST restore replays a prior revision and redirects", async () => {
    const { app, db } = createAppWithDb();
    const first = "First repo override revision body that is long enough.";
    const second = "Second repo override revision body that is long enough.";
    const firstRevisionId = db.saveRepoPromptRevision({
      agent: "parent",
      body: first,
      repo: REPO_SLUG,
      source: "edit",
    }).revisionId;
    db.saveRepoPromptRevision({
      agent: "parent",
      body: second,
      repo: REPO_SLUG,
      source: "edit",
    });

    const response = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent/restore`, {
        revision_id: String(firstRevisionId),
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent`,
    );
    expect(db.getRepoPrompt(REPO_SLUG, "parent")?.body).toBe(first);
  });

  test("POST restore non-existent revision returns 404", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent/restore`, {
        revision_id: "9999",
      }),
    );

    expect(response.status).toBe(404);
  });

  test("POST delete removes the override and redirects with removed=1", async () => {
    const { app, db } = createAppWithDb((db) => {
      db.saveRepoPromptRevision({
        agent: "parent",
        body: "Repo override body that is long enough.",
        repo: REPO_SLUG,
        source: "edit",
      });
    });

    const response = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent/delete`, {}),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent?removed=1`,
    );
    expect(db.getRepoPrompt(REPO_SLUG, "parent")).toBeNull();
  });

  test("GET /prompts lists repo overrides under the global table", async () => {
    const { app } = createAppWithDb((db) => {
      db.saveRepoPromptRevision({
        agent: "parent",
        body: "Repo override parent body for prompts list.",
        repo: REPO_SLUG,
        source: "edit",
      });
    });

    const response = await app.request(request("/prompts"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain(REPO_SLUG);
    expect(body).toContain(`/repos/${REPO_OWNER}/${REPO_NAME}/prompts/parent`);
  });
});
