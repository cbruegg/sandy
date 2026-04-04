type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLogLevel(): LogLevel {
  const configured = process.env.SANDY_LOG_LEVEL?.toLowerCase();
  if (configured === "debug" || configured === "info" || configured === "warn" || configured === "error") {
    return configured;
  }
  return "info";
}

class SandyLogger {
  private readonly minLevel = resolveLogLevel();

  debug(event: string, data?: Record<string, unknown>): void {
    this.write("debug", event, data);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.write("info", event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.write("warn", event, data);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.write("error", event, data);
  }

  private write(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    if (levelPriority[level] < levelPriority[this.minLevel]) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...(data ? { data } : {}),
    };

    const line = JSON.stringify(payload);
    if (level === "error" || level === "warn") {
      console.error(line);
      return;
    }
    console.log(line);
  }
}

export const logger = new SandyLogger();
