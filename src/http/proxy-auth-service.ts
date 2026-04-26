import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../logger.js";

type ProxyAuthServiceOptions = {
  socketPath: string;
  authorize: (input: {
    taskId: string;
    tokenId: string;
    host: string;
  }) => Promise<{ outcome: "approved" | "denied" | "failed"; message: string }>;
};

export class ProxyAuthService {
  private server: Server | null = null;

  constructor(private readonly options: ProxyAuthServiceOptions) {}

  async start(): Promise<void> {
    const socketPath = this.options.socketPath;
    const directory = dirname(socketPath);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    this.server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          try {
            const request = JSON.parse(line) as {
              taskId: string;
              tokenId: string;
              host: string;
            };
            this.options
              .authorize(request)
              .then((result) => {
                socket.write(`${JSON.stringify(result)}\n`);
              })
              .catch((error) => {
                socket.write(
                  `${JSON.stringify({
                    outcome: "failed" as const,
                    message:
                      error instanceof Error
                        ? error.message
                        : "Authorization service error.",
                  })}\n`,
                );
              });
          } catch {
            socket.write(
              `${JSON.stringify({
                outcome: "failed" as const,
                message: "Invalid authorization request format.",
              })}\n`,
            );
          }
        }
      });

      socket.on("error", (error) => {
        logger.warn("proxy_auth.socket_error", {
          message: error.message,
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, () => {
        this.server!.off("error", reject);
        logger.info("proxy_auth.service_started", { socketPath });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    if (existsSync(this.options.socketPath)) {
      unlinkSync(this.options.socketPath);
    }
    logger.info("proxy_auth.service_stopped", {
      socketPath: this.options.socketPath,
    });
  }
}
