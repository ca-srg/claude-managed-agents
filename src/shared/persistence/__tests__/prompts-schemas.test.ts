import { describe, expect, it } from "bun:test";

import { EditablePromptKeySchema, PromptKeySchema, PromptSaveInputSchema } from "../schemas";

describe("prompt schemas", () => {
  describe("valid input", () => {
    it("accepts editable keys", () => {
      expect(EditablePromptKeySchema.parse("parent.system")).toBe("parent.system");
      expect(EditablePromptKeySchema.parse("child.system")).toBe("child.system");
    });

    it("accepts all 4 prompt keys", () => {
      for (const k of ["parent.system", "child.system", "parent.runtime", "child.runtime"]) {
        expect(PromptKeySchema.parse(k)).toBe(k);
      }
    });

    it("accepts valid body", () => {
      expect(PromptSaveInputSchema.parse({ body: "valid prompt body 10+ chars" })).toEqual({
        body: "valid prompt body 10+ chars",
      });
    });
  });

  describe("rejects invalid", () => {
    it("rejects unknown key", () => {
      expect(() => PromptKeySchema.parse("invalid.key")).toThrow();
    });

    it("rejects runtime in editable", () => {
      expect(() => EditablePromptKeySchema.parse("parent.runtime")).toThrow();
      expect(() => EditablePromptKeySchema.parse("child.runtime")).toThrow();
    });

    it("rejects empty body", () => {
      expect(() => PromptSaveInputSchema.parse({ body: "" })).toThrow();
    });

    it("rejects too-long body", () => {
      expect(() => PromptSaveInputSchema.parse({ body: "x".repeat(102401) })).toThrow();
    });

    it("rejects whitespace-only body", () => {
      expect(() => PromptSaveInputSchema.parse({ body: " ".repeat(15) })).toThrow();
    });
  });
});
