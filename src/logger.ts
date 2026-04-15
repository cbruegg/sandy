type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

type LoggerConfig = {
  minLevel: LogLevel;
  // "split" keeps info/debug on stdout and warn/error on stderr for normal app logs.
  // "stderr" forces all logs to stderr for processes that reserve stdout for protocols.
  outputMode: "split" | "stderr";
};

class SandyLogger {
  private config: LoggerConfig = {
    minLevel: "info",
    outputMode: "split",
  };

  configure(config: Partial<LoggerConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

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

  debugContent(event: string, data?: Record<string, unknown>): void {
    if (this.config.minLevel !== "debug") {
      return;
    }
    this.write("debug", event, data);
  }

  private write(level: LogLevel, event: string, data?: Record<string, unknown>): void {
    if (levelPriority[level] < levelPriority[this.config.minLevel]) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...(data ? { data } : {}),
    };

    const line = JSON.stringify(payload);
    if (this.config.outputMode === "stderr" || level === "error" || level === "warn") {
      console.error(line);
      return;
    }
    console.log(line);
  }
}

export const logger = new SandyLogger();

export function configureLogger(config: Partial<LoggerConfig>): void {
  logger.configure(config);
}
