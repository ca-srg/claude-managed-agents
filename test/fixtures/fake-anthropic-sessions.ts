import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
  EventListParams,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { SessionCreateParams } from "@anthropic-ai/sdk/resources/beta/sessions/sessions";

type ScriptInstruction<TEvent> = TEvent | { error: Error; kind: "throw" } | { kind: "pending" };

export type FakeAnthropicSessionScenario = {
  listScripts?: Array<ReadonlyArray<ScriptInstruction<BetaManagedAgentsSessionEvent>>>;
  onSend?: (params: EventSendParams, calls: FakeAnthropicSessionCalls) => void;
  sessionId?: string;
  streamScripts: Array<ReadonlyArray<ScriptInstruction<BetaManagedAgentsStreamSessionEvents>>>;
};

export type FakeAnthropicSessionCalls = {
  creates: SessionCreateParams[];
  deletes: string[];
  listCalls: Array<{ params?: EventListParams; sessionId: string }>;
  sends: Array<{ params: EventSendParams; sessionId: string }>;
  streamCalls: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPendingInstruction<TEvent>(
  instruction: ScriptInstruction<TEvent>,
): instruction is { kind: "pending" } {
  return isRecord(instruction) && instruction.kind === "pending";
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

          if (isPendingInstruction(currentInstruction)) {
            return new Promise<IteratorResult<TEvent>>(() => {});
          }

          return {
            done: false,
            value: currentInstruction,
          };
        },
        async return(): Promise<IteratorResult<TEvent>> {
          return { done: true, value: undefined };
        },
      };
    },
  };
}

export function createFakeAnthropicSessions(scenario: FakeAnthropicSessionScenario): {
  calls: FakeAnthropicSessionCalls;
  client: {
    beta: {
      sessions: {
        create(params: SessionCreateParams): Promise<{ id: string }>;
        delete(sessionId: string): Promise<{ id: string; type: "session_deleted" }>;
        events: {
          list(
            sessionId: string,
            params?: EventListParams,
          ): AsyncIterable<BetaManagedAgentsSessionEvent>;
          send(sessionId: string, params: EventSendParams): Promise<{ ok: true }>;
          stream(sessionId: string): Promise<AsyncIterable<BetaManagedAgentsStreamSessionEvents>>;
        };
      };
    };
  };
} {
  const calls: FakeAnthropicSessionCalls = {
    creates: [],
    deletes: [],
    listCalls: [],
    sends: [],
    streamCalls: [],
  };
  const queuedListScripts = [...(scenario.listScripts ?? [])];
  const queuedStreamScripts = [...scenario.streamScripts];
  let createCount = 0;

  const client = {
    beta: {
      sessions: {
        async create(params: SessionCreateParams) {
          calls.creates.push(params);
          createCount += 1;

          return {
            id: scenario.sessionId ?? `sess-${createCount}`,
          };
        },
        async delete(sessionId: string) {
          calls.deletes.push(sessionId);

          return {
            id: sessionId,
            type: "session_deleted" as const,
          };
        },
        events: {
          list(sessionId: string, params?: EventListParams) {
            calls.listCalls.push({ params, sessionId });
            const nextScript = queuedListScripts.shift() ?? [];
            return createScriptIterable(nextScript);
          },
          async send(sessionId: string, params: EventSendParams) {
            calls.sends.push({ params, sessionId });
            scenario.onSend?.(params, calls);

            return { ok: true as const };
          },
          async stream(sessionId: string) {
            calls.streamCalls.push(sessionId);
            const nextScript = queuedStreamScripts.shift() ?? [];
            return createScriptIterable(nextScript);
          },
        },
      },
    },
  };

  return { calls, client };
}
