import type { Logger } from "pino";

import type { createRunEventsModule } from "@/shared/run-events";
import type { RunExecutionObservers } from "./handler";

type RunEventsModule = Pick<ReturnType<typeof createRunEventsModule>, "emit">;
type EmitRunEventInput = Parameters<RunEventsModule["emit"]>[1];

type RunEventsBridgeInput = {
  logger?: Logger;
  runEvents: RunEventsModule;
  runId: string;
};

type RunEventsBridgeObservers = Required<
  Pick<RunExecutionObservers, "onLog" | "onPhase" | "onSession" | "onSubIssue">
>;

function emitRunEvent(input: {
  event: EmitRunEventInput;
  logger?: Logger;
  runEvents: RunEventsModule;
  runId: string;
}): void {
  try {
    input.runEvents.emit(input.runId, input.event);
  } catch (error) {
    input.logger?.warn(
      { err: error, kind: input.event.kind, runId: input.runId },
      "failed to emit run event",
    );
  }
}

export function createRunEventsBridge({
  logger,
  runEvents,
  runId,
}: RunEventsBridgeInput): RunExecutionObservers {
  const emit = (event: EmitRunEventInput): void => {
    emitRunEvent({ event, logger, runEvents, runId });
  };

  const bridge = {
    onLog(level, msg, fields) {
      const payload: { fields?: Record<string, unknown>; level: typeof level; msg: string } = {
        level,
        msg,
      };
      if (fields !== undefined) {
        payload.fields = fields;
      }

      emit({
        kind: "log",
        payload,
      });
    },
    onPhase(phase, details) {
      const payload: { details?: unknown; phase: typeof phase } = { phase };
      if (details !== undefined) {
        payload.details = details;
      }

      emit({
        kind: "phase",
        payload,
      });
    },
    onSession(event) {
      // session のライフサイクル通知 (created / prompt_sent / completed) を run-events として永続化する。
      // SSE エンドポイントはこの payload.kind を見て、後から作られた child session の
      // events stream を動的に追加する。
      const payload: { details?: unknown; kind: string; sessionId: string } = {
        kind: event.kind,
        sessionId: event.sessionId,
      };
      if (event.payload !== undefined) {
        payload.details = event.payload;
      }

      emit({
        kind: "session",
        payload,
      });
    },
    onSubIssue(event) {
      emit({
        kind: "subIssue",
        payload: event.payload,
      });
    },
  } satisfies RunEventsBridgeObservers;

  return bridge;
}
