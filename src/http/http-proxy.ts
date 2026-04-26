import http, { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { Socket } from "node:net";
import type { HttpTokenConfig } from "../config.js";
import { logger } from "../logger.js";
import { SandyMcpProxyAccess } from "../mcp/proxy-access.js";

const PLACEHOLDER_PREFIX = "SANDY_TOKEN_";

type TokenId = string;
type HttpTokensByName = Record<TokenId, HttpTokenConfig>;

type SandyHttpProxyOptions = {
  access: SandyMcpProxyAccess;
  httpTokens: HttpTokensByName;
  authorizeHttpTokenUse: (input: {
    taskId: string;
    tokenId: string;
    host: string;
  }) => Promise<{ outcome: "approved" | "denied" | "failed"; message: string }>;
  host?: string;
  port?: number;
};

export class SandyHttpProxy {
  private readonly httpServer = createServer((req, res) => {
    void this.handleHttpRequest(req, res);
  });
  private readonly host: string;
  private readonly port: number;

  constructor(private readonly options: SandyHttpProxyOptions) {
    this.host = options.host ?? "0.0.0.0";
    this.port = options.port ?? 8081;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, this.host, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });

    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine HTTP proxy port.");
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const auth = this.extractProxyAuth(req);
    if (!auth) {
      res.statusCode = 407;
      res.end("Proxy authentication required.");
      return;
    }

    const validation = this.options.access.validateWorkerGrant({
      taskId: auth.taskId,
      bearerToken: auth.bearerToken,
    });
    if (!validation.ok) {
      res.statusCode = 403;
      res.end(validation.message);
      return;
    }

    if (req.method === "CONNECT") {
      this.handleConnect(req, res, auth.taskId);
      return;
    }

    await this.handlePlainProxy(req, res, auth.taskId);
  }

  private handleConnect(
    req: IncomingMessage,
    res: ServerResponse,
    taskId: string,
  ): void {
    const url = new URL(`connect://${req.url ?? ""}`);
    const targetHost = url.hostname;
    const targetPort = parseInt(url.port, 10) || 443;

    if (!targetHost) {
      res.statusCode = 400;
      res.end("Invalid CONNECT target.");
      return;
    }

    logger.debug("http.proxy.connect_request", {
      taskId,
      targetHost,
      targetPort,
    });

    res.statusCode = 200;
    res.end();

    const upstreamSocket = connect({
      host: targetHost,
      port: targetPort,
    });

    const clientSocket = (req as IncomingMessage & { socket: Socket }).socket;

    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);

    upstreamSocket.on("error", (error: Error) => {
      logger.warn("http.proxy.connect_upstream_error", {
        taskId,
        targetHost,
        targetPort,
        message: error.message,
      });
      clientSocket.destroy();
    });

    clientSocket.on("error", () => {
      upstreamSocket.destroy();
    });
  }

  private async handlePlainProxy(
    req: IncomingMessage,
    res: ServerResponse,
    taskId: string,
  ): Promise<void> {
    const reqUrl = req.url ?? "";
    if (!reqUrl.startsWith("http://") && !reqUrl.startsWith("https://")) {
      res.statusCode = 400;
      res.end("Proxy requires absolute-form request URLs.");
      return;
    }

    const targetUrl = new URL(reqUrl);
    const targetHost = targetUrl.hostname;
    const targetPort = parseInt(targetUrl.port, 10) || (targetUrl.protocol === "https:" ? 443 : 80);

    logger.debug("http.proxy.plain_request", {
      taskId,
      method: req.method ?? "GET",
      targetHost,
      targetPort,
      path: targetUrl.pathname + targetUrl.search,
    });

    const { resolvedHeaders, rejectionMessage } = await this.resolveTokenPlaceholders(
      taskId,
      targetHost,
      req.headers,
    );

    if (rejectionMessage) {
      res.statusCode = 403;
      res.end(rejectionMessage);
      return;
    }

    const proxyReq = http.request({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: targetUrl.pathname + targetUrl.search,
      headers: resolvedHeaders,
    }, (upstreamRes: IncomingMessage) => {
      res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    proxyReq.on("error", (error: Error) => {
      res.statusCode = 502;
      res.end(error.message);
    });

    req.pipe(proxyReq);
  }

  /**
   * Scans request headers for SANDY_TOKEN_<id> placeholders and replaces them
   * with the real secret from the token config.
   *
   * @returns [resolvedHeaders, rejectionMessage]
   *   - resolvedHeaders: headers with placeholders replaced (empty if any token was rejected)
   *   - rejectionMessage: null if all tokens were approved, or an error string if any were denied
   */
  private async resolveTokenPlaceholders(
    taskId: string,
    targetHost: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ resolvedHeaders: Record<string, string | string[]>; rejectionMessage: string | null }> {
    const resolvedHeaders: Record<string, string | string[]> = {};
    const tokenRequests = new Map<string, Promise<{ approved: boolean; message: string }>>();

    for (const [headerName, rawValue] of Object.entries(headers)) {
      if (rawValue === undefined) {
        continue;
      }

      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      const resolvedValues: string[] = [];

      for (const value of values) {
        const tokenId = extractPlaceholderTokenId(value);
        if (!tokenId) {
          resolvedValues.push(value);
          continue;
        }

        if (!tokenRequests.has(tokenId)) {
          tokenRequests.set(tokenId, this.checkTokenApproval(taskId, tokenId, targetHost));
        }
        const result = await tokenRequests.get(tokenId)!;

        if (!result.approved) {
          return { resolvedHeaders: {}, rejectionMessage: result.message };
        }

        const tokenConfig = this.options.httpTokens[tokenId];
        if (!tokenConfig) {
          return { resolvedHeaders: {}, rejectionMessage: `HTTP token "${tokenId}" is not configured.` };
        }

        resolvedValues.push(value.replace(`SANDY_TOKEN_${tokenId}`, tokenConfig.value));
      }

      if (resolvedValues.length === 1) {
        resolvedHeaders[headerName] = resolvedValues[0]!;
      } else {
        resolvedHeaders[headerName] = resolvedValues;
      }
    }

    return { resolvedHeaders, rejectionMessage: null };
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

    if (!isHostAllowed(tokenConfig, host)) {
      return {
        approved: false,
        message: `Host "${host}" is not in the configured allowed_hosts for token ${tokenId}.`,
      };
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

  private extractProxyAuth(req: IncomingMessage): { taskId: string; bearerToken: string } | null {
    const authHeader = req.headers["proxy-authorization"];
    const authValue = (typeof authHeader === "string" ? authHeader : Array.isArray(authHeader) ? authHeader[0] : undefined);

    if (!authValue?.startsWith("Bearer ")) {
      logger.debug("http.proxy.missing_proxy_auth", {
        hasHeader: authValue !== undefined,
      });
      return null;
    }

    const token = authValue.slice("Bearer ".length);
    let taskId: string;
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { taskId: string };
      taskId = payload.taskId;
    } catch {
      return null;
    }

    return {
      taskId,
      bearerToken: token,
    };
  }
}

function extractPlaceholderTokenId(value: string): string | null {
  const match = value.includes(PLACEHOLDER_PREFIX)
    ? value.match(new RegExp(`${PLACEHOLDER_PREFIX}([a-zA-Z0-9_]+)`))
    : null;
  return match?.[1] ?? null;
}

function isHostAllowed(tokenConfig: HttpTokenConfig, host: string): boolean {
  if (tokenConfig.allowedHosts.length === 0) {
    return false;
  }
  return tokenConfig.allowedHosts.some(
    (allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`),
  );
}
