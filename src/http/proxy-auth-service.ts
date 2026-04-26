import type { HttpTokenConfig } from "../config.js";
import { ProxyAccess } from "../proxy-access.js";
import type { HttpProxyAuthRequestMessage, HttpProxyAuthResponseMessage, HttpProxyRequestHeader } from "./http-proxy-protocol.js";

type ProxyAuthServiceOptions = {
  access: ProxyAccess;
  httpTokens: Record<string, HttpTokenConfig>;
  authorizeHttpTokenUse: (input: {
    taskId: string;
    tokenId: string;
    host: string;
  }) => Promise<{ outcome: "approved" | "denied" | "failed"; message: string }>;
};

export class ProxyAuthService {
  constructor(private readonly options: ProxyAuthServiceOptions) {}

  async resolveProxyRequest(request: HttpProxyAuthRequestMessage): Promise<HttpProxyAuthResponseMessage> {
    if (request.proxyAuthUsername !== "Bearer") {
      return {
        type: "auth_response",
        requestId: request.requestId,
        outcome: "denied",
        message: "Proxy authentication username must be Bearer.",
      };
    }

    const grant = this.options.access.resolveVerifiedWorkerGrant(request.proxyAuthPassword);
    if (!grant.ok) {
      return {
        type: "auth_response",
        requestId: request.requestId,
        outcome: "denied",
        message: grant.message,
      };
    }

    const resolvedHeaders: HttpProxyRequestHeader[] = [];
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
          type: "auth_response",
          requestId: request.requestId,
          outcome: "denied",
          message: result.message,
        };
      }

      const tokenConfig = this.options.httpTokens[tokenId];
      if (!tokenConfig) {
        return {
          type: "auth_response",
          requestId: request.requestId,
          outcome: "denied",
          message: `HTTP token "${tokenId}" is not configured.`,
        };
      }

      resolvedHeaders.push({
        name: header.name,
        value: header.value.replace(`${SANDY_TOKEN_PREFIX}${tokenId}`, tokenConfig.value),
      });
    }

    return {
      type: "auth_response",
      requestId: request.requestId,
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

const SANDY_TOKEN_PREFIX = "SANDY_TOKEN_";

function extractPlaceholderTokenId(value: string): string | null {
  const match = value.includes(SANDY_TOKEN_PREFIX)
    ? value.match(new RegExp(`${SANDY_TOKEN_PREFIX}([a-zA-Z0-9_]+)`))
    : null;
  return match?.[1] ?? null;
}
