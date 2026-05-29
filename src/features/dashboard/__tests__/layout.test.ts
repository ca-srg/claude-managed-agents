import { describe, expect, it } from "bun:test";
import { Layout } from "@/features/dashboard/components/layout";

function renderToString(jsx: unknown): string {
  return String(jsx);
}

describe("Layout", () => {
  it("renders Prompts nav link", () => {
    const html = renderToString(Layout({ title: "Test", children: "x" }));
    expect(html).toContain('href="/prompts"');
    expect(html).toContain(">Prompts</a>");
  });

  it("marks prompts as active when activeNav=prompts", () => {
    const html = renderToString(Layout({ title: "Test", children: "x", activeNav: "prompts" }));
    expect(html).toMatch(/href="\/prompts"[^>]*class="[^"]*text-brand-600/);
  });

  it("default footer is no-JS variant", () => {
    const html = renderToString(Layout({ title: "Test", children: "x" }));
    expect(html).toContain("SSR · no JS · built with Hono + bun:sqlite");
    expect(html).not.toContain("progressive enhancement");
  });

  it("enhanced=true changes footer to progressive enhancement variant", () => {
    const html = renderToString(Layout({ title: "Test", children: "x", enhanced: true }));
    expect(html).toContain("SSR + progressive enhancement · built with Hono + bun:sqlite");
    expect(html).not.toContain("· no JS ·");
  });

  it("repos link still works (existing behavior)", () => {
    const html = renderToString(Layout({ title: "Test", children: "x", activeNav: "repos" }));
    expect(html).toContain('href="/repositories"');
    expect(html).toMatch(/href="\/repositories"[^>]*class="[^"]*text-brand-600/);
  });

  it("renders Runs nav link", () => {
    const html = renderToString(Layout({ title: "Test", children: "x" }));
    expect(html).toContain('href="/runs"');
    expect(html).toContain(">Runs</a>");
  });

  it("renders New Run nav link", () => {
    const html = renderToString(Layout({ title: "Test", children: "x" }));
    expect(html).toContain('href="/runs/new"');
    expect(html).toContain(">New Run</a>");
  });
});
