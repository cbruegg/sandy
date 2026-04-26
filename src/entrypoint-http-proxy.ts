import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { SandyHttpProxy } from "./http/http-proxy.js";
import { configureLogger } from "./logger.js";
import { SandyMcpProxyAccess } from "./mcp/proxy-access.js";

type Bootstrap = {
  httpTokens: Record<string, { value: string; allowedHosts: string[] }>;
  sharedSecret: string;
  caCert?: string;
  caKey?: string;
};

function send(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function createUnixSocketAuthorizer(socketPath: string) {
  return async (input: {
    taskId: string;
    tokenId: string;
    host: string;
  }): Promise<{
    outcome: "approved" | "denied" | "failed";
    message: string;
  }> => {
    return new Promise((resolve) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      let resolved = false;

      const cleanup = (): void => {
        resolved = true;
        socket.destroy();
      };

      socket.on("connect", () => {
        socket.write(`${JSON.stringify(input)}\n`);
      });

      socket.on("data", (data) => {
        if (resolved) {
          return;
        }
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (line.trim()) {
            try {
              resolve(JSON.parse(line) as {
                outcome: "approved" | "denied" | "failed";
                message: string;
              });
            } catch {
              resolve({
                outcome: "failed",
                message: "Invalid response from authorization service.",
              });
            }
            cleanup();
            return;
          }
        }
      });

      socket.on("error", (error) => {
        if (!resolved) {
          resolve({
            outcome: "failed",
            message: `Authorization service connection failed: ${error.message}`,
          });
        }
      });

      socket.on("close", () => {
        if (!resolved) {
          resolve({
            outcome: "failed",
            message: "Authorization service closed connection unexpectedly.",
          });
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolve({
            outcome: "failed",
            message: "Authorization request timed out.",
          });
          cleanup();
        }
      }, 5_000);
    });
  };
}

async function main(): Promise<void> {
  configureLogger({
    outputMode: "stderr",
  });

  const bootstrapPath = process.env["SANDY_HTTP_PROXY_BOOTSTRAP_FILE"];
  if (!bootstrapPath) {
    throw new Error(
      "SANDY_HTTP_PROXY_BOOTSTRAP_FILE environment variable is required.",
    );
  }

  const bootstrap = JSON.parse(readFileSync(bootstrapPath, "utf8")) as Bootstrap;
  const access = new SandyMcpProxyAccess(bootstrap.sharedSecret);
  const socketPath =
    process.env["SANDY_HTTP_PROXY_AUTH_SOCKET"] ?? "/run/sandy-proxy-auth.sock";

  const proxy = new SandyHttpProxy({
    access,
    httpTokens: bootstrap.httpTokens,
    port: 8081,
    caCert: bootstrap.caCert,
    caKey: bootstrap.caKey,
    authorizeHttpTokenUse: createUnixSocketAuthorizer(socketPath),
  });

  await proxy.start();
  send({ type: "ready" });

  process.stdin.on("close", () => {
    void proxy.stop().then(() => {
      process.exit(0);
    });
  });
}

main().catch((error) => {
  send({
    type: "fatal_error",
    message: error instanceof Error ? error.message : "HTTP proxy failed to start.",
  });
  process.exit(1);
});
