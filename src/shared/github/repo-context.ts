import { Buffer } from "node:buffer";

import type { Octokit } from "octokit";
import type { Logger } from "pino";

export type RepoContextFile = { path: string; content: string };
export type RepoContext = { files: RepoContextFile[] };

const ROOT_CONTEXT_PATHS = ["CLAUDE.md", "AGENTS.md"] as const;
const RULES_DIRECTORY_PATH = ".claude/rules";
// Maximum byte size for a repository context file. The GitHub contents API
// switches from base64-encoded inline content to `encoding: "none"` (raw
// fallback required) for files larger than ~1 MB, so this cap is set above
// that threshold to actually exercise the raw fallback for 1–2 MiB files.
// Files exceeding the cap are skipped with a warning rather than injected
// into the parent prompt, since formatRepoContext does not truncate content
// and downstream models have finite context windows.
const MAX_REPO_CONTEXT_FILE_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.status === 404;
}

function decodeBase64Content(content: string): string {
  return Buffer.from(content, "base64").toString("utf8");
}

async function fetchRawContextContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      mediaType: { format: "raw" },
      owner,
      path,
      ref,
      repo,
    });

    if (typeof response.data !== "string") {
      logger.warn(
        { path, ref, repo: `${owner}/${repo}` },
        "raw repository context response was not a string; skipping",
      );
      return null;
    }

    const size = Buffer.byteLength(response.data, "utf8");
    if (size > MAX_REPO_CONTEXT_FILE_BYTES) {
      logger.warn(
        { limit: MAX_REPO_CONTEXT_FILE_BYTES, path, ref, repo: `${owner}/${repo}`, size },
        "raw repository context file exceeds size limit; skipping",
      );
      return null;
    }

    return response.data;
  } catch (err) {
    logger.warn(
      { err, path, ref, repo: `${owner}/${repo}` },
      "failed to load repository context file as raw; skipping",
    );
    return null;
  }
}

async function fetchContextFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  logger: Logger,
): Promise<RepoContextFile | null> {
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      path,
      ref,
      repo,
    });
    const data = response.data;

    if (!isRecord(data) || data.type !== "file") {
      return null;
    }

    // Files up to ~1 MB come back base64-encoded inline.
    if (data.encoding === "base64" && typeof data.content === "string") {
      return {
        content: decodeBase64Content(data.content),
        path,
      };
    }

    // Files between 1 MB and 100 MB come back as `encoding: "none"` with an empty
    // `content` field. Re-fetch them with the raw media type so a large CLAUDE.md
    // or AGENTS.md is not silently dropped from the parent prompt.
    if (data.encoding === "none") {
      // Short-circuit using the metadata-reported `size` to avoid downloading
      // and materializing very large bodies into memory only to discard them
      // at the raw response check below.
      if (typeof data.size === "number" && data.size > MAX_REPO_CONTEXT_FILE_BYTES) {
        logger.warn(
          {
            limit: MAX_REPO_CONTEXT_FILE_BYTES,
            path,
            ref,
            repo: `${owner}/${repo}`,
            size: data.size,
          },
          "repository context file metadata exceeds size limit; skipping",
        );
        return null;
      }

      const rawContent = await fetchRawContextContent(octokit, owner, repo, path, ref, logger);
      if (rawContent === null) {
        return null;
      }

      return { content: rawContent, path };
    }

    logger.warn(
      { encoding: data.encoding, path, ref, repo: `${owner}/${repo}` },
      "repository context file has unexpected encoding; skipping",
    );
    return null;
  } catch (err) {
    if (isNotFoundError(err)) {
      return null;
    }

    logger.warn(
      { err, path, ref, repo: `${owner}/${repo}` },
      "failed to load repository context file; skipping",
    );
    return null;
  }
}

async function loadRuleFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  logger: Logger,
): Promise<RepoContextFile[]> {
  try {
    const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      path: RULES_DIRECTORY_PATH,
      ref,
      repo,
    });
    const data = response.data;

    if (!Array.isArray(data)) {
      return [];
    }

    const markdownRulePaths = data
      .flatMap((entry): string[] => {
        if (
          !isRecord(entry) ||
          entry.type !== "file" ||
          typeof entry.name !== "string" ||
          !entry.name.endsWith(".md") ||
          typeof entry.path !== "string"
        ) {
          return [];
        }

        return [entry.path];
      })
      .sort((left, right) => left.localeCompare(right));

    const files = await Promise.all(
      markdownRulePaths.map((path) => fetchContextFile(octokit, owner, repo, path, ref, logger)),
    );

    return files.filter((file): file is RepoContextFile => file !== null);
  } catch (err) {
    if (isNotFoundError(err)) {
      return [];
    }

    logger.warn(
      { err, path: RULES_DIRECTORY_PATH, ref, repo: `${owner}/${repo}` },
      "failed to list repository context rules; skipping",
    );
    return [];
  }
}

export async function loadRepoContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  logger: Logger,
): Promise<RepoContext> {
  const [claudeFile, agentsFile, ruleFiles] = await Promise.all([
    fetchContextFile(octokit, owner, repo, ROOT_CONTEXT_PATHS[0], ref, logger),
    fetchContextFile(octokit, owner, repo, ROOT_CONTEXT_PATHS[1], ref, logger),
    loadRuleFiles(octokit, owner, repo, ref, logger),
  ]);

  return {
    files: [claudeFile, agentsFile, ...ruleFiles].filter(
      (file): file is RepoContextFile => file !== null,
    ),
  };
}

export function formatRepoContext(context: RepoContext, baseBranch: string): string | null {
  if (context.files.length === 0) {
    return null;
  }

  const intro = `## Repository-level context

The following content is loaded from base branch \`${baseBranch}\`. These instructions apply to the entire run. When delegating tasks to the implementer agent, you MUST include the relevant parts of this context in your task message so the implementer follows the project's rules.`;

  const fileSections = context.files.map((file) => `### ${file.path}\n\n${file.content.trim()}`);

  return [intro, ...fileSections].join("\n\n");
}
