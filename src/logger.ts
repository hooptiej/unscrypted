/**
 * Tiny leveled logger. No dependency — keeps the image small.
 * Level is controlled by the UNSCRYPTED_LOG_LEVEL env var or config.logLevel.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel =
  (process.env.UNSCRYPTED_LOG_LEVEL as LogLevel | undefined) ?? "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function ts(): string {
  return new Date().toISOString();
}

function emit(level: LogLevel, scope: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) {
    return;
  }
  const prefix = `[${ts()}] [${level.toUpperCase()}] [${scope}]`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  stream(prefix, ...args);
}

export class Logger {
  constructor(private readonly scope: string) {}

  child(sub: string): Logger {
    return new Logger(`${this.scope}:${sub}`);
  }

  debug(...args: unknown[]): void {
    emit("debug", this.scope, args);
  }
  info(...args: unknown[]): void {
    emit("info", this.scope, args);
  }
  warn(...args: unknown[]): void {
    emit("warn", this.scope, args);
  }
  error(...args: unknown[]): void {
    emit("error", this.scope, args);
  }
}

export const rootLogger = new Logger("unscrypted");
