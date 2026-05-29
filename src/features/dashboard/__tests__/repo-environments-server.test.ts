import { afterEach, describe, expect, test } from "bun:test";
import { createApp } from "@/features/dashboard/server";
import { createDbModule } from "@/shared/persistence/db";
import type { RepoEnvironmentPackages } from "@/shared/persistence/schemas";

type DbModule = ReturnType<typeof createDbModule>;
type PackageManager = keyof RepoEnvironmentPackages;

const REPO_OWNER = "octocat";
const REPO_NAME = "spoon-knife";
const REPO_SLUG = `${REPO_OWNER}/${REPO_NAME}`;

const openDbs: DbModule[] = [];

function createAppWithDb(seed?: (db: DbModule) => void, beforeCreateApp?: (db: DbModule) => void) {
  const db = createDbModule(":memory:");
  openDbs.push(db);
  db.initDb();
  seed?.(db);
  beforeCreateApp?.(db);
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

function environmentFields(
  overrides: Partial<Record<PackageManager, string>> = {},
): Record<string, string> {
  return {
    apt: "",
    cargo: "",
    gem: "",
    go: "",
    npm: "",
    pip: "",
    ...overrides,
  };
}

function packages(overrides: Partial<RepoEnvironmentPackages> = {}): RepoEnvironmentPackages {
  return {
    apt: [],
    cargo: [],
    gem: [],
    go: [],
    npm: [],
    pip: [],
    ...overrides,
  };
}

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.close();
  }
});

describe("repo environment routes", () => {
  test("GET /repos/:owner/:name/environment shows empty configure state", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(request(`/repos/${REPO_OWNER}/${REPO_NAME}/environment`));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toContain("<!doctype html>");
    expect(body).toContain(REPO_SLUG);
    expect(body).toContain("not-configured");
  });

  test("GET /repos/:owner/:name/environment returns 404 for invalid repo slug", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(request(`/repos/${REPO_OWNER}/bad%20name/environment`));

    expect(response.status).toBe(404);
  });

  test("POST /repos/:owner/:name/environment creates a revision and redirects", async () => {
    const { app, db } = createAppWithDb();

    const response = await app.request(
      postFormRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/environment`,
        environmentFields({ apt: "vim", npm: "typescript" }),
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/repos/${REPO_OWNER}/${REPO_NAME}/environment`);
    expect(db.getRepoEnvironment(REPO_SLUG)?.packages).toEqual(
      packages({ apt: ["vim"], npm: ["typescript"] }),
    );
    expect(db.getRepoEnvironmentRevisions(REPO_SLUG)).toHaveLength(1);
  });

  test("POST /repos/:owner/:name/environment accepts all-empty package fields", async () => {
    const { app, db } = createAppWithDb();

    const response = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/environment`, environmentFields()),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/repos/${REPO_OWNER}/${REPO_NAME}/environment`);
    expect(db.getRepoEnvironment(REPO_SLUG)?.packages).toEqual(packages());
  });

  test("POST /repos/:owner/:name/environment rejects whitespace in package specs", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(
      postFormRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/environment`,
        environmentFields({ npm: "left pad" }),
      ),
    );

    expect(response.status).toBe(400);
  });

  test("POST identical packages redirects with no_change=1", async () => {
    const { app } = createAppWithDb();
    const fields = environmentFields({ apt: "vim", pip: "pytest" });

    await app.request(postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/environment`, fields));
    const second = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/environment`, fields),
    );

    expect(second.status).toBe(302);
    expect(second.headers.get("Location")).toBe(
      `/repos/${REPO_OWNER}/${REPO_NAME}/environment?no_change=1`,
    );
  });

  test("POST /repos/:owner/:name/environment normalizes newlines and comments", async () => {
    const savedPackages: RepoEnvironmentPackages[] = [];
    const { app } = createAppWithDb(undefined, (db) => {
      const saveRepoEnvironmentRevision = db.saveRepoEnvironmentRevision;
      const replacement: DbModule["saveRepoEnvironmentRevision"] = (input, opts) => {
        savedPackages.push(
          packages({
            apt: [...(input.packages.apt ?? [])],
            cargo: [...(input.packages.cargo ?? [])],
            gem: [...(input.packages.gem ?? [])],
            go: [...(input.packages.go ?? [])],
            npm: [...(input.packages.npm ?? [])],
            pip: [...(input.packages.pip ?? [])],
          }),
        );
        return saveRepoEnvironmentRevision(input, opts);
      };
      db.saveRepoEnvironmentRevision = replacement;
    });

    const response = await app.request(
      postFormRequest(
        `/repos/${REPO_OWNER}/${REPO_NAME}/environment`,
        environmentFields({ apt: "vim\r\ngit\n# comment\n\n" }),
      ),
    );

    expect(response.status).toBe(302);
    expect(savedPackages[0]?.apt).toEqual(["vim", "git"]);
  });

  test("POST restore replays a prior revision, creates a revision, and redirects", async () => {
    const { app, db } = createAppWithDb();
    const firstRevisionId = db.saveRepoEnvironmentRevision({
      packages: packages({ apt: ["vim"] }),
      repo: REPO_SLUG,
      source: "edit",
    }).revisionId;
    db.saveRepoEnvironmentRevision({
      packages: packages({ apt: ["git"] }),
      repo: REPO_SLUG,
      source: "edit",
    });

    const response = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/environment/restore`, {
        revision_id: String(firstRevisionId),
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/repos/${REPO_OWNER}/${REPO_NAME}/environment`);
    expect(db.getRepoEnvironment(REPO_SLUG)?.packages.apt).toEqual(["vim"]);
    expect(db.getRepoEnvironmentRevisions(REPO_SLUG)).toHaveLength(3);
    expect(db.getRepoEnvironmentRevisions(REPO_SLUG)[0]?.source).toBe("restore");
  });

  test("POST restore with unknown revision returns 404", async () => {
    const { app } = createAppWithDb();

    const response = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/environment/restore`, {
        revision_id: "9999",
      }),
    );

    expect(response.status).toBe(404);
  });

  test("POST delete removes the environment and redirects with removed=1", async () => {
    const { app, db } = createAppWithDb((db) => {
      db.saveRepoEnvironmentRevision({
        packages: packages({ apt: ["vim"] }),
        repo: REPO_SLUG,
        source: "edit",
      });
    });

    const response = await app.request(
      postFormRequest(`/repos/${REPO_OWNER}/${REPO_NAME}/environment/delete`, {}),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      `/repos/${REPO_OWNER}/${REPO_NAME}/environment?removed=1`,
    );
    expect(db.getRepoEnvironment(REPO_SLUG)).toBeNull();
  });

  test("GET /repos/:owner/:name passes repoEnvironmentSummary data", async () => {
    const environmentCalls: string[] = [];
    const revisionCalls: string[] = [];
    const { app } = createAppWithDb(
      (db) => {
        db.saveRepoEnvironmentRevision({
          packages: packages({ apt: ["vim"], npm: ["typescript", "tsx"] }),
          repo: REPO_SLUG,
          source: "edit",
        });
      },
      (db) => {
        const getRepoEnvironment = db.getRepoEnvironment;
        const getRepoEnvironmentRevisions = db.getRepoEnvironmentRevisions;
        db.getRepoEnvironment = ((repo: string) => {
          environmentCalls.push(repo);
          return getRepoEnvironment(repo);
        }) as DbModule["getRepoEnvironment"];
        db.getRepoEnvironmentRevisions = ((repo: string) => {
          revisionCalls.push(repo);
          return getRepoEnvironmentRevisions(repo);
        }) as DbModule["getRepoEnvironmentRevisions"];
      },
    );

    const response = await app.request(request(`/repos/${REPO_OWNER}/${REPO_NAME}`));

    expect(response.status).toBe(200);
    expect(environmentCalls).toEqual([REPO_SLUG]);
    expect(revisionCalls).toEqual([REPO_SLUG]);
  });
});
