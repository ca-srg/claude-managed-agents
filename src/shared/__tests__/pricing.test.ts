import { describe, expect, test } from "bun:test";

import { calculateCostUsd, getModelPricing, isKnownModel } from "../pricing";

describe("Claude Fable 5 pricing", () => {
  test("includes official per-million-token pricing", () => {
    expect(getModelPricing("claude-fable-5")).toEqual({
      input: 10,
      cacheWrite5m: 12.5,
      cacheWrite1h: 20,
      cacheRead: 1,
      output: 50,
    });
    expect(isKnownModel("claude-fable-5")).toBe(true);
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
        "claude-fable-5",
      ),
    ).toBe(73.5);
  });
});
