type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLevel(): LogLevel {
  const configured = process.env.LOG_LEVEL?.toLowerCase();
  if (configured && configured in LEVEL_WEIGHT) {
    return configured as LogLevel;
  }
  return "info";
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}

function write(level: LogLevel, message: string, context: Record<string, unknown>) {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[resolveLevel()]) return;

  const entry = JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  });

  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

export const logger = {
  debug: (message: string, context: Record<string, unknown> = {}) =>
    write("debug", message, context),
  info: (message: string, context: Record<string, unknown> = {}) =>
    write("info", message, context),
  warn: (message: string, context: Record<string, unknown> = {}) =>
    write("warn", message, context),
  error: (message: string, context: Record<string, unknown> = {}) =>
    write("error", message, context),
};
