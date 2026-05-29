import type {
  BetaManagedAgentsSessionEvent,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type { Logger } from "pino";

import {
  LIVE_TAIL_HEARTBEAT_INTERVAL_MS,
  LIVE_TAIL_HISTORY_PAGE_SIZE,
} from "@/shared/run-events/constants";
import type { SessionClient } from "@/shared/session";

export type LiveTailPayload =
  | { event: BetaManagedAgentsSessionEvent; phase: "history" }
  | { event: BetaManagedAgentsStreamSessionEvents; phase: "live" }
  | { phase: "end"; reason: "idle" | "stream-completed" }
  | { message: string; phase: "error" };

export type CreateLiveTailStreamOptions = {
  client: SessionClient;
  logger?: Logger;
  sessionId: string;
  signal: AbortSignal;
  heartbeatIntervalMs?: number;
  historyPageSize?: number;
};

function formatSseData(payload: LiveTailPayload): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function safeCloseController(controller: ReadableStreamDefaultController<Uint8Array>): void {
  try {
    controller.close();
  } catch {
    return;
  }
}

function safeEnqueue(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  text: string,
): boolean {
  try {
    controller.enqueue(encoder.encode(text));
    return true;
  } catch {
    return false;
  }
}

export function createLiveTailStream(
  options: CreateLiveTailStreamOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? LIVE_TAIL_HEARTBEAT_INTERVAL_MS;
  const historyPageSize = options.historyPageSize ?? LIVE_TAIL_HISTORY_PAGE_SIZE;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const seenEventIds = new Set<string>();
      let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
      let abortListener: (() => void) | undefined;
      let streamClosed = false;

      const closeStream = () => {
        if (streamClosed) {
          return;
        }
        streamClosed = true;

        if (heartbeatHandle !== undefined) {
          clearInterval(heartbeatHandle);
          heartbeatHandle = undefined;
        }

        if (abortListener !== undefined) {
          options.signal.removeEventListener("abort", abortListener);
          abortListener = undefined;
        }

        safeCloseController(controller);
      };

      const sendPayload = (payload: LiveTailPayload): boolean => {
        if (streamClosed) {
          return false;
        }
        return safeEnqueue(controller, encoder, formatSseData(payload));
      };

      if (options.signal.aborted) {
        closeStream();
        return;
      }

      abortListener = () => {
        closeStream();
      };
      options.signal.addEventListener("abort", abortListener, { once: true });

      heartbeatHandle = setInterval(() => {
        if (streamClosed) {
          return;
        }
        safeEnqueue(controller, encoder, ": heartbeat\n\n");
      }, heartbeatIntervalMs);

      try {
        for await (const historyEvent of options.client.beta.sessions.events.list(
          options.sessionId,
          { limit: historyPageSize, order: "asc" },
        )) {
          if (streamClosed || options.signal.aborted) {
            return;
          }
          seenEventIds.add(historyEvent.id);
          if (!sendPayload({ event: historyEvent, phase: "history" })) {
            return;
          }
        }

        if (streamClosed || options.signal.aborted) {
          return;
        }

        const liveStream = await options.client.beta.sessions.events.stream(options.sessionId);
        for await (const liveEvent of liveStream) {
          if (streamClosed || options.signal.aborted) {
            return;
          }
          if (seenEventIds.has(liveEvent.id)) {
            continue;
          }
          seenEventIds.add(liveEvent.id);
          if (!sendPayload({ event: liveEvent, phase: "live" })) {
            return;
          }

          if (liveEvent.type === "session.status_idle") {
            sendPayload({ phase: "end", reason: "idle" });
            return;
          }
        }

        sendPayload({ phase: "end", reason: "stream-completed" });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "live tail stream failed";
        options.logger?.warn(
          { err: error, sessionId: options.sessionId },
          "live tail stream error",
        );
        sendPayload({ message: errorMessage, phase: "error" });
      } finally {
        closeStream();
      }
    },
    cancel() {
      return;
    },
  });
}
