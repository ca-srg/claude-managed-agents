import pino, { type Logger, type LoggerOptions } from "pino";
import { v7 as uuidv7 } from "uuid";

const REDACT_CENSOR = "[REDACTED]";
const REDACT_PATHS = [
  "github_token",
  "authorization",
  "api_key",
  "*.github_token",
  "*.authorization",
  "*.api_key",
  "headers.authorization",
  "Bearer",
] as const;
const TOKEN_PATTERNS = [
  /(?:ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9]{36,}/g,
  /sk-ant-[A-Za-z0-9_-]+/g,
] as const;

export type CreateLoggerOptions = {
  level?: string;
  logFile?: string;
};

function maskSecretTokens(value: string): string {
  return TOKEN_PATTERNS.reduce(
    (sanitizedValue, tokenPattern) => sanitizedValue.replace(tokenPattern, REDACT_CENSOR),
    value,
  );
}

function sanitizeLogValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") {
    return maskSecretTokens(value);
  }

  if (Array.isArray(value)) {
    return value.map((element) => sanitizeLogValue(element, seen));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date || value instanceof RegExp || value instanceof URL) {
    return value;
  }

  const existingValue = seen.get(value);
  if (existingValue) {
    return existingValue;
  }

  const sanitizedRecord: Record<string, unknown> = {};
  seen.set(value, sanitizedRecord);

  if (value instanceof Error) {
    sanitizedRecord.name = value.name;
    sanitizedRecord.message = maskSecretTokens(value.message);
    if (value.stack) {
      sanitizedRecord.stack = maskSecretTokens(value.stack);
    }
  }

  for (const [recordKey, recordValue] of Object.entries(value)) {
    sanitizedRecord[recordKey] = sanitizeLogValue(recordValue, seen);
  }

  return sanitizedRecord;
}

function createDestination(logFile?: string) {
  if (!logFile) {
    return undefined;
  }

  return pino.multistream([
    { stream: process.stdout },
    {
      stream: pino.destination({ dest: logFile, mkdir: true, sync: true }),
    },
  ]);
}

function createLoggerOptions(level?: string): LoggerOptions {
  return {
    hooks: {
      logMethod(args, method) {
        const sanitizedArgs = args.map((arg) =>
          typeof arg === "string" ? maskSecretTokens(arg) : arg,
        ) as Parameters<typeof method>;

        method.apply(this, sanitizedArgs);
      },
    },
    formatters: {
      log(object) {
        return sanitizeLogValue(object) as Record<string, unknown>;
      },
    },
    level: level ?? "info",
    messageKey: "msg",
    redact: {
      censor: REDACT_CENSOR,
      paths: [...REDACT_PATHS],
    },
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  };
}

export function createRunId(): string {
  return uuidv7();
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const destination = createDestination(opts.logFile);
  const baseLogger = destination
    ? pino(createLoggerOptions(opts.level), destination)
    : pino(createLoggerOptions(opts.level));

  return baseLogger.child({ runId: createRunId() });
}

export function attachTaskLogger(logger: Logger, taskId: string): Logger {
  return logger.child({ taskId });
}
