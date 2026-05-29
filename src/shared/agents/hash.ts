import { createHash } from "node:crypto";

import type { AgentCreateParams } from "@anthropic-ai/sdk/resources/beta/agents/agents";

const NON_DETERMINISTIC_KEYS = new Set([
  "archived_at",
  "created_at",
  "request_id",
  "run_id",
  "session_id",
  "timestamp",
  "trace_id",
  "updated_at",
  "uuid",
]);

function canonicalizeDefinition(jsonNode: unknown): unknown {
  if (Array.isArray(jsonNode)) {
    return jsonNode.map((arrayEntry) => canonicalizeDefinition(arrayEntry));
  }

  if (jsonNode && typeof jsonNode === "object") {
    const recordNode = jsonNode as Record<string, unknown>;
    const sortedEntries = Object.keys(recordNode)
      .filter(
        (entryKey) =>
          !NON_DETERMINISTIC_KEYS.has(entryKey) && typeof recordNode[entryKey] !== "undefined",
      )
      .sort()
      .map((entryKey) => [entryKey, canonicalizeDefinition(recordNode[entryKey])] as const);

    return Object.fromEntries(sortedEntries);
  }

  return jsonNode;
}

export function hashDefinition(definition: AgentCreateParams): string {
  const canonicalDefinition = canonicalizeDefinition(definition);

  return createHash("sha256").update(JSON.stringify(canonicalDefinition)).digest("hex");
}
