import http, { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import type { HttpTokenConfig } from "../config.js";
import { logger } from "../logger.js";
import { SandyMcpProxyAccess } from "../mcp/proxy-access.js";
import { createLeafCertificate } from "./ca.js";

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
  caCert?: string;
  caKey?: string;
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
    this.httpServer.on("connect", (req, clientSocket, head) => {
      this.handleConnectRequest(req, clientSocket as Socket, head);
    });
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

  getPort(): number {
    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine HTTP proxy port.");
    }
    return address.port;
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

    await this.handlePlainProxy(req, res, auth.taskId);
  }

  private handleConnectRequest(
    req: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
  ): void {
    const auth = this.extractProxyAuth(req);
    if (!auth) {
      clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\nProxy authentication required.");
      return;
    }

    const validation = this.options.access.validateWorkerGrant({
      taskId: auth.taskId,
      bearerToken: auth.bearerToken,
    });
    if (!validation.ok) {
      clientSocket.end(`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n${validation.message}`);
      return;
    }

    if (this.options.caCert && this.options.caKey) {
      this.handleConnectWithMitm(req, clientSocket, head, auth.taskId);
      return;
    }

    this.handleConnect(req, clientSocket, head, auth.taskId);
  }

  private handleConnect(
    req: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
    taskId: string,
  ): void {
    const url = new URL(`connect://${req.url ?? ""}`);
    const targetHost = url.hostname;
    const targetPort = parseInt(url.port, 10) || 443;

    if (!targetHost) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nInvalid CONNECT target.");
      return;
    }

    logger.debug("http.proxy.connect_request", {
      taskId,
      targetHost,
      targetPort,
    });

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    const upstreamSocket = connect({
      host: targetHost,
      port: targetPort,
    });

    if (head.length > 0) {
      upstreamSocket.write(head);
    }

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

  private handleConnectWithMitm(
    req: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
    taskId: string,
  ): void {
    const url = new URL(`connect://${req.url ?? ""}`);
    const targetHost = url.hostname;
    const targetPort = parseInt(url.port, 10) || 443;

    if (!targetHost) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nInvalid CONNECT target.");
      return;
    }

    logger.debug("http.proxy.connect_mitm_request", {
      taskId,
      targetHost,
      targetPort,
    });

    try {
      const leaf = createLeafCertificate(this.options.caCert!, this.options.caKey!, targetHost);
      const socketPath = join(tmpdir(), `sandy-mitm-tls-${randomUUID()}.sock`);
      const tlsServer = createTlsServer({
        cert: leaf.cert,
        key: leaf.key,
        requestCert: false,
        rejectUnauthorized: false,
      }, (tlsSocket) => {
        this.handleMitmTlsSocket(tlsSocket, taskId);
      });

      let cleanedUp = false;
      let tlsServerListening = false;
      let bridgeSocket: Socket | null = null;
      const cleanup = (): void => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        bridgeSocket?.destroy();
        if (tlsServerListening) {
          tlsServer.close(() => {
            rmSync(socketPath, { force: true });
          });
        } else {
          rmSync(socketPath, { force: true });
        }
      };
      const startClientTunnel = (): void => {
        if (!tlsServerListening) {
          return;
        }
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {
          bridgeSocket = connect(socketPath);
          bridgeSocket.once("connect", () => {
            if (head.length > 0) {
              clientSocket.unshift(head);
            }
            clientSocket.pipe(bridgeSocket!);
            bridgeSocket!.pipe(clientSocket);
          });
          bridgeSocket.once("error", (error: Error) => {
            logger.warn("http.proxy.connect_mitm_bridge_error", {
              taskId,
              targetHost,
              message: error.message,
            });
            clientSocket.destroy();
            cleanup();
          });
          bridgeSocket.once("close", cleanup);
        });
      };

      tlsServer.on("tlsClientError", (error: Error) => {
        logger.warn("http.proxy.connect_mitm_tls_error", {
          taskId,
          targetHost,
          message: error.message,
        });
        clientSocket.destroy();
        cleanup();
      });
      tlsServer.once("error", (error: Error) => {
        logger.warn("http.proxy.connect_mitm_setup_failed", {
          taskId,
          targetHost,
          message: error.message,
        });
        clientSocket.destroy();
        cleanup();
      });

      tlsServer.listen(socketPath, () => {
        tlsServerListening = true;
        startClientTunnel();
      });
      clientSocket.once("error", cleanup);
      clientSocket.once("close", cleanup);
    } catch (error) {
      logger.warn("http.proxy.connect_mitm_setup_failed", {
        taskId,
        targetHost,
        message: error instanceof Error ? error.message : "Unknown MITM setup failure.",
      });
      clientSocket.destroy();
    }
  }

  private handleMitmTlsSocket(tlsSocket: TLSSocket, taskId: string): void {
    let buffered = Buffer.alloc(0);
    let handling = false;

    tlsSocket.on("data", (chunk: Buffer) => {
      if (handling) {
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const headerEndIndex = buffered.indexOf("\r\n\r\n");
      if (headerEndIndex === -1) {
        return;
      }

      const headerText = buffered.subarray(0, headerEndIndex).toString("utf8");
      const parsed = parseRawHttpRequestHeader(headerText);
      if (!parsed) {
        writeRawHttpResponse(tlsSocket, 400, {}, "Invalid HTTP request.");
        return;
      }

      const contentLength = parseInt(parsed.headers["content-length"] ?? "0", 10) || 0;
      const bodyStartIndex = headerEndIndex + 4;
      if (buffered.length < bodyStartIndex + contentLength) {
        return;
      }

      handling = true;
      const body = buffered.subarray(bodyStartIndex, bodyStartIndex + contentLength);
      void this.forwardParsedMitmRequest(tlsSocket, taskId, parsed.method, parsed.target, parsed.headers, body);
    });
  }

  private async forwardParsedMitmRequest(
    tlsSocket: TLSSocket,
    taskId: string,
    method: string,
    target: string,
    headers: Record<string, string>,
    body: Buffer,
  ): Promise<void> {
    const targetUrl = resolveRawMitmTargetUrl(target, headers);
    if (!targetUrl) {
      writeRawHttpResponse(tlsSocket, 400, {}, "Proxy requires a Host header.");
      return;
    }

    const targetHost = targetUrl.hostname;
    const targetPort = parseInt(targetUrl.port, 10) || 443;
    const { resolvedHeaders, rejectionMessage } = await this.resolveTokenPlaceholders(
      taskId,
      targetHost,
      headers,
    );

    if (rejectionMessage) {
      writeRawHttpResponse(tlsSocket, 403, {}, rejectionMessage);
      return;
    }

    const proxyReq = https.request({
      host: targetHost,
      port: targetPort,
      method,
      path: targetUrl.pathname + targetUrl.search,
      headers: resolvedHeaders,
    }, (upstreamRes: IncomingMessage) => {
      writeRawHttpResponseHead(tlsSocket, upstreamRes.statusCode ?? 200, upstreamRes.headers);
      upstreamRes.pipe(tlsSocket, { end: false });
      upstreamRes.once("end", () => {
        tlsSocket.end();
      });
    });

    proxyReq.on("error", (error: Error) => {
      writeRawHttpResponse(tlsSocket, 502, {}, error.message);
    });
    proxyReq.end(body);
  }

  private async handlePlainProxy(
    req: IncomingMessage,
    res: ServerResponse,
    taskId: string,
    targetProtocolOverride?: "http:" | "https:",
  ): Promise<void> {
    const targetUrl = resolveProxyTargetUrl(req, targetProtocolOverride);
    if (!targetUrl) {
      res.statusCode = 400;
      res.end("Proxy requires absolute-form request URLs.");
      return;
    }
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

    const requestImpl = targetUrl.protocol === "https:" ? https.request : http.request;
    const proxyReq = requestImpl({
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

      if (isHopByHopHeader(headerName)) {
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

    if (!authValue) {
      logger.debug("http.proxy.missing_proxy_auth", {
        hasHeader: false,
      });
      return null;
    }

    if (authValue.startsWith("Bearer ")) {
      const token = authValue.slice("Bearer ".length);
      const taskId = extractTaskIdFromJwt(token);
      if (!taskId) {
        return null;
      }
      return { taskId, bearerToken: token };
    }

    if (authValue.startsWith("Basic ")) {
      const decoded = Buffer.from(authValue.slice("Basic ".length), "base64").toString("utf8");
      const colonIndex = decoded.indexOf(":");
      if (colonIndex === -1) {
        return null;
      }
      const password = decoded.slice(colonIndex + 1);
      const taskId = extractTaskIdFromJwt(password);
      if (!taskId) {
        return null;
      }
      return { taskId, bearerToken: password };
    }

    logger.debug("http.proxy.missing_proxy_auth", {
      hasHeader: true,
      authScheme: authValue.split(" ")[0],
    });
    return null;
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

function extractTaskIdFromJwt(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { taskId: string };
    return payload.taskId ?? null;
  } catch {
    return null;
  }
}

function resolveProxyTargetUrl(
  req: IncomingMessage,
  targetProtocolOverride?: "http:" | "https:",
): URL | null {
  const reqUrl = req.url ?? "";
  if (reqUrl.startsWith("http://") || reqUrl.startsWith("https://")) {
    return new URL(reqUrl);
  }

  if (!targetProtocolOverride) {
    return null;
  }

  const hostHeader = typeof req.headers.host === "string"
    ? req.headers.host
    : Array.isArray(req.headers.host)
      ? req.headers.host[0]
      : null;
  if (!hostHeader) {
    return null;
  }

  return new URL(`${targetProtocolOverride}//${hostHeader}${reqUrl}`);
}

function parseRawHttpRequestHeader(headerText: string): {
  method: string;
  target: string;
  headers: Record<string, string>;
} | null {
  const lines = headerText.split("\r\n");
  const requestLine = lines.shift();
  if (!requestLine) {
    return null;
  }

  const [method, target] = requestLine.split(" ");
  if (!method || !target) {
    return null;
  }

  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const name = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();
    if (name) {
      headers[name] = value;
    }
  }

  return { method, target, headers };
}

function resolveRawMitmTargetUrl(target: string, headers: Record<string, string>): URL | null {
  if (target.startsWith("http://") || target.startsWith("https://")) {
    return new URL(target);
  }

  const host = headers["host"];
  if (!host) {
    return null;
  }

  return new URL(`https://${host}${target}`);
}

function writeRawHttpResponse(
  socket: TLSSocket,
  statusCode: number,
  headers: Record<string, string | number | readonly string[] | undefined>,
  body: string,
): void {
  const contentType = headers["content-type"];
  writeRawHttpResponseHead(socket, statusCode, {
    ...headers,
    "content-length": String(Buffer.byteLength(body)),
    "content-type": typeof contentType === "string" ? contentType : "text/plain",
  });
  socket.end(body);
}

function writeRawHttpResponseHead(
  socket: TLSSocket,
  statusCode: number,
  headers: Record<string, string | number | readonly string[] | undefined>,
): void {
  const statusMessage = http.STATUS_CODES[statusCode] ?? "OK";
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`];
  for (const [name, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined || isHopByHopHeader(name)) {
      continue;
    }
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      lines.push(`${name}: ${String(value)}`);
    }
  }
  lines.push("connection: close", "", "");
  socket.write(lines.join("\r\n"));
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
