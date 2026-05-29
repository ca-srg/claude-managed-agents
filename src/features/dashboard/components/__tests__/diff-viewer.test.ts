import { describe, expect, it, test } from "bun:test";
import { computeUnifiedDiff } from "@/features/dashboard/components/diff-viewer";

describe("computeUnifiedDiff", () => {
  it("returns all-context for identical inputs", () => {
    const result = computeUnifiedDiff("a\nb\nc", "a\nb\nc");
    expect(result.every((line) => line.type === "context")).toBe(true);
    expect(result.length).toBe(3);
  });

  it("returns all-remove + all-add for completely different inputs", () => {
    const result = computeUnifiedDiff("a\nb", "x\ny");
    const removes = result.filter((line) => line.type === "remove");
    const adds = result.filter((line) => line.type === "add");
    expect(removes.length).toBe(2);
    expect(adds.length).toBe(2);
  });

  it("handles single line change", () => {
    const result = computeUnifiedDiff("a\nb\nc", "a\nB\nc");
    expect(result.length).toBe(4);
    expect(result[0]).toEqual({ type: "context", oldLineNo: 1, newLineNo: 1, content: "a" });
    expect(result[1]).toEqual({ type: "remove", oldLineNo: 2, newLineNo: null, content: "b" });
    expect(result[2]).toEqual({ type: "add", oldLineNo: null, newLineNo: 2, content: "B" });
    expect(result[3]).toEqual({ type: "context", oldLineNo: 3, newLineNo: 3, content: "c" });
  });

  it("handles single line addition", () => {
    const result = computeUnifiedDiff("a\nc", "a\nb\nc");
    expect(result.filter((line) => line.type === "add").length).toBe(1);
    expect(result.filter((line) => line.type === "remove").length).toBe(0);
    expect(result.filter((line) => line.type === "context").length).toBe(2);
  });

  it("handles single line deletion", () => {
    const result = computeUnifiedDiff("a\nb\nc", "a\nc");
    expect(result.filter((line) => line.type === "remove").length).toBe(1);
    expect(result.filter((line) => line.type === "add").length).toBe(0);
    expect(result.filter((line) => line.type === "context").length).toBe(2);
  });

  it("handles empty inputs", () => {
    expect(computeUnifiedDiff("", "")).toEqual([]);
    const result = computeUnifiedDiff("", "a");
    expect(result).toEqual([{ type: "add", oldLineNo: null, newLineNo: 1, content: "a" }]);
  });

  it("handles newline-only inputs", () => {
    const result = computeUnifiedDiff("\n", "\n");
    expect(result.length > 0).toBe(true);
  });

  test("100KB performance under 1 second", () => {
    const lines = 5000;
    const old = Array.from({ length: lines }, (_, index) => `line ${index}`).join("\n");
    const next = Array.from({ length: lines }, (_, index) =>
      index % 100 === 0 ? `LINE ${index}` : `line ${index}`,
    ).join("\n");
    const t0 = performance.now();
    const result = computeUnifiedDiff(old, next);
    const elapsed = performance.now() - t0;
    expect(elapsed < 1000).toBe(true);
    expect(result.length > 0).toBe(true);
  });
});
