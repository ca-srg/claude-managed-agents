/**
 * Per-model pricing for token usage cost calculation.
 *
 * The Anthropic Managed Agents Beta API does not return per-request cost.
 * Instead it returns token counts via `span.model_request_end.model_usage`
 * (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
 * `cache_read_input_tokens`). We compute USD cost client-side using the
 * official pricing tables.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 *
 * Note: `span.model_request_end` does not split cache-creation tokens into
 * 5-minute vs 1-hour TTL buckets. We compute cache-write cost using the
 * 5-minute rate, which is the default TTL for `cache_control` ephemeral
 * blocks. This may slightly under-estimate cost in deployments that opt into
 * 1-hour caching, but matches the most common usage.
 */

/** USD price for 1M tokens, broken down by token category. */
export type ModelPricingPerMillionTokens = {
  /** Uncached input tokens. */
  input: number;
  /** Cache-write tokens (5-minute TTL, default ephemeral cache). */
  cacheWrite5m: number;
  /** Cache-write tokens (1-hour TTL). */
  cacheWrite1h: number;
  /** Cache-read (cache hit) tokens. */
  cacheRead: number;
  /** Output tokens. */
  output: number;
};

/**
 * Token counts collected from `span.model_request_end.model_usage`.
 * Always non-negative integers. Zero values are valid (a session that never
 * reaches model inference yields all-zero usage).
 */
export type SessionUsageTokens = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

/**
 * Pricing as of 2026-06 per the Anthropic public pricing page. Keep in sync
 * when models or prices change. Unknown models fall back to zero cost.
 */
export const MODEL_PRICING_USD_PER_MTOK: Readonly<Record<string, ModelPricingPerMillionTokens>> =
  Object.freeze({
    // Claude Opus 4.8 / 4.7 / 4.6 / 4.5 — current Opus tier.
    "claude-opus-4-8": {
      input: 5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
      cacheRead: 0.5,
      output: 25,
    },
    "claude-opus-4-7": {
      input: 5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
      cacheRead: 0.5,
      output: 25,
    },
    "claude-opus-4-6": {
      input: 5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
      cacheRead: 0.5,
      output: 25,
    },
    "claude-opus-4-5": {
      input: 5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
      cacheRead: 0.5,
      output: 25,
    },
    // Claude Opus 4.1 / 4 — legacy Opus tier (significantly more expensive).
    "claude-opus-4-1": {
      input: 15,
      cacheWrite5m: 18.75,
      cacheWrite1h: 30,
      cacheRead: 1.5,
      output: 75,
    },
    "claude-opus-4": {
      input: 15,
      cacheWrite5m: 18.75,
      cacheWrite1h: 30,
      cacheRead: 1.5,
      output: 75,
    },
    // Claude Sonnet 4.6 / 4.5 / 4 — current Sonnet tier.
    "claude-sonnet-4-6": {
      input: 3,
      cacheWrite5m: 3.75,
      cacheWrite1h: 6,
      cacheRead: 0.3,
      output: 15,
    },
    "claude-sonnet-4-5": {
      input: 3,
      cacheWrite5m: 3.75,
      cacheWrite1h: 6,
      cacheRead: 0.3,
      output: 15,
    },
    "claude-sonnet-4": {
      input: 3,
      cacheWrite5m: 3.75,
      cacheWrite1h: 6,
      cacheRead: 0.3,
      output: 15,
    },
    // Claude Haiku 4.5 — current Haiku tier.
    "claude-haiku-4-5": {
      input: 1,
      cacheWrite5m: 1.25,
      cacheWrite1h: 2,
      cacheRead: 0.1,
      output: 5,
    },
    // Historical Claude Fable 5 pricing retained for previously recorded sessions only.
    "claude-fable-5": {
      input: 10,
      cacheWrite5m: 12.5,
      cacheWrite1h: 20,
      cacheRead: 1,
      output: 50,
    },
    // Legacy Haiku 3.x — included for completeness; rarely used in this app.
    "claude-haiku-3-5": {
      input: 0.8,
      cacheWrite5m: 1,
      cacheWrite1h: 1.6,
      cacheRead: 0.08,
      output: 4,
    },
    "claude-haiku-3": {
      input: 0.25,
      cacheWrite5m: 0.3,
      cacheWrite1h: 0.5,
      cacheRead: 0.03,
      output: 1.25,
    },
  });

const TOKENS_PER_MILLION = 1_000_000;

/**
 * Returns the per-million-token pricing for a model, or `null` if the model
 * is not in the pricing table.
 */
export function getModelPricing(model: string): ModelPricingPerMillionTokens | null {
  if (!Object.hasOwn(MODEL_PRICING_USD_PER_MTOK, model)) {
    return null;
  }

  const pricing = MODEL_PRICING_USD_PER_MTOK[model];
  return pricing ?? null;
}

/** Whether the given model has a known pricing entry. */
export function isKnownModel(model: string): boolean {
  return Object.hasOwn(MODEL_PRICING_USD_PER_MTOK, model);
}

/**
 * Compute the USD cost of one session's accumulated token usage.
 *
 * Returns 0 when the model is unknown (caller is responsible for logging the
 * miss; we don't throw because pricing-table drift should not break orchestration).
 *
 * Cache-creation tokens are billed at the 5-minute-TTL rate; see the module
 * docstring for the rationale.
 */
export function calculateCostUsd(usage: SessionUsageTokens, model: string): number {
  const pricing = getModelPricing(model);
  if (pricing === null) {
    return 0;
  }

  const inputCost = (usage.inputTokens * pricing.input) / TOKENS_PER_MILLION;
  const cacheWriteCost =
    (usage.cacheCreationInputTokens * pricing.cacheWrite5m) / TOKENS_PER_MILLION;
  const cacheReadCost = (usage.cacheReadInputTokens * pricing.cacheRead) / TOKENS_PER_MILLION;
  const outputCost = (usage.outputTokens * pricing.output) / TOKENS_PER_MILLION;

  return inputCost + cacheWriteCost + cacheReadCost + outputCost;
}

/**
 * Format a USD amount with adaptive precision so very small amounts remain
 * readable on the dashboard.
 */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) {
    return "$0.00";
  }

  if (amount === 0) {
    return "$0.00";
  }

  if (amount >= 100) {
    return `$${amount.toFixed(2)}`;
  }

  if (amount >= 1) {
    return `$${amount.toFixed(3)}`;
  }

  if (amount >= 0.01) {
    return `$${amount.toFixed(4)}`;
  }

  return `$${amount.toFixed(6)}`;
}

/**
 * Format a token count with K/M suffixes to keep table cells compact.
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) {
    return "0";
  }

  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(2)}M`;
  }

  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }

  return String(Math.round(count));
}

/**
 * Sum up a session's billable token volume (input + cache writes + cache reads
 * + output). Useful for compact "X tokens" displays on the dashboard.
 */
export function totalTokenVolume(usage: SessionUsageTokens): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens
  );
}
