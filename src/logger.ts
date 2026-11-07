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

/**
 * Turn a raw level (env var, config value) into a LogLevel. Unset/empty gives "info" quietly;
 * an unknown value (say "verbose") also gives "info" but warns once, naming the bad value, so a
 * typo can't silently turn logging off or on.
 */
export function parseLogLevel(v: unknown): LogLevel {
  if (v === undefined || v === null || v === "") {
    return "info";
  }
  const s = String(v).trim().toLowerCase();
  if (s in LEVEL_ORDER) {
    return s as LogLevel;
  }
  console.error(
    `[${ts()}] [WARN] [unscrypted:logger] unknown log level "${String(v)}"; using "info". ` +
      `Valid levels: ${Object.keys(LEVEL_ORDER).join(", ")}.`,
  );
  return "info";
}

let currentLevel: LogLevel = parseLogLevel(process.env.UNSCRYPTED_LOG_LEVEL);

export function setLogLevel(level: LogLevel): void {
  currentLevel = parseLogLevel(level);
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
