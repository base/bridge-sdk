export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

export interface LoggerOptions {
  level?: LogLevel;
  namespace?: string;
  transport?: (
    level: LogLevel,
    message: string,
    ctx?: Record<string, unknown>
  ) => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const defaultTransport: LoggerOptions["transport"] = (
  level,
  message,
  context
) => {
  const payload = context ? `${message} ${JSON.stringify(context)}` : message;
  console[level === "debug" ? "log" : level](
    `[bridge-sdk:${level}] ${payload}`
  );
};

export const createLogger = (options: LoggerOptions = {}): Logger => {
  const {
    level = "info",
    namespace = "core",
    transport = defaultTransport,
  } = options;

  const shouldLog = (targetLevel: LogLevel) =>
    LEVEL_ORDER[targetLevel] >= LEVEL_ORDER[level];

  const log =
    (targetLevel: LogLevel) =>
    (message: string, context?: Record<string, unknown>) => {
      if (!shouldLog(targetLevel)) {
        return;
      }

      const namespacedContext = {
        namespace,
        ...context,
      };

      transport(targetLevel, message, namespacedContext);
    };

  return {
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
};
