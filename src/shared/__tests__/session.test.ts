import { describe, expect, test } from "bun:test";
import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import pino from "pino";

import { runSession, type SessionClient, type ToolHandlerMap } from "../session";

const PROCESSED_AT = "2026-04-23T00:00:00.000Z";

type ScriptInstruction<TEvent> = TEvent | { error: Error; kind: "throw" } | { kind: "pending" };

type FakeSessionScript = {
  listScripts?: Array<ReadonlyArray<ScriptInstruction<BetaManagedAgentsSessionEvent>>>;
  onSend?: (params: EventSendParams, calls: FakeSessionCalls) => PromiseLike<unknown> | undefined;
  streamScripts: Array<ReadonlyArray<ScriptInstruction<BetaManagedAgentsStreamSessionEvents>>>;
};

type FakeSessionCalls = {
  listCalls: Array<{ after?: string }>;
  sends: EventSendParams[];
  streamCalls: number;
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

function createTestLogger() {
  return pino({ level: "silent" });
}

type CapturedLogLine = Record<string, unknown>;

function createCapturingLogger(): {
  lines: CapturedLogLine[];
  logger: ReturnType<typeof createTestLogger>;
} {
  const lines: CapturedLogLine[] = [];
  const destination = {
    write(chunk: string): void {
      const trimmedChunk = chunk.trim();
      if (trimmedChunk.length === 0) {
        return;
      }

      try {
        const parsedLine = JSON.parse(trimmedChunk);
        if (isRecord(parsedLine)) {
          lines.push(parsedLine);
        }
      } catch {
        return;
      }
    },
  };
  const logger = pino({ level: "info" }, destination) as ReturnType<typeof createTestLogger>;
  return { lines, logger };
}

function findLogLine(
  lines: CapturedLogLine[],
  predicate: (line: CapturedLogLine) => boolean,
): CapturedLogLine | undefined {
  return lines.find(predicate);
}

function createCustomToolUseEvent(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): BetaManagedAgentsAgentCustomToolUseEvent {
  return {
    id,
    input,
    name,
    processed_at: PROCESSED_AT,
    type: "agent.custom_tool_use",
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

function createThinkingEvent(
  id: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "agent.thinking" }> {
  return {
    id,
    processed_at: PROCESSED_AT,
    type: "agent.thinking",
  };
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

function createRequiresActionIdleEvent(
  id: string,
  eventIds: ReadonlyArray<string>,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.status_idle" }> {
  return {
    id,
    processed_at: PROCESSED_AT,
    stop_reason: { event_ids: [...eventIds], type: "requires_action" },
    type: "session.status_idle",
  };
}

function createCustomToolResultEvent(
  id: string,
  customToolUseId: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "user.custom_tool_result" }> {
  return {
    custom_tool_use_id: customToolUseId,
    id,
    type: "user.custom_tool_result",
  };
}

function createMcpConnectionErrorEvent(
  id: string,
  mcpServerName: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.error" }> {
  return {
    error: {
      mcp_server_name: mcpServerName,
      message: `MCP server '${mcpServerName}' initialize failed: upstream server error (HTTP 502)`,
      retry_status: { type: "exhausted" },
      type: "mcp_connection_failed_error",
    },
    id,
    processed_at: PROCESSED_AT,
    type: "session.error",
  };
}

function createMcpAuthErrorEvent(
  id: string,
  mcpServerName: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.error" }> {
  return {
    error: {
      mcp_server_name: mcpServerName,
      message: `MCP server '${mcpServerName}' rejected the static bearer token`,
      retry_status: { type: "exhausted" },
      type: "mcp_authentication_failed_error",
    },
    id,
    processed_at: PROCESSED_AT,
    type: "session.error",
  };
}

function createModelErrorEvent(
  id: string,
): Extract<BetaManagedAgentsSessionEvent, { type: "session.error" }> {
  return {
    error: {
      message: "model overloaded",
      retry_status: { type: "retrying" },
      type: "model_overloaded_error",
    },
    id,
    processed_at: PROCESSED_AT,
    type: "session.error",
  };
}

function createAgentMessageEvent(
  id: string,
  textBlocks: ReadonlyArray<string>,
): Extract<BetaManagedAgentsSessionEvent, { type: "agent.message" }> {
  return {
    content: textBlocks.map((text) => ({ text, type: "text" as const })),
    id,
    processed_at: PROCESSED_AT,
    type: "agent.message",
  };
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

function createFakeSessionClient(script: FakeSessionScript): {
  calls: FakeSessionCalls;
  client: SessionClient;
} {
  const calls: FakeSessionCalls = {
    listCalls: [],
    sends: [],
    streamCalls: 0,
  };
  const queuedStreamScripts = [...script.streamScripts];
  const queuedListScripts = [...(script.listScripts ?? [])];

  const client: SessionClient = {
    beta: {
      sessions: {
        events: {
          async send(_sessionId, params) {
            calls.sends.push(params);
            const sendOutcome = script.onSend?.(params, calls);
            if (sendOutcome) {
              return await sendOutcome;
            }
            return { ok: true };
          },
          list(_sessionId, params) {
            calls.listCalls.push({ after: undefined, ...params });
            const nextScript = queuedListScripts.shift() ?? [];
            return createScriptIterable(nextScript);
          },
          async stream(_sessionId) {
            calls.streamCalls += 1;
            const nextScript = queuedStreamScripts.shift() ?? [];
            return createScriptIterable(nextScript);
          },
        },
      },
    },
  };

  return { calls, client };
}

function getFirstCustomToolResultEvent(params: EventSendParams) {
  const sentEvent = params.events[0];
  expect(sentEvent?.type).toBe("user.custom_tool_result");

  if (!sentEvent || sentEvent.type !== "user.custom_tool_result") {
    throw new Error("Expected a user.custom_tool_result event");
  }

  return sentEvent;
}

function getRequiredSend(calls: FakeSessionCalls, index: number): EventSendParams {
  const sendCall = calls.sends[index];

  if (!sendCall) {
    throw new Error(`Expected send call #${index + 1}`);
  }

  return sendCall;
}

function parseFirstTextPayload(params: EventSendParams): unknown {
  const sentEvent = getFirstCustomToolResultEvent(params);
  const firstBlock = sentEvent.content?.[0];
  expect(firstBlock?.type).toBe("text");

  if (!firstBlock || firstBlock.type !== "text") {
    throw new Error("Expected a text content block");
  }

  return JSON.parse(firstBlock.text);
}

function parseFirstTextPayloadRecord(params: EventSendParams): Record<string, unknown> {
  const payload = parseFirstTextPayload(params);

  if (!isRecord(payload)) {
    throw new Error("Expected parsed payload to be an object");
  }

  return payload;
}

describe("runSession", () => {
  test("streamSession yields events from mocked stream", async () => {
    const { client } = createFakeSessionClient({
      streamScripts: [
        [createRunningEvent("evt-1"), createThinkingEvent("evt-2"), createIdleEvent("evt-3")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {},
      logger: createTestLogger(),
      sessionId: "sesn-1",
      timeouts: { maxWallClockMs: 1_000 },
    });

    expect(sessionResult.eventsProcessed).toBe(3);
    expect(sessionResult.idleReached).toBe(true);
    expect(sessionResult.toolInvocations).toBe(0);
    expect(sessionResult.toolErrors).toBe(0);
  });

  test("dispatchEvent routes agent.custom_tool_use by tool name to correct handler", async () => {
    const createSubIssueCalls: unknown[] = [];
    let createFinalPrCalls = 0;
    const handlers: ToolHandlerMap = {
      create_final_pr: async () => {
        createFinalPrCalls += 1;
        return { success: true };
      },
      create_sub_issue: async (args) => {
        createSubIssueCalls.push(args);
        return { success: true };
      },
    };
    const toolUseEvent = createCustomToolUseEvent("evt-tool-1", "create_sub_issue", {
      title: "Add tests",
    });
    const { client } = createFakeSessionClient({
      streamScripts: [
        [toolUseEvent, createIdleEvent("evt-idle")],
        [createIdleEvent("evt-idle-final")],
      ],
    });

    await runSession(client, {
      handlers,
      logger: createTestLogger(),
      sessionId: "sesn-2",
      timeouts: { maxWallClockMs: 1_000 },
    });

    expect(createSubIssueCalls).toEqual([{ title: "Add tests" }]);
    expect(createFinalPrCalls).toBe(0);
  });

  test("handler returns value → sends user.custom_tool_result with JSON result", async () => {
    const toolUseEvent = createCustomToolUseEvent("evt-tool-2", "create_sub_issue", {
      title: "Ship feature",
    });
    const expectedOutput = { issueNumber: 17, success: true };
    const { calls, client } = createFakeSessionClient({
      streamScripts: [
        [toolUseEvent, createIdleEvent("evt-idle")],
        [createIdleEvent("evt-idle-final")],
      ],
    });

    await runSession(client, {
      handlers: {
        create_sub_issue: async () => expectedOutput,
      },
      logger: createTestLogger(),
      sessionId: "sesn-3",
      timeouts: { maxWallClockMs: 1_000 },
    });

    expect(calls.sends).toHaveLength(1);
    const sentEvent = getFirstCustomToolResultEvent(getRequiredSend(calls, 0));
    expect(sentEvent.custom_tool_use_id).toBe(toolUseEvent.id);
    expect(parseFirstTextPayload(getRequiredSend(calls, 0))).toEqual(expectedOutput);
  });

  test("handler throws → sends user.custom_tool_result with structured error (no crash)", async () => {
    let secondHandlerCalls = 0;
    const { calls, client } = createFakeSessionClient({
      streamScripts: [
        [
          createCustomToolUseEvent("evt-tool-3", "create_sub_issue", { fail: true }),
          createCustomToolUseEvent("evt-tool-4", "create_final_pr", { fail: false }),
          createIdleEvent("evt-idle"),
        ],
        [createIdleEvent("evt-idle-final")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          secondHandlerCalls += 1;
          return { success: true };
        },
        create_sub_issue: async () => {
          throw new Error("boom");
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-4",
      timeouts: { maxWallClockMs: 1_000 },
    });

    expect(calls.sends).toHaveLength(2);
    const errorPayload = parseFirstTextPayloadRecord(getRequiredSend(calls, 0));
    expect(errorPayload.success).toBe(false);
    expect(isRecord(errorPayload.error)).toBe(true);
    if (!isRecord(errorPayload.error)) {
      throw new Error("Expected handler error payload");
    }
    expect(errorPayload.error.message).toBe("boom");
    expect(errorPayload.error.type).toBe("handler_error");
    expect(typeof errorPayload.error.stack).toBe("string");
    expect(secondHandlerCalls).toBe(1);
    expect(sessionResult.toolErrors).toBe(1);
  });

  test("session.status_idle breaks the loop", async () => {
    let handlerCalls = 0;
    const { client } = createFakeSessionClient({
      streamScripts: [
        [
          createRunningEvent("evt-running"),
          createIdleEvent("evt-idle"),
          createCustomToolUseEvent("evt-after-idle", "create_sub_issue", { title: "late" }),
        ],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_sub_issue: async () => {
          handlerCalls += 1;
          return { success: true };
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-5",
      timeouts: { maxWallClockMs: 1_000 },
    });

    expect(sessionResult.idleReached).toBe(true);
    expect(sessionResult.eventsProcessed).toBe(2);
    expect(handlerCalls).toBe(0);
  });

  test("reconnect on stream error uses events.list({ after }) and dedupes", async () => {
    const handlerInputs: unknown[] = [];
    const firstToolUseEvent = createCustomToolUseEvent("evt-tool-5", "create_sub_issue", {
      title: "first",
    });
    const secondToolUseEvent = createCustomToolUseEvent("evt-tool-6", "create_sub_issue", {
      title: "second",
    });
    const { calls, client } = createFakeSessionClient({
      listScripts: [[firstToolUseEvent, secondToolUseEvent]],
      streamScripts: [
        [firstToolUseEvent, { error: new Error("stream dropped"), kind: "throw" }],
        [createIdleEvent("evt-idle")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_sub_issue: async (args) => {
          handlerInputs.push(args);
          return { success: true };
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-6",
      timeouts: { maxWallClockMs: 1_000 },
    });

    expect(calls.listCalls).toEqual([{ after: undefined }]);
    expect(calls.streamCalls).toBe(2);
    expect(handlerInputs).toEqual([{ title: "first" }, { title: "second" }]);
    expect(sessionResult.toolInvocations).toBe(2);
    expect(sessionResult.idleReached).toBe(true);
  });

  test("reconnects when stream closes before session reaches idle", async () => {
    let finalPrCalls = 0;
    const finalPrToolUseEvent = createCustomToolUseEvent("evt-tool-final", "create_final_pr", {
      title: "Ready for review",
    });
    const { calls, client } = createFakeSessionClient({
      listScripts: [[]],
      streamScripts: [
        [createRunningEvent("evt-running")],
        [finalPrToolUseEvent],
        [createIdleEvent("evt-idle")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          finalPrCalls += 1;
          return { prUrl: "https://github.com/owner/repo/pull/1", success: true };
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-stream-close",
      timeouts: { maxWallClockMs: 1_000, streamReconnectDelayMs: 0 },
    });

    expect(calls.streamCalls).toBe(3);
    expect(calls.listCalls).toEqual([{ after: undefined }, { after: undefined }]);
    expect(finalPrCalls).toBe(1);
    expect(sessionResult.idleReached).toBe(true);
    expect(sessionResult.toolInvocations).toBe(1);
  });

  test("caps clean stream-close reconnects without replayed events", async () => {
    const { calls, client } = createFakeSessionClient({
      listScripts: [[], []],
      streamScripts: [[createRunningEvent("evt-running-clean-close")], [], []],
    });

    const sessionResult = await runSession(client, {
      handlers: {},
      logger: createTestLogger(),
      sessionId: "sesn-clean-close-cap",
      timeouts: { maxWallClockMs: 1_000, streamReconnectDelayMs: 0 },
    });

    expect(calls.streamCalls).toBe(3);
    expect(calls.listCalls).toEqual([{ after: undefined }, { after: undefined }]);
    expect(sessionResult.eventsProcessed).toBe(1);
    expect(sessionResult.errored).toBe(true);
    expect(sessionResult.idleReached).toBe(false);
    expect(sessionResult.timedOut).toBe(false);
  });

  test("continues streaming when replay stops on idle after a custom tool result", async () => {
    const toolUseEvent = createCustomToolUseEvent("evt-tool-replay", "create_final_pr", {
      title: "Ready for review",
    });
    const { calls, client } = createFakeSessionClient({
      listScripts: [[createIdleEvent("evt-idle-replayed")]],
      streamScripts: [[toolUseEvent], [createIdleEvent("evt-idle-final")]],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => ({
          prUrl: "https://github.com/owner/repo/pull/1",
          success: true,
        }),
      },
      logger: createTestLogger(),
      sessionId: "sesn-replay-idle-after-tool",
      timeouts: { maxWallClockMs: 1_000, streamReconnectDelayMs: 0 },
    });

    expect(calls.listCalls).toEqual([{ after: undefined }]);
    expect(calls.streamCalls).toBe(2);
    expect(sessionResult.idleReached).toBe(true);
    expect(sessionResult.timedOut).toBe(false);
    expect(sessionResult.toolInvocations).toBe(1);
  });

  test("wall-clock timeout aborts with graceful shutdown", async () => {
    const { client } = createFakeSessionClient({
      streamScripts: [[{ kind: "pending" }]],
    });
    const startedAt = Date.now();

    const sessionResult = await runSession(client, {
      handlers: {},
      logger: createTestLogger(),
      sessionId: "sesn-7",
      timeouts: { maxWallClockMs: 100 },
    });

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs < 200).toBe(true);
    expect(sessionResult.timedOut).toBe(true);
    expect(sessionResult.aborted).toBe(false);
  });

  test("unknown tool name → sends error result, does not crash", async () => {
    let knownHandlerCalls = 0;
    const { calls, client } = createFakeSessionClient({
      streamScripts: [
        [
          createCustomToolUseEvent("evt-tool-8", "nonexistent_tool", { title: "missing" }),
          createCustomToolUseEvent("evt-tool-9", "create_sub_issue", { title: "known" }),
          createIdleEvent("evt-idle"),
        ],
        [createIdleEvent("evt-idle-final")],
      ],
    });

    await runSession(client, {
      handlers: {
        create_sub_issue: async () => {
          knownHandlerCalls += 1;
          return { success: true };
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-8",
      timeouts: { maxWallClockMs: 1_000 },
    });

    const unknownToolPayload = parseFirstTextPayloadRecord(getRequiredSend(calls, 0));
    expect(unknownToolPayload.success).toBe(false);
    expect(isRecord(unknownToolPayload.error)).toBe(true);
    if (!isRecord(unknownToolPayload.error)) {
      throw new Error("Expected unknown-tool error payload");
    }
    expect(unknownToolPayload.error.message).toBe(
      'No handler registered for custom tool "nonexistent_tool"',
    );
    expect(unknownToolPayload.error.type).toBe("unknown_tool");
    expect(knownHandlerCalls).toBe(1);
  });

  test("external AbortSignal breaks the loop cleanly", async () => {
    const abortController = new AbortController();
    const { calls, client } = createFakeSessionClient({
      onSend: () => {
        abortController.abort();
        return undefined;
      },
      streamScripts: [
        [
          createCustomToolUseEvent("evt-tool-10", "create_sub_issue", { title: "first" }),
          { kind: "pending" },
          createCustomToolUseEvent("evt-tool-11", "create_sub_issue", { title: "second" }),
        ],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_sub_issue: async () => ({ success: true }),
      },
      logger: createTestLogger(),
      sessionId: "sesn-9",
      signal: abortController.signal,
      timeouts: { maxWallClockMs: 1_000 },
    });

    expect(sessionResult.aborted).toBe(true);
    expect(sessionResult.toolInvocations).toBe(1);
    expect(calls.sends).toHaveLength(1);
  });

  test("non-serializable handler output → sends serialization_error result", async () => {
    const { calls, client } = createFakeSessionClient({
      streamScripts: [
        [createCustomToolUseEvent("evt-tool-12", "create_sub_issue"), createIdleEvent("evt-idle")],
        [createIdleEvent("evt-idle-final")],
      ],
    });

    await runSession(client, {
      handlers: {
        create_sub_issue: async () => ({ value: BigInt(42) }),
      },
      logger: createTestLogger(),
      sessionId: "sesn-10",
      timeouts: { maxWallClockMs: 1_000 },
    });

    const serializationPayload = parseFirstTextPayloadRecord(getRequiredSend(calls, 0));
    expect(serializationPayload.success).toBe(false);
    expect(isRecord(serializationPayload.error)).toBe(true);
    if (!isRecord(serializationPayload.error)) {
      throw new Error("Expected serialization error payload");
    }
    expect(String(serializationPayload.error.message).includes("serialize")).toBe(true);
    expect(serializationPayload.error.type).toBe("serialization_error");
  });

  test("oversized handler output → sends payload_too_large result", async () => {
    const { calls, client } = createFakeSessionClient({
      streamScripts: [
        [createCustomToolUseEvent("evt-tool-13", "create_sub_issue"), createIdleEvent("evt-idle")],
        [createIdleEvent("evt-idle-final")],
      ],
    });

    await runSession(client, {
      handlers: {
        create_sub_issue: async () => ({ payload: "x".repeat(70_000) }),
      },
      logger: createTestLogger(),
      sessionId: "sesn-11",
      timeouts: { maxWallClockMs: 1_000 },
    });

    const oversizedPayload = parseFirstTextPayloadRecord(getRequiredSend(calls, 0));
    expect(oversizedPayload.success).toBe(false);
    expect(oversizedPayload.truncated).toBe(true);
    expect(typeof oversizedPayload.preview).toBe("string");
    expect(isRecord(oversizedPayload.error)).toBe(true);
    if (!isRecord(oversizedPayload.error)) {
      throw new Error("Expected payload-too-large error payload");
    }
    expect(typeof oversizedPayload.error.actualSize).toBe("number");
    expect(String(oversizedPayload.error.message).includes("64KB")).toBe(true);
    expect(oversizedPayload.error.sizeLimit).toBe(65_536);
    expect(oversizedPayload.error.type).toBe("payload_too_large");
  });

  test("agent.message with text content emits info log with non-truncated preview", async () => {
    const messageBody = "Hello from the agent";
    const { client } = createFakeSessionClient({
      streamScripts: [
        [createAgentMessageEvent("evt-msg-1", [messageBody]), createIdleEvent("evt-idle")],
      ],
    });
    const { lines, logger } = createCapturingLogger();

    await runSession(client, {
      handlers: {},
      logger,
      sessionId: "sesn-msg-1",
      timeouts: { maxWallClockMs: 1_000 },
    });

    const messageLogLine = findLogLine(
      lines,
      (line) => line.msg === "agent message" && line.eventId === "evt-msg-1",
    );
    expect(messageLogLine).toBeDefined();
    if (!messageLogLine) {
      throw new Error("Expected agent message log line");
    }
    expect(messageLogLine.preview).toBe(messageBody);
    expect(messageLogLine.truncated).toBe(false);
    expect(typeof messageLogLine.previewCharLimit).toBe("number");
  });

  test("agent.message with oversize text content marks preview truncated and ends with ellipsis", async () => {
    const longText = "x".repeat(2_500);
    const { client } = createFakeSessionClient({
      streamScripts: [
        [createAgentMessageEvent("evt-msg-2", [longText]), createIdleEvent("evt-idle")],
      ],
    });
    const { lines, logger } = createCapturingLogger();

    await runSession(client, {
      handlers: {},
      logger,
      sessionId: "sesn-msg-2",
      timeouts: { maxWallClockMs: 1_000 },
    });

    const messageLogLine = findLogLine(
      lines,
      (line) => line.msg === "agent message" && line.eventId === "evt-msg-2",
    );
    expect(messageLogLine).toBeDefined();
    if (!messageLogLine) {
      throw new Error("Expected agent message log line");
    }
    expect(messageLogLine.truncated).toBe(true);
    expect(typeof messageLogLine.preview).toBe("string");
    const previewText = messageLogLine.preview;
    if (typeof previewText !== "string") {
      throw new Error("Expected string preview");
    }
    expect(previewText.endsWith("…")).toBe(true);
    expect(previewText.length < longText.length).toBe(true);
  });

  test("agent.message without text content does not emit info log", async () => {
    const { client } = createFakeSessionClient({
      streamScripts: [[createAgentMessageEvent("evt-msg-3", []), createIdleEvent("evt-idle")]],
    });
    const { lines, logger } = createCapturingLogger();

    await runSession(client, {
      handlers: {},
      logger,
      sessionId: "sesn-msg-3",
      timeouts: { maxWallClockMs: 1_000 },
    });

    const messageLogLine = findLogLine(
      lines,
      (line) => line.msg === "agent message" && line.eventId === "evt-msg-3",
    );
    expect(messageLogLine).toBeUndefined();
  });

  test("requires_action idle recovers a pending custom tool use missed by the stream", async () => {
    let finalPrCalls = 0;
    const finalPrToolUse = createCustomToolUseEvent("evt-final-ra", "create_final_pr", {
      title: "Ready",
    });
    const { calls, client } = createFakeSessionClient({
      // History holds the tool use but no result yet (the live stream missed it).
      listScripts: [[finalPrToolUse]],
      streamScripts: [
        [
          createRunningEvent("evt-run-ra"),
          createRequiresActionIdleEvent("evt-idle-ra", ["evt-final-ra"]),
        ],
        [createIdleEvent("evt-idle-done")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          finalPrCalls += 1;
          return { prUrl: "https://github.com/owner/repo/pull/1", success: true };
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-requires-action",
      timeouts: { maxWallClockMs: 1_000, streamReconnectDelayMs: 0 },
    });

    expect(finalPrCalls).toBe(1);
    const recoveredResult = getFirstCustomToolResultEvent(getRequiredSend(calls, 0));
    expect(recoveredResult.custom_tool_use_id).toBe("evt-final-ra");
    expect(recoveredResult.is_error).toBeUndefined();
    expect(sessionResult.toolInvocations).toBe(1);
    expect(sessionResult.idleReached).toBe(true);
  });

  test("recovered custom tool use is marked processed before a later replay", async () => {
    let finalPrCalls = 0;
    const finalPrToolUse = createCustomToolUseEvent("evt-final-replay-once", "create_final_pr", {
      title: "Ready",
    });
    const { calls, client } = createFakeSessionClient({
      listScripts: [[finalPrToolUse], [finalPrToolUse, createIdleEvent("evt-idle-replay-done")]],
      streamScripts: [
        [
          createRunningEvent("evt-run-replay-once"),
          createRequiresActionIdleEvent("evt-idle-replay-once", ["evt-final-replay-once"]),
        ],
        [],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          finalPrCalls += 1;
          return { prUrl: "https://github.com/owner/repo/pull/1", success: true };
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-recovered-replay-once",
      timeouts: { maxWallClockMs: 1_000, streamReconnectDelayMs: 0 },
    });

    expect(finalPrCalls).toBe(1);
    expect(calls.sends).toHaveLength(1);
    expect(calls.listCalls).toHaveLength(2);
    expect(sessionResult.toolInvocations).toBe(1);
    expect(sessionResult.idleReached).toBe(true);
  });

  test("replay resends a cached result after send timeouts without rerunning the handler", async () => {
    let finalPrCalls = 0;
    const finalPrToolUse = createCustomToolUseEvent("evt-final-send-timeout", "create_final_pr", {
      title: "Ready",
    });
    const { calls, client } = createFakeSessionClient({
      listScripts: [[finalPrToolUse], [finalPrToolUse]],
      onSend: () => new Promise<never>(() => {}),
      streamScripts: [[createRunningEvent("evt-run-send-timeout"), finalPrToolUse]],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          finalPrCalls += 1;
          return { prUrl: "https://github.com/owner/repo/pull/1", success: true };
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-send-timeout-cache-replay",
      timeouts: {
        maxWallClockMs: 10_000,
        streamReconnectDelayMs: 0,
        toolResultSendTimeoutMs: 1,
      },
    });

    expect(finalPrCalls).toBe(1);
    expect(calls.sends).toHaveLength(9);
    expect(calls.listCalls).toHaveLength(2);
    expect(sessionResult.toolInvocations).toBe(1);
    expect(sessionResult.errored).toBe(true);
  });

  test("replay skips cached resend when history already resolved a locally timed-out send", async () => {
    let finalPrCalls = 0;
    const finalPrToolUse = createCustomToolUseEvent(
      "evt-final-send-timeout-resolved",
      "create_final_pr",
      {
        title: "Ready",
      },
    );
    const { calls, client } = createFakeSessionClient({
      listScripts: [
        [
          finalPrToolUse,
          createCustomToolResultEvent("evt-result-send-timeout-resolved", finalPrToolUse.id),
        ],
      ],
      onSend: () => new Promise<never>(() => {}),
      streamScripts: [
        [createRunningEvent("evt-run-send-timeout-resolved"), finalPrToolUse],
        [createIdleEvent("evt-idle-send-timeout-resolved")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          finalPrCalls += 1;
          return { prUrl: "https://github.com/owner/repo/pull/1", success: true };
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-send-timeout-history-resolved",
      timeouts: {
        maxWallClockMs: 5_000,
        streamReconnectDelayMs: 0,
        toolResultSendTimeoutMs: 1,
      },
    });

    expect(finalPrCalls).toBe(1);
    expect(calls.sends).toHaveLength(3);
    expect(calls.listCalls).toHaveLength(1);
    expect(calls.streamCalls).toBe(2);
    expect(sessionResult.toolInvocations).toBe(1);
    expect(sessionResult.idleReached).toBe(true);
    expect(sessionResult.errored).toBe(false);
  });

  test("requires_action recovery resends an unresolved cached result and marks it processed", async () => {
    let finalPrCalls = 0;
    let sendCalls = 0;
    const finalPrToolUse = createCustomToolUseEvent(
      "evt-final-cached-recovery",
      "create_final_pr",
      {
        title: "Ready",
      },
    );
    const expectedOutput = { prUrl: "https://github.com/owner/repo/pull/1", success: true };
    const { calls, client } = createFakeSessionClient({
      listScripts: [[], [finalPrToolUse]],
      onSend: () => {
        sendCalls += 1;
        if (sendCalls <= 3) {
          return new Promise<never>(() => {});
        }
      },
      streamScripts: [
        [createRunningEvent("evt-run-cached-recovery"), finalPrToolUse],
        [createRequiresActionIdleEvent("evt-idle-cached-recovery", [finalPrToolUse.id])],
        [finalPrToolUse, createIdleEvent("evt-idle-cached-recovery-done")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          finalPrCalls += 1;
          return expectedOutput;
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-cached-recovery",
      timeouts: {
        maxWallClockMs: 5_000,
        streamReconnectDelayMs: 0,
        toolResultSendTimeoutMs: 1,
      },
    });

    expect(finalPrCalls).toBe(1);
    expect(calls.sends).toHaveLength(4);
    expect(parseFirstTextPayload(getRequiredSend(calls, 3))).toEqual(expectedOutput);
    expect(sessionResult.toolInvocations).toBe(1);
    expect(sessionResult.idleReached).toBe(true);
  });

  test("requires_action idle after an in-stream tool result reopens without redispatch", async () => {
    let finalPrCalls = 0;
    const finalPrToolUse = createCustomToolUseEvent("evt-final-current", "create_final_pr", {
      title: "Ready",
    });
    const { calls, client } = createFakeSessionClient({
      // If requires_action recovery runs here it would find and redispatch this tool use.
      listScripts: [[finalPrToolUse]],
      streamScripts: [
        [finalPrToolUse, createRequiresActionIdleEvent("evt-idle-current", ["evt-final-current"])],
        [createIdleEvent("evt-idle-done")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          finalPrCalls += 1;
          return { prUrl: "https://github.com/owner/repo/pull/1", success: true };
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-requires-action-current-stream",
      timeouts: { maxWallClockMs: 1_000, streamReconnectDelayMs: 0 },
    });

    expect(finalPrCalls).toBe(1);
    expect(calls.sends).toHaveLength(1);
    expect(calls.listCalls).toHaveLength(0);
    expect(sessionResult.idleReached).toBe(true);
  });

  test("requires_action idle does not re-dispatch a tool use that already has a result", async () => {
    let finalPrCalls = 0;
    const finalPrToolUse = createCustomToolUseEvent("evt-final-done", "create_final_pr", {});
    const { calls, client } = createFakeSessionClient({
      // History already contains the result, so recovery must be a no-op.
      listScripts: [[finalPrToolUse, createCustomToolResultEvent("evt-res", "evt-final-done")]],
      streamScripts: [
        [
          createRunningEvent("evt-run-done"),
          createRequiresActionIdleEvent("evt-idle-already", ["evt-final-done"]),
        ],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          finalPrCalls += 1;
          return { success: true };
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-already-resolved",
      timeouts: { maxWallClockMs: 1_000, streamReconnectDelayMs: 0 },
    });

    // No re-dispatch, no duplicate send, and idle is treated as terminal.
    expect(finalPrCalls).toBe(0);
    expect(calls.sends).toHaveLength(0);
    expect(sessionResult.idleReached).toBe(true);
  });

  test("custom tool handler timeout sends an error result instead of stranding the session", async () => {
    const hangingToolUse = createCustomToolUseEvent("evt-hang", "create_final_pr", {});
    let handlerSignal: AbortSignal | undefined;
    let handlerSignalAborted = false;
    const { calls, client } = createFakeSessionClient({
      listScripts: [[]],
      streamScripts: [
        [createRunningEvent("evt-run-hang"), hangingToolUse],
        [createIdleEvent("evt-idle-after-timeout")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        // Never resolves: simulates a hung create_final_pr handler.
        create_final_pr: (_args, context) => {
          handlerSignal = context.signal;
          context.signal.addEventListener("abort", () => {
            handlerSignalAborted = true;
          });
          return new Promise<never>(() => {});
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-handler-timeout",
      timeouts: {
        maxWallClockMs: 2_000,
        streamReconnectDelayMs: 0,
        toolHandlerTimeoutMs: 20,
      },
    });

    const timeoutResult = getFirstCustomToolResultEvent(getRequiredSend(calls, 0));
    expect(timeoutResult.custom_tool_use_id).toBe("evt-hang");
    expect(timeoutResult.is_error).toBe(true);
    const payload = parseFirstTextPayloadRecord(getRequiredSend(calls, 0));
    expect(isRecord(payload.error)).toBe(true);
    if (!isRecord(payload.error)) {
      throw new Error("Expected handler timeout error payload");
    }
    expect(payload.error.type).toBe("handler_timeout");
    expect(handlerSignal?.aborted).toBe(true);
    expect(handlerSignalAborted).toBe(true);
    expect(sessionResult.toolErrors).toBe(1);
  });

  test("requires_action recovery is bounded and finally sends a terminal error result", async () => {
    let handlerCalls = 0;
    const loopToolUse = createCustomToolUseEvent("evt-loop", "create_final_pr", {});
    const { calls, client } = createFakeSessionClient({
      // Result never registers in history, so each idle re-blocks on the same id.
      listScripts: [[loopToolUse], [loopToolUse], [loopToolUse]],
      streamScripts: [
        [
          createRunningEvent("evt-run-loop"),
          createRequiresActionIdleEvent("evt-idle-1", ["evt-loop"]),
        ],
        [createRequiresActionIdleEvent("evt-idle-2", ["evt-loop"])],
        [createRequiresActionIdleEvent("evt-idle-3", ["evt-loop"])],
        [createIdleEvent("evt-idle-done")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          handlerCalls += 1;
          return { prUrl: "https://github.com/owner/repo/pull/1", success: true };
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-bounded-recovery",
      timeouts: { maxWallClockMs: 2_000, streamReconnectDelayMs: 0 },
    });

    // attempt 0 dispatches the handler; attempt 1 resends the cached result;
    // attempt 2 (>= MAX) sends a terminal error without rerunning the handler.
    expect(handlerCalls).toBe(1);
    const lastSend = calls.sends[calls.sends.length - 1];
    if (!lastSend) {
      throw new Error("Expected at least one send");
    }
    const terminalPayload = parseFirstTextPayloadRecord(lastSend);
    expect(isRecord(terminalPayload.error)).toBe(true);
    if (!isRecord(terminalPayload.error)) {
      throw new Error("Expected terminal recovery error payload");
    }
    expect(terminalPayload.error.type).toBe("tool_recovery_exhausted");
    expect(sessionResult.idleReached).toBe(true);
  });

  test("session.error from an MCP connection failure does not tear down the session", async () => {
    let finalPrCalls = 0;
    const authFailures: Array<{ mcpServerName: string }> = [];
    const { calls, client } = createFakeSessionClient({
      streamScripts: [
        [
          createMcpConnectionErrorEvent("evt-mcp-err", "Kibela"),
          createCustomToolUseEvent("evt-final-after-mcp", "create_final_pr", {}),
          createIdleEvent("evt-idle"),
        ],
        [createIdleEvent("evt-idle-final")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          finalPrCalls += 1;
          return { prUrl: "https://github.com/owner/repo/pull/1", success: true };
        },
      },
      logger: createTestLogger(),
      onMcpAuthenticationFailed: (info) => {
        authFailures.push(info);
      },
      sessionId: "sesn-mcp-error",
      timeouts: { maxWallClockMs: 1_000, streamReconnectDelayMs: 0 },
    });

    // The MCP error did not throw/reconnect: the same stream kept flowing and
    // the subsequent create_final_pr was handled. No events.list replay means
    // no reconnect path was taken.
    expect(finalPrCalls).toBe(1);
    expect(calls.listCalls).toHaveLength(0);
    expect(sessionResult.errored).toBe(false);
    expect(sessionResult.idleReached).toBe(true);
    // Connection failures are not credential failures; the auth fallback must
    // stay quiet so it cannot churn tokens on transient outages.
    expect(authFailures).toEqual([]);
  });

  test("mcp_authentication_failed_error invokes onMcpAuthenticationFailed with the server name", async () => {
    const authFailures: Array<{ mcpServerName: string }> = [];
    let finalPrCalls = 0;
    const { client } = createFakeSessionClient({
      streamScripts: [
        [
          createMcpAuthErrorEvent("evt-mcp-auth-err", "github"),
          createCustomToolUseEvent("evt-final-after-auth", "create_final_pr", {}),
          createIdleEvent("evt-idle"),
        ],
        [createIdleEvent("evt-idle-final")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          finalPrCalls += 1;
          return { prUrl: "https://github.com/owner/repo/pull/1", success: true };
        },
      },
      logger: createTestLogger(),
      onMcpAuthenticationFailed: (info) => {
        authFailures.push(info);
      },
      sessionId: "sesn-mcp-auth-error",
      timeouts: { maxWallClockMs: 1_000, streamReconnectDelayMs: 0 },
    });

    expect(authFailures).toEqual([{ mcpServerName: "github" }]);
    expect(finalPrCalls).toBe(1);
    expect(sessionResult.errored).toBe(false);
    expect(sessionResult.idleReached).toBe(true);
  });

  test("a throwing onMcpAuthenticationFailed callback does not tear down the session", async () => {
    let finalPrCalls = 0;
    const { lines, logger } = createCapturingLogger();
    const { client } = createFakeSessionClient({
      streamScripts: [
        [
          createMcpAuthErrorEvent("evt-mcp-auth-err", "github"),
          createCustomToolUseEvent("evt-final-after-auth", "create_final_pr", {}),
          createIdleEvent("evt-idle"),
        ],
        [createIdleEvent("evt-idle-final")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_final_pr: async () => {
          finalPrCalls += 1;
          return { prUrl: "https://github.com/owner/repo/pull/1", success: true };
        },
      },
      logger,
      onMcpAuthenticationFailed: () => {
        throw new Error("refresh failed");
      },
      sessionId: "sesn-mcp-auth-throw",
      timeouts: { maxWallClockMs: 1_000, streamReconnectDelayMs: 0 },
    });

    expect(finalPrCalls).toBe(1);
    expect(sessionResult.errored).toBe(false);
    expect(sessionResult.idleReached).toBe(true);
    expect(
      findLogLine(lines, (line) => line.msg === "onMcpAuthenticationFailed callback failed"),
    ).toBeDefined();
  });

  test("a rejecting async onMcpAuthenticationFailed callback is caught and logged", async () => {
    const { lines, logger } = createCapturingLogger();
    const { client } = createFakeSessionClient({
      streamScripts: [
        [createMcpAuthErrorEvent("evt-mcp-auth-err", "github"), createIdleEvent("evt-idle")],
        [createIdleEvent("evt-idle-final")],
      ],
    });

    const sessionResult = await runSession(client, {
      handlers: {},
      logger,
      onMcpAuthenticationFailed: async () => {
        throw new Error("async refresh failed");
      },
      sessionId: "sesn-mcp-auth-reject",
      timeouts: { maxWallClockMs: 1_000, streamReconnectDelayMs: 0 },
    });

    expect(sessionResult.errored).toBe(false);
    expect(sessionResult.idleReached).toBe(true);
    expect(
      findLogLine(lines, (line) => line.msg === "onMcpAuthenticationFailed callback failed"),
    ).toBeDefined();
  });

  test("session.error from a model error still triggers a reconnect", async () => {
    const toolUseEvent = createCustomToolUseEvent("evt-tool-model", "create_sub_issue", {
      title: "x",
    });
    const handlerInputs: unknown[] = [];
    const { calls, client } = createFakeSessionClient({
      listScripts: [[toolUseEvent]],
      streamScripts: [[createModelErrorEvent("evt-model-err")], [createIdleEvent("evt-idle")]],
    });

    const sessionResult = await runSession(client, {
      handlers: {
        create_sub_issue: async (args) => {
          handlerInputs.push(args);
          return { success: true };
        },
      },
      logger: createTestLogger(),
      sessionId: "sesn-model-error",
      timeouts: { maxWallClockMs: 1_000, streamReconnectDelayMs: 0 },
    });

    // Model error throws -> reconnect -> events.list replay dispatches the tool.
    expect(calls.listCalls.length >= 1).toBe(true);
    expect(handlerInputs).toEqual([{ title: "x" }]);
    expect(sessionResult.idleReached).toBe(true);
  });
});
