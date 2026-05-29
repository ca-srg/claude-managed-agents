import { z } from "zod";

import { LINEAR_MCP_URL } from "@/shared/constants";

const NonEmptyStringSchema = z.string().min(1);
const PositiveIntegerSchema = z.number().int().positive();

export const RunOriginSchema = z.discriminatedUnion("type", [
  z
    .object({
      issueNumber: PositiveIntegerSchema,
      repo: NonEmptyStringSchema,
      title: NonEmptyStringSchema.optional(),
      type: z.literal("github_issue"),
      url: NonEmptyStringSchema.optional(),
    })
    .strict(),
  z
    .object({
      identifier: NonEmptyStringSchema,
      title: NonEmptyStringSchema.optional(),
      type: z.literal("linear_issue"),
      url: NonEmptyStringSchema.optional(),
    })
    .strict(),
]);

export type RunOrigin = z.infer<typeof RunOriginSchema>;
export type RunOriginType = RunOrigin["type"];

export type McpServerLike = {
  enabled: boolean;
  url: string;
};

export function githubIssueOrigin(input: {
  issueNumber: number;
  repo: string;
  title?: string | null;
  url?: string | null;
}): Extract<RunOrigin, { type: "github_issue" }> {
  return RunOriginSchema.parse({
    issueNumber: input.issueNumber,
    repo: input.repo,
    ...(input.title ? { title: input.title } : {}),
    type: "github_issue",
    url: input.url ?? `https://github.com/${input.repo}/issues/${input.issueNumber}`,
  }) as Extract<RunOrigin, { type: "github_issue" }>;
}

export function linearIssueOrigin(input: {
  identifier: string;
  title?: string | null;
  url?: string | null;
}): Extract<RunOrigin, { type: "linear_issue" }> {
  const identifier = input.identifier.trim();
  const url = input.url ?? (isHttpUrl(identifier) ? identifier : undefined);

  return RunOriginSchema.parse({
    identifier,
    ...(input.title ? { title: input.title } : {}),
    type: "linear_issue",
    ...(url ? { url } : {}),
  }) as Extract<RunOrigin, { type: "linear_issue" }>;
}

export function originDisplay(origin: RunOrigin): string {
  if (origin.type === "github_issue") {
    return `${origin.repo}#${origin.issueNumber}`;
  }

  return origin.identifier;
}

export function originShortDisplay(origin: RunOrigin): string {
  if (origin.type === "github_issue") {
    return `#${origin.issueNumber}`;
  }

  return origin.identifier;
}

export function originUrl(origin: RunOrigin): string | undefined {
  if (origin.url) {
    return origin.url;
  }

  if (origin.type === "github_issue") {
    return `https://github.com/${origin.repo}/issues/${origin.issueNumber}`;
  }

  return undefined;
}

export function originBranchSegment(origin: RunOrigin): string {
  if (origin.type === "github_issue") {
    return `issue-${origin.issueNumber}`;
  }

  return `linear-${slugSegment(origin.identifier)}`;
}

export function fallbackRunOrigin(input: {
  issueNumber: number | null;
  origin?: RunOrigin;
  repo: string;
}): RunOrigin | null {
  if (input.origin) {
    return input.origin;
  }

  if (input.issueNumber !== null) {
    return githubIssueOrigin({ issueNumber: input.issueNumber, repo: input.repo });
  }

  return null;
}

export function isEnabledLinearMcpServer(server: McpServerLike): boolean {
  return server.enabled && normalizeMcpUrl(server.url) === normalizeMcpUrl(LINEAR_MCP_URL);
}

export function hasEnabledLinearMcpServer(servers: readonly McpServerLike[]): boolean {
  return servers.some((server) => isEnabledLinearMcpServer(server));
}

function normalizeMcpUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function slugSegment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "issue";
}
