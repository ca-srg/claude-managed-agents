import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsAgentThreadMessageReceivedEvent,
  BetaManagedAgentsAgentThreadMessageSentEvent,
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsSessionThreadStatusIdleEvent,
  BetaManagedAgentsSessionThreadStatusRescheduledEvent,
  BetaManagedAgentsSessionThreadStatusRunningEvent,
  BetaManagedAgentsSessionThreadStatusTerminatedEvent,
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsTextBlock,
  EventListParams,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { Logger } from "pino";

export type ToolHandlerContext = { signal: AbortSignal };
export type ToolHandler = (args: unknown, context: ToolHandlerContext) => Promise<unknown>;
export type ToolHandlerMap = Record<string, ToolHandler>;

export type ThreadCreatedEvent = {
  agentName: string;
  sessionThreadId: string;
};

export type ThreadStatusName = "running" | "idle" | "terminated" | "rescheduled";

export type ThreadStatusEvent = {
  agentName: string;
  sessionThreadId: string;
  status: ThreadStatusName;
};

export type ThreadMessageEvent = {
  direction: "sent" | "received";
  /** Counter-party name for the message; null when the peer is the primary thread. */
  from?: string | null;
  preview?: string;
  sessionThreadId: string;
  to?: string | null;
};

/**
 * Hooks for surfacing the Managed Agents multi-agent thread lifecycle to the
 * caller. The session loop processes thread events itself (counted, logged,
 * etc.) but invokes these hooks so higher layers — run-events bridge,
 * dashboards — can observe coordinator/sub-agent activity without needing to
 * re-parse the raw session event stream.
 */
export type ThreadObserver = {
  onThreadCreated?(event: ThreadCreatedEvent): void;
  onThreadStatus?(event: ThreadStatusEvent): void;
  onThreadMessage?(event: ThreadMessageEvent): void;
};

export type SessionTimeouts = {
  idleGraceMs?: number;
  maxWallClockMs: number;
  streamReconnectDelayMs?: number;
  /**
   * Per-invocation wall-clock cap for a custom tool handler. When exceeded the
   * loop sends a structured error `user.custom_tool_result` instead of blocking
   * forever, so a hung handler (e.g. a stuck `create_final_pr`) cannot strand
   * the session in `requires_action`. Defaults to {@link DEFAULT_TOOL_HANDLER_TIMEOUT_MS}.
   */
  toolHandlerTimeoutMs?: number;
  /**
   * Wall-clock cap for a single `events.send` of a tool result. Sends are
   * retried up to {@link TOOL_RESULT_SEND_MAX_ATTEMPTS} times on timeout.
   * Defaults to {@link DEFAULT_TOOL_RESULT_SEND_TIMEOUT_MS}.
   */
  toolResultSendTimeoutMs?: number;
};

/**
 * Cumulative token usage for a session, aggregated by counting
 * `span.model_request_end` events emitted by the Managed Agents Beta API.
 * Always non-negative integers; zero values are legitimate (a session that
 * never reaches model inference yields all-zero usage).
 */
export type SessionUsage = {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  inputTokens: number;
  modelRequestCount: number;
  outputTokens: number;
};

export type SessionResult = {
  aborted: boolean;
  durationMs: number;
  errored: boolean;
  eventsProcessed: number;
  idleReached: boolean;
  lastEventId: string | undefined;
  /**
   * Model identifier used for cost attribution (e.g. `claude-opus-4-7`).
   * Optional because the caller may not always know the model (unit tests
   * typically omit it). Token counts still aggregate without a model; only
   * cost computation requires it.
   */
  model: string | undefined;
  sessionId: string;
  timedOut: boolean;
  toolErrors: number;
  toolInvocations: number;
  usage: SessionUsage;
};

function createEmptySessionUsage(): SessionUsage {
  return {
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    inputTokens: 0,
    modelRequestCount: 0,
    outputTokens: 0,
  };
}

export type SessionClient = {
  beta: {
    sessions: {
      events: {
        stream(sessionId: string): PromiseLike<AsyncIterable<BetaManagedAgentsStreamSessionEvents>>;
        list(
          sessionId: string,
          params?: EventListParams,
        ): AsyncIterable<BetaManagedAgentsSessionEvent>;
        send(sessionId: string, params: EventSendParams): PromiseLike<unknown>;
      };
    };
  };
};

export type RunSessionOptions = {
  handlers: ToolHandlerMap;
  logger: Logger;
  /**
   * Model identifier the session is bound to (e.g. `claude-opus-4-7`).
   * Optional because some callers (notably unit tests) do not need cost
   * attribution. When omitted, token counts still aggregate but the
   * resulting `SessionResult.model` is undefined and downstream callers
   * cannot compute USD cost.
   */
  model?: string;
  sessionId: string;
  signal?: AbortSignal;
  /**
   * Optional observer invoked when Managed Agents emits multi-agent thread
   * events. Failures inside observer callbacks are caught and logged so they
   * cannot corrupt the session loop's idle/abort accounting.
   */
  threadObserver?: ThreadObserver;
  timeouts: SessionTimeouts;
};

const ABORTED_ITERATION = Symbol("ABORTED_ITERATION");
const TIMED_OUT = Symbol("TIMED_OUT");
const MAX_CUSTOM_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_RECONNECT_ATTEMPTS = 3;
const PREVIEW_CHAR_LIMIT = 2_048;
const STREAM_RECONNECT_DELAY_MS = 500;
const DEFAULT_TOOL_HANDLER_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TOOL_RESULT_SEND_TIMEOUT_MS = 30 * 1000;
const TOOL_RESULT_SEND_MAX_ATTEMPTS = 3;
const TOOL_RESULT_SEND_RETRY_DELAY_MS = 500;
/**
 * How many times a single pending `agent.custom_tool_use` may be re-dispatched
 * from a `requires_action` idle before the loop gives up and sends a terminal
 * error result. Guards against an infinite recover→idle→recover loop when a
 * handler keeps failing or the result send keeps being rejected.
 */
const MAX_TOOL_RECOVERY_ATTEMPTS = 2;

type SessionLoopEvent = BetaManagedAgentsSessionEvent | BetaManagedAgentsStreamSessionEvents;
type PreparedToolResult = {
  isError: boolean;
  text: string;
};
type CompletedToolResult = PreparedToolResult & {
  sessionThreadId?: string;
};

class SessionReconnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionReconnectError";
  }
}

function previewAgentMessageText(event: BetaManagedAgentsAgentMessageEvent): {
  preview: string;
  truncated: boolean;
} | null {
  const messageContent = event.content;
  if (!Array.isArray(messageContent) || messageContent.length === 0) {
    return null;
  }

  const textBlocks: BetaManagedAgentsTextBlock[] = [];
  for (const contentBlock of messageContent) {
    if (contentBlock.type === "text") {
      textBlocks.push(contentBlock);
    }
  }

  if (textBlocks.length === 0) {
    return null;
  }

  const concatenatedText = textBlocks.map((textBlock) => textBlock.text).join("\n");
  if (concatenatedText.length === 0) {
    return null;
  }

  if (concatenatedText.length <= PREVIEW_CHAR_LIMIT) {
    return { preview: concatenatedText, truncated: false };
  }

  return {
    preview: `${concatenatedText.slice(0, PREVIEW_CHAR_LIMIT)}…`,
    truncated: true,
  };
}

type ThreadMessageEventLike =
  | BetaManagedAgentsAgentThreadMessageSentEvent
  | BetaManagedAgentsAgentThreadMessageReceivedEvent;

function previewThreadMessageText(event: ThreadMessageEventLike): string | undefined {
  const blocks = event.content;
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return undefined;
  }

  const textBlocks: BetaManagedAgentsTextBlock[] = [];
  for (const contentBlock of blocks) {
    if (contentBlock.type === "text") {
      textBlocks.push(contentBlock);
    }
  }

  if (textBlocks.length === 0) {
    return undefined;
  }

  const concatenatedText = textBlocks.map((textBlock) => textBlock.text).join("\n");
  if (concatenatedText.length === 0) {
    return undefined;
  }

  return concatenatedText.length <= PREVIEW_CHAR_LIMIT
    ? concatenatedText
    : `${concatenatedText.slice(0, PREVIEW_CHAR_LIMIT)}…`;
}

type ThreadStatusEventLike =
  | BetaManagedAgentsSessionThreadStatusRunningEvent
  | BetaManagedAgentsSessionThreadStatusIdleEvent
  | BetaManagedAgentsSessionThreadStatusTerminatedEvent
  | BetaManagedAgentsSessionThreadStatusRescheduledEvent;

function threadStatusName(event: ThreadStatusEventLike): ThreadStatusName {
  switch (event.type) {
    case "session.thread_status_running":
      return "running";
    case "session.thread_status_idle":
      return "idle";
    case "session.thread_status_terminated":
      return "terminated";
    case "session.thread_status_rescheduled":
      return "rescheduled";
  }
}

function safeNotifyObserver(
  logger: Logger,
  invoke: () => void,
  context: { eventId: string; eventType: string; observer: keyof ThreadObserver },
): void {
  try {
    invoke();
  } catch (error) {
    logger.warn({ err: error, ...context }, "thread observer callback failed");
  }
}

function buildHandlerErrorPayload(error: unknown) {
  if (error instanceof Error) {
    return {
      error: {
        ...(error.stack ? { stack: error.stack } : {}),
        message: error.message,
        type: "handler_error",
      },
      success: false,
    };
  }

  return {
    error: {
      message: "Handler execution failed",
      type: "handler_error",
    },
    success: false,
  };
}

function buildSerializationErrorPayload(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown serialization failure";

  return {
    error: {
      message: `Failed to serialize custom tool result: ${message}`,
      type: "serialization_error",
    },
    success: false,
  };
}

function buildUnknownToolPayload(toolName: string) {
  return {
    error: {
      message: `No handler registered for custom tool "${toolName}"`,
      type: "unknown_tool",
    },
    success: false,
  };
}

function buildHandlerTimeoutPayload(toolName: string, timeoutMs: number) {
  return {
    error: {
      message: `Custom tool "${toolName}" timed out after ${timeoutMs}ms`,
      timeoutMs,
      type: "handler_timeout",
    },
    success: false,
  };
}

function buildToolRecoveryExhaustedPayload(toolName: string, attempts: number) {
  return {
    error: {
      attempts,
      message: `Custom tool "${toolName}" could not be resolved after ${attempts} recovery attempt(s)`,
      type: "tool_recovery_exhausted",
    },
    success: false,
  };
}

function prepareToolResultPayload(
  payload: unknown,
  logger: Logger,
  eventId: string,
  toolName: string,
): PreparedToolResult {
  let serializedPayload: string | undefined;

  try {
    serializedPayload = JSON.stringify(payload);
  } catch (error) {
    return {
      isError: true,
      text: JSON.stringify(buildSerializationErrorPayload(error)),
    };
  }

  if (typeof serializedPayload !== "string") {
    return {
      isError: true,
      text: JSON.stringify(
        buildSerializationErrorPayload(new Error("JSON.stringify returned a non-string result")),
      ),
    };
  }

  const payloadSize = Buffer.byteLength(serializedPayload, "utf8");
  if (payloadSize < MAX_CUSTOM_TOOL_RESULT_BYTES) {
    return {
      isError: false,
      text: serializedPayload,
    };
  }

  logger.warn(
    { actualSize: payloadSize, eventId, sizeLimit: MAX_CUSTOM_TOOL_RESULT_BYTES, toolName },
    "custom tool result exceeded payload cap",
  );

  return {
    isError: true,
    text: JSON.stringify({
      error: {
        actualSize: payloadSize,
        message: `Handler result exceeds 64KB (was ${payloadSize} bytes)`,
        sizeLimit: MAX_CUSTOM_TOOL_RESULT_BYTES,
        type: "payload_too_large",
      },
      preview: serializedPayload.slice(0, PREVIEW_CHAR_LIMIT),
      success: false,
      truncated: true,
    }),
  };
}

async function settleAbortAwareDelay(
  signal: AbortSignal,
  waitMs: number,
): Promise<"aborted" | "completed"> {
  if (waitMs <= 0) {
    return signal.aborted ? "aborted" : "completed";
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  try {
    const winner = await Promise.race([
      new Promise<"completed">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("completed"), waitMs);
      }),
      new Promise<"aborted">((resolve) => {
        if (signal.aborted) {
          resolve("aborted");
          return;
        }

        abortListener = () => resolve("aborted");
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);

    return winner;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function nextFromIterator<TEvent>(
  iterator: AsyncIterator<TEvent>,
  signal: AbortSignal,
): Promise<IteratorResult<TEvent> | typeof ABORTED_ITERATION> {
  if (signal.aborted) {
    return ABORTED_ITERATION;
  }

  let abortListener: (() => void) | undefined;

  try {
    const nextResult = await Promise.race([
      iterator.next(),
      new Promise<typeof ABORTED_ITERATION>((resolve) => {
        abortListener = () => resolve(ABORTED_ITERATION);
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);

    return nextResult;
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

async function promiseWithAbort<TValue>(
  promiseLike: PromiseLike<TValue>,
  signal: AbortSignal,
): Promise<TValue | typeof ABORTED_ITERATION> {
  if (signal.aborted) {
    return ABORTED_ITERATION;
  }

  let abortListener: (() => void) | undefined;

  try {
    return await Promise.race([
      Promise.resolve(promiseLike),
      new Promise<typeof ABORTED_ITERATION>((resolve) => {
        abortListener = () => resolve(ABORTED_ITERATION);
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort();
    return () => {};
  }

  const abortTarget = () => target.abort();
  source.addEventListener("abort", abortTarget, { once: true });

  return () => source.removeEventListener("abort", abortTarget);
}

/**
 * Race a promise against a timeout and an abort signal. Returns the resolved
 * value, {@link TIMED_OUT} if the deadline elapses first, or
 * {@link ABORTED_ITERATION} if the signal aborts first. A non-positive timeout
 * degrades to {@link promiseWithAbort} (abort-aware, no deadline).
 *
 * Note: the underlying promise is not cancelled on timeout/abort — callers must
 * ensure abandoning it is safe (custom tool handlers may keep running in the
 * background, which is acceptable since the loop no longer awaits them).
 */
async function raceWithTimeout<TValue>(
  promiseLike: PromiseLike<TValue>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<TValue | typeof TIMED_OUT | typeof ABORTED_ITERATION> {
  if (signal.aborted) {
    return ABORTED_ITERATION;
  }

  if (timeoutMs <= 0) {
    return promiseWithAbort(promiseLike, signal);
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  try {
    return await Promise.race([
      Promise.resolve(promiseLike),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      }),
      new Promise<typeof ABORTED_ITERATION>((resolve) => {
        abortListener = () => resolve(ABORTED_ITERATION);
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

export async function runSession(
  client: SessionClient,
  options: RunSessionOptions,
): Promise<SessionResult> {
  const sessionLogger = options.logger.child({ sessionId: options.sessionId });
  const controller = new AbortController();
  const idleGraceMs = Math.max(0, options.timeouts.idleGraceMs ?? 0);
  const streamReconnectDelayMs = Math.max(
    0,
    options.timeouts.streamReconnectDelayMs ?? STREAM_RECONNECT_DELAY_MS,
  );
  const toolHandlerTimeoutMs = Math.max(
    0,
    options.timeouts.toolHandlerTimeoutMs ?? DEFAULT_TOOL_HANDLER_TIMEOUT_MS,
  );
  const toolResultSendTimeoutMs = Math.max(
    0,
    options.timeouts.toolResultSendTimeoutMs ?? DEFAULT_TOOL_RESULT_SEND_TIMEOUT_MS,
  );
  /** Per-`event_id` recovery counter to bound the requires_action recover loop. */
  const toolRecoveryAttempts = new Map<string, number>();
  const processedEventIds = new Set<string>();
  const completedToolResults = new Map<string, CompletedToolResult>();
  const resolvedToolUseIds = new Set<string>();
  const startedAt = Date.now();
  const usage = createEmptySessionUsage();

  let aborted = false;
  let errored = false;
  let eventsProcessed = 0;
  let idleReached = false;
  let lastEventId: string | undefined;
  let reconnectAttempts = 0;
  let reconnectNeedsReplay = false;
  let reconnectResetPending = false;
  let timedOut = false;
  let toolErrors = 0;
  let toolInvocations = 0;
  let toolResultSentSinceStreamStart = false;

  const handleExternalAbort = () => {
    aborted = true;
    controller.abort();
  };

  if (options.signal) {
    if (options.signal.aborted) {
      handleExternalAbort();
    } else {
      options.signal.addEventListener("abort", handleExternalAbort, { once: true });
    }
  }

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    sessionLogger.error(
      { eventsProcessed, maxWallClockMs: options.timeouts.maxWallClockMs },
      "session timeout",
    );
    controller.abort();
  }, options.timeouts.maxWallClockMs);

  function markProcessed(event: SessionLoopEvent): void {
    if (processedEventIds.has(event.id)) {
      return;
    }

    processedEventIds.add(event.id);
    lastEventId = event.id;
    eventsProcessed += 1;

    if (reconnectResetPending) {
      reconnectAttempts = 0;
      reconnectResetPending = false;
      reconnectNeedsReplay = false;
    }
  }

  function buildToolResultSendParams(
    eventId: string,
    event: BetaManagedAgentsAgentCustomToolUseEvent,
    completedResult: CompletedToolResult,
  ): EventSendParams {
    const sessionThreadId = completedResult.sessionThreadId ?? event.session_thread_id;

    return {
      events: [
        {
          content: [{ text: completedResult.text, type: "text" }],
          custom_tool_use_id: eventId,
          is_error: completedResult.isError ? true : undefined,
          // Echo the originating subagent thread id so a recovered result is
          // routed back to the correct thread (no-op for primary-thread tools).
          ...(sessionThreadId ? { session_thread_id: sessionThreadId } : {}),
          type: "user.custom_tool_result",
        },
      ],
    };
  }

  async function sendPreparedToolResult(
    event: BetaManagedAgentsAgentCustomToolUseEvent,
    completedResult: CompletedToolResult,
    eventId = event.id,
  ): Promise<boolean> {
    const params = buildToolResultSendParams(eventId, event, completedResult);
    toolResultSentSinceStreamStart = true;

    for (let attempt = 1; attempt <= TOOL_RESULT_SEND_MAX_ATTEMPTS; attempt += 1) {
      if (controller.signal.aborted) {
        return completedResult.isError;
      }

      const outcome = await raceWithTimeout(
        client.beta.sessions.events.send(options.sessionId, params),
        toolResultSendTimeoutMs,
        controller.signal,
      );

      if (outcome === ABORTED_ITERATION) {
        return completedResult.isError;
      }

      // Anything other than a timeout is a successful send.
      if (outcome !== TIMED_OUT) {
        resolvedToolUseIds.add(eventId);
        return completedResult.isError;
      }

      sessionLogger.warn(
        {
          attempt,
          eventId,
          maxAttempts: TOOL_RESULT_SEND_MAX_ATTEMPTS,
          timeoutMs: toolResultSendTimeoutMs,
          toolName: event.name,
        },
        "tool result send timed out; retrying",
      );

      if (
        attempt < TOOL_RESULT_SEND_MAX_ATTEMPTS &&
        (await settleAbortAwareDelay(controller.signal, TOOL_RESULT_SEND_RETRY_DELAY_MS)) ===
          "aborted"
      ) {
        return completedResult.isError;
      }
    }

    // Exhausted retries: surface as a reconnect so the requires_action idle path
    // can re-attempt recovery (bounded by MAX_TOOL_RECOVERY_ATTEMPTS) instead of
    // silently stranding the session.
    sessionLogger.error(
      { eventId: event.id, toolName: event.name },
      "tool result send failed after retries; forcing reconnect",
    );
    throw new SessionReconnectError(`Failed to send custom tool result for ${event.name}`);
  }

  async function sendToolResult(
    event: BetaManagedAgentsAgentCustomToolUseEvent,
    payload: unknown,
    forceError = false,
  ): Promise<boolean> {
    const preparedPayload = prepareToolResultPayload(payload, sessionLogger, event.id, event.name);
    const completedResult: CompletedToolResult = {
      isError: forceError || preparedPayload.isError,
      ...(event.session_thread_id ? { sessionThreadId: event.session_thread_id } : {}),
      text: preparedPayload.text,
    };
    completedToolResults.set(event.id, completedResult);

    return await sendPreparedToolResult(event, completedResult);
  }

  async function resendCompletedToolResult(
    eventId: string,
    event: BetaManagedAgentsAgentCustomToolUseEvent,
  ): Promise<boolean> {
    const completedResult = completedToolResults.get(eventId);
    if (!completedResult) {
      return false;
    }

    sessionLogger.warn(
      { eventId, toolName: event.name },
      "resending cached custom tool result without rerunning handler",
    );
    return await sendPreparedToolResult(event, completedResult, eventId);
  }

  async function dispatchToolUse(event: BetaManagedAgentsAgentCustomToolUseEvent): Promise<void> {
    if (resolvedToolUseIds.has(event.id)) {
      markProcessed(event);
      return;
    }

    if (completedToolResults.has(event.id)) {
      await resendCompletedToolResult(event.id, event);
      return;
    }

    toolInvocations += 1;

    const handler = options.handlers[event.name];
    if (!handler) {
      toolErrors += 1;
      await sendToolResult(event, buildUnknownToolPayload(event.name), true);
      return;
    }

    let handlerOutput: unknown;
    const handlerController = new AbortController();
    const unlinkHandlerAbort = linkAbortSignal(controller.signal, handlerController);
    try {
      const outcome = await raceWithTimeout(
        handler(event.input, { signal: handlerController.signal }),
        toolHandlerTimeoutMs,
        controller.signal,
      );

      if (outcome === ABORTED_ITERATION) {
        handlerController.abort();
        // Session is aborting; skip sending a tool result after cancellation.
        return;
      }

      if (outcome === TIMED_OUT) {
        handlerController.abort();
        toolErrors += 1;
        sessionLogger.error(
          { eventId: event.id, timeoutMs: toolHandlerTimeoutMs, toolName: event.name },
          "custom tool handler timed out; sending error result",
        );
        await sendToolResult(
          event,
          buildHandlerTimeoutPayload(event.name, toolHandlerTimeoutMs),
          true,
        );
        return;
      }

      handlerOutput = outcome;
    } catch (error) {
      toolErrors += 1;
      sessionLogger.error(
        { err: error, eventId: event.id, toolName: event.name },
        "handler failed",
      );
      await sendToolResult(event, buildHandlerErrorPayload(error), true);
      return;
    } finally {
      unlinkHandlerAbort();
    }

    // Sent outside the try so a send failure surfaces as a reconnect (handled by
    // sendToolResult) rather than being swallowed and re-sent as a handler error.
    const sendWasError = await sendToolResult(event, handlerOutput);
    if (sendWasError) {
      toolErrors += 1;
    }
  }

  /**
   * Resolve custom tool uses the session is blocked on after a
   * `requires_action` idle. For each blocked `event_id` that has no
   * `user.custom_tool_result` yet, the originating `agent.custom_tool_use` is
   * resolved by resending a cached terminal result when the handler already
   * completed, or re-dispatched only when no cached result exists. This recovers
   * the case where a tool use was missed by the live stream (reconnect race) or
   * its earlier dispatch hung. Bounded by
   * {@link MAX_TOOL_RECOVERY_ATTEMPTS} per event to avoid an infinite
   * recover→idle→recover loop.
   */
  async function recoverPendingToolUses(
    eventIds: ReadonlyArray<string>,
  ): Promise<"resolved" | "none" | "aborted"> {
    if (eventIds.length === 0) {
      return "none";
    }

    const wanted = new Set(eventIds);
    const pendingToolUses = new Map<string, BetaManagedAgentsAgentCustomToolUseEvent>();
    const historyResolvedToolUseIds = new Set<string>();

    const iterator = client.beta.sessions.events
      .list(options.sessionId, { order: "asc" })
      [Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await nextFromIterator(iterator, controller.signal);
        if (next === ABORTED_ITERATION) {
          return "aborted";
        }
        if (next.done) {
          break;
        }

        const candidate = next.value;
        if (candidate.type === "agent.custom_tool_use" && wanted.has(candidate.id)) {
          pendingToolUses.set(candidate.id, candidate);
        } else if (candidate.type === "user.custom_tool_result") {
          historyResolvedToolUseIds.add(candidate.custom_tool_use_id);
          resolvedToolUseIds.add(candidate.custom_tool_use_id);
        }
      }
    } finally {
      await closeIterator(iterator);
    }

    let resolvedAny = false;
    for (const eventId of eventIds) {
      if (controller.signal.aborted) {
        return "aborted";
      }

      if (historyResolvedToolUseIds.has(eventId)) {
        // A result already exists for this tool use; nothing to recover.
        continue;
      }

      const toolUse = pendingToolUses.get(eventId);
      if (!toolUse) {
        // Blocked on something we cannot resolve here (e.g. a tool confirmation).
        continue;
      }

      const priorAttempts = toolRecoveryAttempts.get(eventId) ?? 0;
      if (priorAttempts >= MAX_TOOL_RECOVERY_ATTEMPTS) {
        toolRecoveryAttempts.set(eventId, priorAttempts + 1);
        sessionLogger.error(
          { attempts: priorAttempts, eventId, toolName: toolUse.name },
          "pending custom tool recovery exhausted; sending terminal error result",
        );
        await sendToolResult(
          toolUse,
          buildToolRecoveryExhaustedPayload(toolUse.name, priorAttempts),
          true,
        );
        markProcessed(toolUse);
        resolvedAny = true;
        continue;
      }

      toolRecoveryAttempts.set(eventId, priorAttempts + 1);
      sessionLogger.warn(
        { attempt: priorAttempts + 1, eventId, toolName: toolUse.name },
        "recovering pending custom tool result after requires_action idle",
      );

      if (completedToolResults.has(eventId)) {
        await resendCompletedToolResult(eventId, toolUse);
        markProcessed(toolUse);
        resolvedAny = true;
        continue;
      }

      await dispatchToolUse(toolUse);
      markProcessed(toolUse);
      resolvedAny = true;
    }

    return resolvedAny ? "resolved" : "none";
  }

  async function processEvent(event: SessionLoopEvent): Promise<"continue" | "stop"> {
    sessionLogger.debug({ eventId: event.id, eventType: event.type }, "event received");

    if (processedEventIds.has(event.id)) {
      return "continue";
    }

    if (event.type === "session.error") {
      markProcessed(event);

      const sessionError = event.error;
      // MCP connection/auth failures are NOT recoverable by reconnecting the
      // event stream — they originate in the MCP layer, frequently from an
      // optional/supplementary server (wiki, design tool, etc.) that is
      // misconfigured or transiently down. Treating them as fatal here tore
      // down otherwise-healthy sessions (e.g. a placeholder MCP URL returning
      // 502 racing a `create_final_pr`, stranding the run). Log and continue so
      // the agent can adapt: retry the tool, fall back, or surface the failure
      // in its own result. Required-server failures still surface to the agent
      // as failing tool calls, which it handles far better than a teardown.
      if (
        sessionError.type === "mcp_connection_failed_error" ||
        sessionError.type === "mcp_authentication_failed_error"
      ) {
        sessionLogger.warn(
          {
            errorType: sessionError.type,
            eventId: event.id,
            mcpServerName: sessionError.mcp_server_name,
            retryStatus: sessionError.retry_status.type,
          },
          "non-fatal MCP error; continuing session without reconnect",
        );
        return controller.signal.aborted ? "stop" : "continue";
      }

      sessionLogger.error({ err: event.error, eventId: event.id }, "session error event received");
      throw new SessionReconnectError(event.error.message);
    }

    if (event.type === "agent.message") {
      const messagePreview = previewAgentMessageText(event);
      if (messagePreview !== null) {
        sessionLogger.info(
          {
            eventId: event.id,
            preview: messagePreview.preview,
            previewCharLimit: PREVIEW_CHAR_LIMIT,
            truncated: messagePreview.truncated,
          },
          "agent message",
        );
      }
      markProcessed(event);
      return controller.signal.aborted ? "stop" : "continue";
    }

    if (event.type === "agent.custom_tool_use") {
      await dispatchToolUse(event);
      markProcessed(event);
      return controller.signal.aborted ? "stop" : "continue";
    }

    if (event.type === "user.custom_tool_result") {
      resolvedToolUseIds.add(event.custom_tool_use_id);
      markProcessed(event);
      return controller.signal.aborted ? "stop" : "continue";
    }

    if (event.type === "session.thread_created") {
      sessionLogger.info(
        {
          agentName: event.agent_name,
          eventId: event.id,
          sessionThreadId: event.session_thread_id,
        },
        "session thread created",
      );

      if (options.threadObserver?.onThreadCreated) {
        const observer = options.threadObserver;
        safeNotifyObserver(
          sessionLogger,
          () =>
            observer.onThreadCreated?.({
              agentName: event.agent_name,
              sessionThreadId: event.session_thread_id,
            }),
          { eventId: event.id, eventType: event.type, observer: "onThreadCreated" },
        );
      }

      markProcessed(event);
      return controller.signal.aborted ? "stop" : "continue";
    }

    if (
      event.type === "session.thread_status_running" ||
      event.type === "session.thread_status_idle" ||
      event.type === "session.thread_status_terminated" ||
      event.type === "session.thread_status_rescheduled"
    ) {
      const status = threadStatusName(event);
      sessionLogger.info(
        {
          agentName: event.agent_name,
          eventId: event.id,
          sessionThreadId: event.session_thread_id,
          status,
        },
        "session thread status",
      );

      if (options.threadObserver?.onThreadStatus) {
        const observer = options.threadObserver;
        safeNotifyObserver(
          sessionLogger,
          () =>
            observer.onThreadStatus?.({
              agentName: event.agent_name,
              sessionThreadId: event.session_thread_id,
              status,
            }),
          { eventId: event.id, eventType: event.type, observer: "onThreadStatus" },
        );
      }

      markProcessed(event);
      return controller.signal.aborted ? "stop" : "continue";
    }

    if (event.type === "agent.thread_message_sent") {
      const preview = previewThreadMessageText(event);
      sessionLogger.info(
        {
          eventId: event.id,
          preview,
          sessionThreadId: event.to_session_thread_id,
          to: event.to_agent_name ?? null,
        },
        "thread message sent",
      );

      if (options.threadObserver?.onThreadMessage) {
        const observer = options.threadObserver;
        safeNotifyObserver(
          sessionLogger,
          () =>
            observer.onThreadMessage?.({
              direction: "sent",
              ...(typeof preview === "string" ? { preview } : {}),
              sessionThreadId: event.to_session_thread_id,
              to: event.to_agent_name ?? null,
            }),
          { eventId: event.id, eventType: event.type, observer: "onThreadMessage" },
        );
      }

      markProcessed(event);
      return controller.signal.aborted ? "stop" : "continue";
    }

    if (event.type === "agent.thread_message_received") {
      const preview = previewThreadMessageText(event);
      sessionLogger.info(
        {
          eventId: event.id,
          from: event.from_agent_name ?? null,
          preview,
          sessionThreadId: event.from_session_thread_id,
        },
        "thread message received",
      );

      if (options.threadObserver?.onThreadMessage) {
        const observer = options.threadObserver;
        safeNotifyObserver(
          sessionLogger,
          () =>
            observer.onThreadMessage?.({
              direction: "received",
              from: event.from_agent_name ?? null,
              ...(typeof preview === "string" ? { preview } : {}),
              sessionThreadId: event.from_session_thread_id,
            }),
          { eventId: event.id, eventType: event.type, observer: "onThreadMessage" },
        );
      }

      markProcessed(event);
      return controller.signal.aborted ? "stop" : "continue";
    }

    if (event.type === "span.model_request_end") {
      const modelUsage = event.model_usage;
      usage.inputTokens += modelUsage.input_tokens;
      usage.outputTokens += modelUsage.output_tokens;
      usage.cacheCreationInputTokens += modelUsage.cache_creation_input_tokens;
      usage.cacheReadInputTokens += modelUsage.cache_read_input_tokens;
      usage.modelRequestCount += 1;
      markProcessed(event);
      return controller.signal.aborted ? "stop" : "continue";
    }

    if (event.type === "session.status_idle") {
      markProcessed(event);

      if (toolResultSentSinceStreamStart) {
        sessionLogger.debug({ eventId: event.id }, "idle after tool result; reopening stream");
        return "stop";
      }

      // The session is blocking on one or more client-input events (typically a
      // custom tool result). Resolve any we missed/hung on before treating idle
      // as terminal — otherwise a single dropped result strands the run.
      if (event.stop_reason.type === "requires_action") {
        const recovery = await recoverPendingToolUses(event.stop_reason.event_ids);
        if (recovery === "aborted") {
          return "stop";
        }
        if (recovery === "resolved") {
          // Reopen the stream so the resumed session's events are consumed.
          sessionLogger.debug(
            { eventId: event.id },
            "recovered pending tool result(s); reopening stream",
          );
          return "stop";
        }
        // recovery === "none": nothing recoverable here; fall through.
      }

      if ((await settleAbortAwareDelay(controller.signal, idleGraceMs)) === "aborted") {
        return "stop";
      }

      idleReached = true;
      return "stop";
    }

    markProcessed(event);
    return controller.signal.aborted ? "stop" : "continue";
  }

  async function closeIterator<TEvent>(iterator: AsyncIterator<TEvent>): Promise<void> {
    if (!iterator.return) {
      return;
    }

    try {
      await iterator.return();
    } catch (closeError) {
      sessionLogger.debug({ err: closeError }, "iterator.return() failed; best-effort cleanup");
    }
  }

  async function consumeIterable(
    iterable: AsyncIterable<SessionLoopEvent>,
  ): Promise<"continue" | "stop"> {
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      while (true) {
        const nextResult = await nextFromIterator(iterator, controller.signal);
        if (nextResult === ABORTED_ITERATION) {
          return "stop";
        }

        if (nextResult.done) {
          return "continue";
        }

        const processOutcome = await processEvent(nextResult.value);
        if (processOutcome === "stop") {
          return "stop";
        }
      }
    } finally {
      await closeIterator(iterator);
    }
  }

  async function consumeReplayIterable(
    iterable: AsyncIterable<SessionLoopEvent>,
  ): Promise<"continue" | "stop"> {
    const iterator = iterable[Symbol.asyncIterator]();
    const replayedEvents: SessionLoopEvent[] = [];

    try {
      while (true) {
        const nextResult = await nextFromIterator(iterator, controller.signal);
        if (nextResult === ABORTED_ITERATION) {
          return "stop";
        }

        if (nextResult.done) {
          break;
        }

        replayedEvents.push(nextResult.value);
      }
    } finally {
      await closeIterator(iterator);
    }

    for (const event of replayedEvents) {
      if (event.type === "user.custom_tool_result") {
        resolvedToolUseIds.add(event.custom_tool_use_id);
      }
    }

    for (const event of replayedEvents) {
      const processOutcome = await processEvent(event);
      if (processOutcome === "stop") {
        return "stop";
      }
    }

    return "continue";
  }

  try {
    while (!controller.signal.aborted && !idleReached && !errored) {
      try {
        if (reconnectNeedsReplay && lastEventId) {
          const replayOutcome = await consumeReplayIterable(
            client.beta.sessions.events.list(options.sessionId),
          );
          reconnectNeedsReplay = false;

          if (replayOutcome === "stop" && (idleReached || controller.signal.aborted)) {
            break;
          }
        } else if (reconnectNeedsReplay) {
          reconnectNeedsReplay = false;
        }

        if (controller.signal.aborted || idleReached) {
          break;
        }

        const stream = await promiseWithAbort(
          client.beta.sessions.events.stream(options.sessionId),
          controller.signal,
        );
        if (stream === ABORTED_ITERATION) {
          break;
        }

        toolResultSentSinceStreamStart = false;
        const streamOutcome = await consumeIterable(stream);
        if (streamOutcome === "stop" && (idleReached || controller.signal.aborted)) {
          break;
        }

        if (streamOutcome === "stop") {
          continue;
        }

        reconnectAttempts += 1;
        reconnectNeedsReplay = true;
        reconnectResetPending = true;
        sessionLogger.warn(
          { attempt: reconnectAttempts, lastEventId, streamReconnectDelayMs },
          "session event stream ended before idle; reconnecting",
        );
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          sessionLogger.error(
            { attempts: reconnectAttempts, lastEventId },
            "stream reconnect attempts exhausted after clean stream close",
          );
          errored = true;
          break;
        }

        if (
          (await settleAbortAwareDelay(controller.signal, streamReconnectDelayMs)) === "aborted"
        ) {
          break;
        }
      } catch (error) {
        if (controller.signal.aborted) {
          break;
        }

        reconnectAttempts += 1;
        reconnectNeedsReplay = true;
        reconnectResetPending = true;

        sessionLogger.warn({ attempt: reconnectAttempts, lastEventId }, "stream reconnect");
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          sessionLogger.error(
            { attempts: reconnectAttempts, err: error, lastEventId },
            "stream reconnect attempts exhausted",
          );
          errored = true;
          break;
        }
      }
    }
  } finally {
    clearTimeout(timeoutHandle);

    if (options.signal) {
      options.signal.removeEventListener("abort", handleExternalAbort);
    }
  }

  return {
    aborted,
    durationMs: Date.now() - startedAt,
    errored,
    eventsProcessed,
    idleReached,
    lastEventId,
    model: options.model,
    sessionId: options.sessionId,
    timedOut,
    toolErrors,
    toolInvocations,
    usage,
  };
}
