type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

type LoggerConfig = {
  minLevel: LogLevel;
  debugContentEnabled: boolean;
};

class SandyLogger {
  private config: LoggerConfig = {
    minLevel: "info",
    debugContentEnabled: false,
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
    if (!this.config.debugContentEnabled) {
      return;
    }
    this.write("info", event, data);
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
    if (level === "error" || level === "warn") {
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
