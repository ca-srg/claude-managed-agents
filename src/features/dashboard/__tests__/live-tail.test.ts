import { describe, expect, test } from "bun:test";
import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
  EventListParams,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";

import { createLiveTailStream, type LiveTailPayload } from "@/features/dashboard/live-tail";
import type { SessionClient } from "@/shared/session";

const PROCESSED_AT = "2026-04-27T00:00:00.000Z";
const SHORT_HEARTBEAT_INTERVAL_MS = 50_000;

type ScriptInstruction<TEvent> = TEvent | { error: Error; kind: "throw" };

type FakeLiveTailScript = {
  listScript: ReadonlyArray<ScriptInstruction<BetaManagedAgentsSessionEvent>>;
  streamScript: ReadonlyArray<ScriptInstruction<BetaManagedAgentsStreamSessionEvents>>;
};

type FakeLiveTailCalls = {
  listCalls: Array<{ params?: EventListParams; sessionId: string }>;
  sendCalls: Array<{ params: EventSendParams; sessionId: string }>;
  streamCalls: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isThrowInstruction<TEvent>(
  instruction: ScriptInstruction<TEvent>,
): instruction is { error: Error; kind: "throw" } {
  return (
    isRecord(instruction) && instruction.kind === "throw" && instruction.error instanceof Error
  );
}

function createScriptIterable<TEvent>(
  instructions: ReadonlyArray<ScriptInstruction<TEvent>>,
): AsyncIterable<TEvent> {
  return {
    [Symbol.asyncIterator]() {
      let instructionIndex = 0;

      return {
        async next(): Promise<IteratorResult<TEvent>> {
          if (instructionIndex >= instructions.length) {
            return { done: true, value: undefined };
          }

          const currentInstruction = instructions[instructionIndex];
          instructionIndex += 1;

          if (typeof currentInstruction === "undefined") {
            return { done: true, value: undefined };
          }

          if (isThrowInstruction(currentInstruction)) {
            throw currentInstruction.error;
          }

          return { done: false, value: currentInstruction };
        },
        async return(): Promise<IteratorResult<TEvent>> {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function createFakeLiveTailClient(script: FakeLiveTailScript): {
  calls: FakeLiveTailCalls;
  client: SessionClient;
} {
  const calls: FakeLiveTailCalls = {
    listCalls: [],
    sendCalls: [],
    streamCalls: [],
  };

  const client: SessionClient = {
    beta: {
      sessions: {
        events: {
          list(sessionId, params) {
            calls.listCalls.push({ params, sessionId });
            return createScriptIterable(script.listScript);
          },
          async send(sessionId, params) {
            calls.sendCalls.push({ params, sessionId });
            return { ok: true };
          },
          async stream(sessionId) {
            calls.streamCalls.push(sessionId);
            return createScriptIterable(script.streamScript);
          },
        },
      },
    },
  };

  return { calls, client };
}

function createIdleEvent(
  id: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.status_idle" }> {
  return {
    id,
    processed_at: PROCESSED_AT,
    stop_reason: { type: "end_turn" },
    type: "session.status_idle",
  };
}

function createRunningEvent(
  id: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.status_running" }> {
  return {
    id,
    processed_at: PROCESSED_AT,
    type: "session.status_running",
  };
}

function createAgentMessageEvent(
  id: string,
  text: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "agent.message" }> {
  return {
    content: [{ text, type: "text" }],
    id,
    processed_at: PROCESSED_AT,
    type: "agent.message",
  };
}

async function readStreamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const collectedChunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      collectedChunks.push(decoder.decode(value, { stream: true }));
    }
  }

  collectedChunks.push(decoder.decode());
  return collectedChunks.join("");
}

function parseSseDataLines(text: string): LiveTailPayload[] {
  const payloads: LiveTailPayload[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const jsonText = line.slice("data: ".length);
    payloads.push(JSON.parse(jsonText) as LiveTailPayload);
  }
  return payloads;
}

describe("createLiveTailStream", () => {
  test("emits history phase first, then live phase, ending with idle", async () => {
    const { calls, client } = createFakeLiveTailClient({
      listScript: [createRunningEvent("evt-h-1"), createAgentMessageEvent("evt-h-2", "hi")],
      streamScript: [createAgentMessageEvent("evt-l-1", "live"), createIdleEvent("evt-idle")],
    });
    const abortController = new AbortController();
    const stream = createLiveTailStream({
      client,
      heartbeatIntervalMs: SHORT_HEARTBEAT_INTERVAL_MS,
      sessionId: "sesn-1",
      signal: abortController.signal,
    });

    const text = await readStreamToText(stream);
    const payloads = parseSseDataLines(text);

    expect(calls.listCalls).toHaveLength(1);
    expect(calls.listCalls[0]?.params?.order).toBe("asc");
    expect(calls.streamCalls).toEqual(["sesn-1"]);

    const phases = payloads.map((payload) => payload.phase);
    expect(phases).toEqual(["history", "history", "live", "live", "end"]);

    const lastPayload = payloads[payloads.length - 1];
    if (!lastPayload || lastPayload.phase !== "end") {
      throw new Error("Expected final end payload");
    }
    expect(lastPayload.reason).toBe("idle");
  });

  test("dedupes events that already appeared in history when stream replays them", async () => {
    const { client } = createFakeLiveTailClient({
      listScript: [createAgentMessageEvent("evt-shared", "shared")],
      streamScript: [
        createAgentMessageEvent("evt-shared", "shared"),
        createAgentMessageEvent("evt-fresh", "fresh"),
        createIdleEvent("evt-idle"),
      ],
    });
    const abortController = new AbortController();
    const stream = createLiveTailStream({
      client,
      heartbeatIntervalMs: SHORT_HEARTBEAT_INTERVAL_MS,
      sessionId: "sesn-2",
      signal: abortController.signal,
    });

    const payloads = parseSseDataLines(await readStreamToText(stream));

    const liveEventIds = payloads
      .filter(
        (payload): payload is Extract<LiveTailPayload, { phase: "live" }> =>
          payload.phase === "live",
      )
      .map((payload) => payload.event.id);
    expect(liveEventIds).toEqual(["evt-fresh", "evt-idle"]);
  });

  test("sends error payload when list iterator throws", async () => {
    const { client } = createFakeLiveTailClient({
      listScript: [{ error: new Error("list boom"), kind: "throw" }],
      streamScript: [],
    });
    const abortController = new AbortController();
    const stream = createLiveTailStream({
      client,
      heartbeatIntervalMs: SHORT_HEARTBEAT_INTERVAL_MS,
      sessionId: "sesn-3",
      signal: abortController.signal,
    });

    const payloads = parseSseDataLines(await readStreamToText(stream));
    const errorPayload = payloads.find((payload) => payload.phase === "error");
    expect(errorPayload).toBeDefined();
    if (!errorPayload || errorPayload.phase !== "error") {
      throw new Error("Expected error payload");
    }
    expect(errorPayload.message).toBe("list boom");
  });

  test("aborted signal closes the stream cleanly without emitting more events", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const { calls, client } = createFakeLiveTailClient({
      listScript: [createAgentMessageEvent("evt-1", "should be skipped")],
      streamScript: [createIdleEvent("evt-idle")],
    });

    const stream = createLiveTailStream({
      client,
      heartbeatIntervalMs: SHORT_HEARTBEAT_INTERVAL_MS,
      sessionId: "sesn-4",
      signal: abortController.signal,
    });

    const text = await readStreamToText(stream);
    expect(text).toBe("");
    expect(calls.streamCalls).toEqual([]);
  });

  test("emits stream-completed end reason when stream finishes without idle", async () => {
    const { client } = createFakeLiveTailClient({
      listScript: [],
      streamScript: [createAgentMessageEvent("evt-l-1", "tail end")],
    });
    const abortController = new AbortController();
    const stream = createLiveTailStream({
      client,
      heartbeatIntervalMs: SHORT_HEARTBEAT_INTERVAL_MS,
      sessionId: "sesn-5",
      signal: abortController.signal,
    });

    const payloads = parseSseDataLines(await readStreamToText(stream));
    const lastPayload = payloads[payloads.length - 1];
    if (!lastPayload || lastPayload.phase !== "end") {
      throw new Error("Expected final end payload");
    }
    expect(lastPayload.reason).toBe("stream-completed");
  });
});
