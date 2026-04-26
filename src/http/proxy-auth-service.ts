import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { HttpTokenConfig } from "../config.js";
import { logger } from "../logger.js";
import { SandyMcpProxyAccess } from "../mcp/proxy-access.js";
import { parseProxyAuthRequest, serializeProxyAuthResponse, type ProxyAuthRequest, type ProxyAuthResponse, type ProxyRequestHeader } from "./proxy-auth-protocol.js";

type ProxyAuthServiceOptions = {
  socketPath: string;
  access: SandyMcpProxyAccess;
  httpTokens: Record<string, HttpTokenConfig>;
  authorizeHttpTokenUse: (input: {
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
            const request = parseProxyAuthRequest(line);
            this.resolveProxyRequest(request)
              .then((result) => {
                socket.write(serializeProxyAuthResponse(result));
              })
              .catch((error) => {
                socket.write(serializeProxyAuthResponse({
                  outcome: "failed",
                  message:
                    error instanceof Error
                      ? error.message
                      : "Authorization service error.",
                }));
              });
          } catch {
            socket.write(serializeProxyAuthResponse({
              outcome: "failed",
              message: "Invalid authorization request format.",
            }));
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

  private async resolveProxyRequest(request: ProxyAuthRequest): Promise<ProxyAuthResponse> {
    if (request.proxyAuthUsername !== "Bearer") {
      return {
        outcome: "denied",
        message: "Proxy authentication username must be Bearer.",
      };
    }

    const grant = this.options.access.resolveWorkerGrant(request.proxyAuthPassword);
    if (!grant.ok) {
      return {
        outcome: "denied",
        message: grant.message,
      };
    }

    const resolvedHeaders: ProxyRequestHeader[] = [];
    const tokenRequests = new Map<string, Promise<{ approved: boolean; message: string }>>();

    for (const header of request.headers) {
      if (isHopByHopHeader(header.name)) {
        continue;
      }

      const tokenId = extractPlaceholderTokenId(header.value);
      if (!tokenId) {
        resolvedHeaders.push(header);
        continue;
      }

      if (!tokenRequests.has(tokenId)) {
        tokenRequests.set(tokenId, this.checkTokenApproval(grant.taskId, tokenId, request.targetHost));
      }
      const result = await tokenRequests.get(tokenId)!;
      if (!result.approved) {
        return {
          outcome: "denied",
          message: result.message,
        };
      }

      const tokenConfig = this.options.httpTokens[tokenId];
      if (!tokenConfig) {
        return {
          outcome: "denied",
          message: `HTTP token "${tokenId}" is not configured.`,
        };
      }

      resolvedHeaders.push({
        name: header.name,
        value: header.value.replace(`SANDY_TOKEN_${tokenId}`, tokenConfig.value),
      });
    }

    return {
      outcome: "approved",
      headers: resolvedHeaders,
    };
  }

  private async checkTokenApproval(
    taskId: string,
    tokenId: string,
    host: string,
  ): Promise<{ approved: boolean; message: string }> {
    const tokenConfig = this.options.httpTokens[tokenId];
    if (!tokenConfig) {
      return { approved: false, message: `HTTP token "${tokenId}" is not configured.` };
    }

    const result = await this.options.authorizeHttpTokenUse({
      taskId,
      tokenId,
      host,
    });

    return {
      approved: result.outcome === "approved",
      message: result.message,
    };
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isHopByHopHeader(name: string): boolean {
  return HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}

function extractPlaceholderTokenId(value: string): string | null {
  const match = value.includes("SANDY_TOKEN_")
    ? value.match(/SANDY_TOKEN_([a-zA-Z0-9_]+)/)
    : null;
  return match?.[1] ?? null;
}
