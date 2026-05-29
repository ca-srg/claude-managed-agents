import { describe, expect, it } from "bun:test";
import { type PromptListEntry, PromptsListPage } from "@/features/dashboard/pages/prompts-list";

const fixture: PromptListEntry[] = [
  {
    promptKey: "parent.system",
    editable: true,
    updatedAt: "2026-04-27T05:30:00Z",
    revisionCount: 3,
  },
  {
    promptKey: "child.system",
    editable: true,
    updatedAt: "2026-04-27T05:30:00Z",
    revisionCount: 2,
  },
  {
    promptKey: "parent.runtime",
    editable: false,
    updatedAt: "2026-04-27T05:30:00Z",
    revisionCount: 1,
  },
  {
    promptKey: "child.runtime",
    editable: false,
    updatedAt: "2026-04-27T05:30:00Z",
    revisionCount: 1,
  },
];

describe("PromptsListPage", () => {
  it("renders 4 prompt key rows", () => {
    const html = String(PromptsListPage({ prompts: fixture }));
    expect(html).toContain('data-prompt-key="parent.system"');
    expect(html).toContain('data-prompt-key="child.system"');
    expect(html).toContain('data-prompt-key="parent.runtime"');
    expect(html).toContain('data-prompt-key="child.runtime"');
  });

  it("marks system prompts editable and runtime read-only", () => {
    const html = String(PromptsListPage({ prompts: fixture }));
    // editable badge should appear at least 2 times (parent.system, child.system)
    const editableMatches = html.match(/prompt-badge[^"]*editable/g) ?? [];
    expect(editableMatches.length >= 2).toBe(true);
    const readonlyMatches = html.match(/prompt-badge[^"]*readonly/g) ?? [];
    expect(readonlyMatches.length >= 2).toBe(true);
  });

  it("provides detail link for each prompt", () => {
    const html = String(PromptsListPage({ prompts: fixture }));
    expect(html).toContain('href="/prompts/parent.system"');
    expect(html).toContain('href="/prompts/parent.runtime"');
  });

  it("uses Layout with activeNav=prompts", () => {
    const html = String(PromptsListPage({ prompts: fixture }));
    // The Prompts nav link should have 'text-brand-600' class
    expect(html).toMatch(/href="\/prompts"[^>]*class="[^"]*text-brand-600/);
  });

  it("renders empty state when no prompts", () => {
    const html = String(PromptsListPage({ prompts: [] }));
    expect(html).toContain("No prompts seeded yet");
  });
});
