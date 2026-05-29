import { describe, expect, it } from "bun:test";
import { PromptDetailPage } from "../pages/prompt-detail";

describe("PromptDetailPage", () => {
  it("renders editable form with history and diff", async () => {
    const html = String(
      await PromptDetailPage({
        promptKey: "parent.system",
        body: "editable body",
        editable: true,
        revisions: [
          { id: 1, body: "v1", createdAt: "2026-04-27T05:00:00Z", source: "seed" },
          { id: 2, body: "v2", createdAt: "2026-04-27T05:30:00Z", source: "edit" },
        ],
        currentRevisionId: 2,
        prevRevision: { id: 1, body: "v1", createdAt: "2026-04-27T05:00:00Z", source: "seed" },
      }),
    );

    expect(html).toContain('action="/prompts/parent.system"');
    expect(html).toMatch(/class="prompt-form\b[^"]*"/);
    expect(html).toContain('type="submit"');
    expect(html).toContain("Save");

    expect(html).toMatch(/class="prompt-history-list\b[^"]*"/);
    expect(html).toContain("#1");
    expect(html).toContain("#2");

    expect(html).toMatch(/class="prompt-badge editable\b[^"]*"/);
    expect(html).toContain("current");

    expect(html).toContain('action="/prompts/parent.system/restore"');
    expect(html).toContain('value="1"');
    expect(html).toContain("restore");

    expect(html).toMatch(/class="diff-viewer\b[^"]*"/);
    expect(html).toContain("diff (vs previous revision)");

    expect(html).toContain("SSR + progressive enhancement");
  });

  it("renders read-only view without form", async () => {
    const html = String(
      await PromptDetailPage({
        promptKey: "parent.runtime",
        body: "runtime template body",
        editable: false,
        revisions: [],
        currentRevisionId: null,
      }),
    );

    expect(html).not.toMatch(/class="prompt-form\b[^"]*"/);
    expect(html).not.toContain('action="/prompts/parent.runtime"');

    expect(html).toMatch(/class="prompt-readonly-banner\b[^"]*"/);
    expect(html).toContain("This is a hardcoded runtime template. Read-only in MVP.");

    expect(html).toMatch(/class="prompt-readonly\b[^"]*"/);
    expect(html).toContain("runtime template body");

    expect(html).toContain("SSR · no JS");
  });

  it("renders no_change notice", async () => {
    const html = String(
      await PromptDetailPage({
        promptKey: "parent.system",
        body: "editable body",
        editable: true,
        revisions: [{ id: 1, body: "v1", createdAt: "2026-04-27T05:00:00Z", source: "seed" }],
        currentRevisionId: 1,
        noChangeNotice: { kind: "no_change" },
      }),
    );

    expect(html).toMatch(/class="prompt-no-changes-banner\b[^"]*"/);
    expect(html).toContain("Saved with same content — no new revision created.");
  });

  it("renders already_current notice", async () => {
    const html = String(
      await PromptDetailPage({
        promptKey: "parent.system",
        body: "editable body",
        editable: true,
        revisions: [{ id: 1, body: "v1", createdAt: "2026-04-27T05:00:00Z", source: "seed" }],
        currentRevisionId: 1,
        noChangeNotice: { kind: "already_current" },
      }),
    );

    expect(html).toMatch(/class="prompt-no-changes-banner\b[^"]*"/);
    expect(html).toContain("Already at this revision — restore had no effect.");
  });
});
