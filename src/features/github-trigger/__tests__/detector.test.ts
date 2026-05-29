import { describe, expect, test } from "bun:test";

import {
  detectCommentTrigger,
  detectLabelTrigger,
  type IssueCommentLike,
  type IssueEventLike,
} from "@/features/github-trigger/detector";
import { dedupeKeyOf, parseGithubTriggerConfigFromEnv } from "@/features/github-trigger/schemas";

const REPO = "acme/widgets";
const ISSUE_URL = `https://api.github.com/repos/${REPO}/issues/42`;
const PR_HTML_URL = `https://github.com/${REPO}/pull/42#issuecomment-1`;
const ISSUE_HTML_URL = `https://github.com/${REPO}/issues/42#issuecomment-1`;

function makeComment(overrides: Partial<IssueCommentLike>): IssueCommentLike {
  return {
    body: "@bot run",
    html_url: ISSUE_HTML_URL,
    id: 100,
    issue_url: ISSUE_URL,
    ...overrides,
  };
}

function makeLabeledEvent(overrides: Partial<IssueEventLike>): IssueEventLike {
  return {
    created_at: "2026-04-30T12:00:00Z",
    event: "labeled",
    id: 200,
    issue: { number: 42, pull_request: undefined },
    label: { name: "agent-run" },
    ...overrides,
  };
}

describe("detectCommentTrigger", () => {
  test("matches a leading @bot run line", () => {
    const candidate = detectCommentTrigger(makeComment({}), { botMention: "bot" });
    expect(candidate).toEqual({
      issueNumber: 42,
      reason: "comment mentions @bot run",
      repo: REPO,
      source: "comment",
      sourceId: "100",
    });
  });

  test("is case-insensitive on the run keyword and bot name", () => {
    const candidate = detectCommentTrigger(makeComment({ body: "@BoT  RUN please" }), {
      botMention: "bot",
    });
    expect(candidate?.source).toBe("comment");
  });

  test("ignores comments that mention the bot but do not start with the run command", () => {
    const candidate = detectCommentTrigger(makeComment({ body: "Hey @bot run when ready" }), {
      botMention: "bot",
    });
    expect(candidate).toBeNull();
  });

  test("ignores PR comments based on html_url", () => {
    const candidate = detectCommentTrigger(makeComment({ html_url: PR_HTML_URL }), {
      botMention: "bot",
    });
    expect(candidate).toBeNull();
  });

  test("skips leading blank lines and matches the first non-empty line", () => {
    const candidate = detectCommentTrigger(makeComment({ body: "\n\n@bot run\nrest of message" }), {
      botMention: "bot",
    });
    expect(candidate?.source).toBe("comment");
  });

  test("rejects when the bot name does not match", () => {
    const candidate = detectCommentTrigger(makeComment({ body: "@otherbot run" }), {
      botMention: "bot",
    });
    expect(candidate).toBeNull();
  });

  test("rejects when the body is missing", () => {
    const candidate = detectCommentTrigger(makeComment({ body: null }), { botMention: "bot" });
    expect(candidate).toBeNull();
  });

  test("rejects when the issue_url is malformed", () => {
    const candidate = detectCommentTrigger(
      makeComment({ issue_url: "https://example.com/whatever" }),
      { botMention: "bot" },
    );
    expect(candidate).toBeNull();
  });

  test("supports configurable bot names with regex-special characters", () => {
    const candidate = detectCommentTrigger(makeComment({ body: "@a.weird-name run" }), {
      botMention: "a.weird-name",
    });
    expect(candidate?.source).toBe("comment");
  });
});

describe("detectLabelTrigger", () => {
  test("matches a labeled event whose label name equals the trigger label", () => {
    const candidate = detectLabelTrigger(makeLabeledEvent({}), { triggerLabel: "agent-run" }, REPO);
    expect(candidate).toEqual({
      issueNumber: 42,
      reason: 'label "agent-run" added',
      repo: REPO,
      source: "label",
      sourceId: "200",
    });
  });

  test("ignores events with a different action", () => {
    const candidate = detectLabelTrigger(
      makeLabeledEvent({ event: "unlabeled" }),
      { triggerLabel: "agent-run" },
      REPO,
    );
    expect(candidate).toBeNull();
  });

  test("ignores events with a different label name", () => {
    const candidate = detectLabelTrigger(
      makeLabeledEvent({ label: { name: "bug" } }),
      { triggerLabel: "agent-run" },
      REPO,
    );
    expect(candidate).toBeNull();
  });

  test("ignores PR-backed issues", () => {
    const candidate = detectLabelTrigger(
      makeLabeledEvent({ issue: { number: 42, pull_request: { url: "x" } } }),
      { triggerLabel: "agent-run" },
      REPO,
    );
    expect(candidate).toBeNull();
  });

  test("rejects events without an issue number", () => {
    const candidate = detectLabelTrigger(
      makeLabeledEvent({ issue: { number: null } }),
      { triggerLabel: "agent-run" },
      REPO,
    );
    expect(candidate).toBeNull();
  });
});

describe("dedupeKeyOf", () => {
  test("includes source, repo, and source id to keep keys globally unique", () => {
    const commentKey = dedupeKeyOf({
      issueNumber: 42,
      reason: "x",
      repo: REPO,
      source: "comment",
      sourceId: "100",
    });
    const labelKey = dedupeKeyOf({
      issueNumber: 42,
      reason: "x",
      repo: REPO,
      source: "label",
      sourceId: "100",
    });

    expect(commentKey).toBe(`comment:${REPO}:100`);
    expect(labelKey).toBe(`label:${REPO}:100`);
    expect(commentKey).not.toBe(labelKey);
  });
});

describe("parseGithubTriggerConfigFromEnv", () => {
  test("falls back to defaults when no overrides are present", () => {
    const config = parseGithubTriggerConfigFromEnv({});
    expect(config.botMention).toBe("bot");
    expect(config.triggerLabel).toBe("agent-run");
    expect(config.intervalMs).toBe(60_000);
  });

  test("converts seconds to milliseconds", () => {
    const config = parseGithubTriggerConfigFromEnv({
      GITHUB_TRIGGER_POLL_INTERVAL_SECONDS: "30",
    });
    expect(config.intervalMs).toBe(30_000);
  });

  test("rejects non-positive interval values", () => {
    expect(() =>
      parseGithubTriggerConfigFromEnv({ GITHUB_TRIGGER_POLL_INTERVAL_SECONDS: "0" }),
    ).toThrow();
  });

  test("honors custom bot mention and trigger label overrides", () => {
    const config = parseGithubTriggerConfigFromEnv({
      GITHUB_BOT_MENTION: "claude",
      GITHUB_TRIGGER_LABEL: "automate",
    });
    expect(config.botMention).toBe("claude");
    expect(config.triggerLabel).toBe("automate");
  });
});
