import { describe, expect, it } from "bun:test";
import { PromptEditor } from "@/features/dashboard/components/prompt-editor";

describe("PromptEditor", () => {
  it("renders read-only as <pre> for editable=false", () => {
    const html = String(PromptEditor({ body: "hello world", editable: false }));
    expect(html).toMatch(/<pre[^>]*class="prompt-readonly\b[^"]*"/);
    expect(html).toContain("hello world");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<script");
  });

  it("renders <textarea> for editable=true", () => {
    const html = String(PromptEditor({ body: "abc 12345 67890", editable: true }));
    expect(html).toContain('<textarea name="body"');
    expect(html).toMatch(/class="prompt-editor-fallback-textarea\b[^"]*"/);
    expect(html).toContain("required");
    expect(html).toContain('minlength="10"');
    expect(html).toContain('maxlength="102400"');
    expect(html).toContain('aria-label="prompt body"');
    expect(html).not.toContain("<noscript>");
    expect(html).toContain("abc 12345 67890");
  });

  it("renders CodeMirror boot script with version-pinned URL", () => {
    const html = String(PromptEditor({ body: "abc 12345 67890", editable: true }));
    expect(html).toContain("https://esm.sh/codemirror@6.0.1?bundle");
    expect(html).toContain("try {");
    expect(html).toContain("catch");
    expect(html).toContain("textarea.value = editor.state.doc.toString();");
  });

  it("wraps editor in [data-prompt-editor] div", () => {
    const html = String(PromptEditor({ body: "abc 12345 67890", editable: true }));
    expect(html).toContain("data-prompt-editor");
    expect(html).toContain("prompt-editor-wrapper");
  });

  it("escapes HTML in body content", () => {
    const html = String(PromptEditor({ body: "<script>alert(1)</script>", editable: true }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
