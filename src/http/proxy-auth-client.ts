import { createConnection } from "node:net";
import type { ProxyAuthRequest, ProxyAuthResponse } from "./proxy-auth-protocol.js";
import { parseProxyAuthResponse, serializeProxyAuthRequest } from "./proxy-auth-protocol.js";

export function createUnixSocketAuthorizer(socketPath: string) {
  return async (input: ProxyAuthRequest): Promise<ProxyAuthResponse> => {
    return new Promise((resolve) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      let resolved = false;

      const cleanup = (): void => {
        resolved = true;
        socket.destroy();
      };

      socket.on("connect", () => {
        socket.write(serializeProxyAuthRequest(input));
      });

      socket.on("data", (data) => {
        if (resolved) {
          return;
        }
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          try {
            resolve(parseProxyAuthResponse(line));
          } catch {
            resolve({
              outcome: "failed",
              message: "Invalid response from authorization service.",
            });
          }
          cleanup();
          return;
        }
      });

      socket.on("error", (error) => {
        if (!resolved) {
          resolve({
            outcome: "failed",
            message: `Authorization service connection failed: ${error.message}`,
          });
          cleanup();
        }
      });

      socket.on("close", () => {
        if (!resolved) {
          resolve({
            outcome: "failed",
            message: "Authorization service closed connection unexpectedly.",
          });
          cleanup();
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
