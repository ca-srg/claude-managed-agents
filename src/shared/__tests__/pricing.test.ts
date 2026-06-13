import { describe, expect, test } from "bun:test";

import { calculateCostUsd, getModelPricing, isKnownModel } from "../pricing";

describe("Claude Opus 4.8 pricing", () => {
  test("includes official per-million-token pricing", () => {
    expect(getModelPricing("claude-opus-4-8")).toEqual({
      input: 5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
      cacheRead: 0.5,
      output: 25,
    });
    expect(isKnownModel("claude-opus-4-8")).toBe(true);
  });

  test("calculates cost using the 5-minute cache-write rate", () => {
    expect(
      calculateCostUsd(
        {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheCreationInputTokens: 1_000_000,
          cacheReadInputTokens: 1_000_000,
        },
        "claude-opus-4-8",
      ),
    ).toBe(36.75);
  });
});
