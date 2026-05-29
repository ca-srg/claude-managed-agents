import type { RunEvent, RunEventKind } from "@/shared/types";

export type RunFailure = {
  message: string;
  type?: string;
};

export function failureFromRunEvents(events: readonly RunEvent[]): RunFailure | undefined {
  const errorEvent = latestEventOfKind(events, "error");
  const errorFailure = errorEvent ? failureFromPayload(errorEvent.payload) : undefined;
  if (errorFailure !== undefined) {
    return errorFailure;
  }

  const completeEvent = latestEventOfKind(events, "complete");
  return completeEvent ? failureFromCompletePayload(completeEvent.payload) : undefined;
}

function latestEventOfKind(events: readonly RunEvent[], kind: RunEventKind): RunEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === kind) {
      return event;
    }
  }

  return undefined;
}

function failureFromCompletePayload(payload: unknown): RunFailure | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const erroredFailure = failureFromPayload(payload.errored);
  return erroredFailure ?? failureFromPayload(payload.error);
}

function failureFromPayload(payload: unknown): RunFailure | undefined {
  if (typeof payload === "string") {
    return failureWithMessage(payload);
  }

  if (!isRecord(payload)) {
    return undefined;
  }

  const message = payload.message;
  if (typeof message === "string") {
    const failure = failureWithMessage(message);
    if (failure === undefined) {
      return undefined;
    }

    const type = payload.type;
    return typeof type === "string" && type.trim().length > 0
      ? { ...failure, type: type.trim() }
      : failure;
  }

  return failureFromPayload(payload.error);
}

function failureWithMessage(message: string): RunFailure | undefined {
  const trimmedMessage = message.trim();
  return trimmedMessage.length > 0 ? { message: trimmedMessage } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
