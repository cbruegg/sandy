import { test } from "bun:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { PassThrough, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { SandyMcpProxyAccess } from "../mcp/proxy-access.js";
import { SandyHttpProxy } from "./http-proxy.js";

function createProxy(
  options: Partial<ConstructorParameters<typeof SandyHttpProxy>[0]> = {},
): SandyHttpProxy {
  const access = new SandyMcpProxyAccess("test-secret");
  return new SandyHttpProxy({
    access,
    httpTokens: {
      api_key: { value: "real-secret-key", allowedHosts: ["127.0.0.1", "localhost"] },
    },
    authorizeHttpTokenUse: async () => ({
      outcome: "approved",
      message: "ok",
    }),
    port: 0,
    ...options,
  });
}

class RecordingResponse extends Writable {
  public statusCode: number | null = null;
  public headers: http.OutgoingHttpHeaders | null = null;
  public body = "";

  writeHead(statusCode: number, headers: http.OutgoingHttpHeaders): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.body += String(chunk);
    callback();
  }
}

test("SandyHttpProxy extracts Bearer proxy auth", async () => {
  const access = new SandyMcpProxyAccess("test-secret");
  const proxy = createProxy({ access });
  const { bearerToken } = access.issueWorkerGrant("task-1");

  const auth = (proxy as unknown as {
    extractProxyAuth: (req: Pick<IncomingMessage, "headers">) => { taskId: string; bearerToken: string } | null;
  }).extractProxyAuth({
    headers: {
      "proxy-authorization": `Bearer ${bearerToken}`,
    },
  });

  assert.deepEqual(auth, {
    taskId: "task-1",
    bearerToken,
  });
});

test("SandyHttpProxy extracts Basic proxy auth with JWT in password", async () => {
  const access = new SandyMcpProxyAccess("test-secret");
  const proxy = createProxy({ access });
  const { bearerToken } = access.issueWorkerGrant("task-1");

  const auth = (proxy as unknown as {
    extractProxyAuth: (req: Pick<IncomingMessage, "headers">) => { taskId: string; bearerToken: string } | null;
  }).extractProxyAuth({
    headers: {
      "proxy-authorization": `Basic ${Buffer.from(`Bearer:${bearerToken}`).toString("base64")}`,
    },
  });

  assert.deepEqual(auth, {
    taskId: "task-1",
    bearerToken,
  });
});

test("SandyHttpProxy rejects missing or invalid proxy auth", async () => {
  const proxy = createProxy();

  const extractProxyAuth = (proxy as unknown as {
    extractProxyAuth: (req: Pick<IncomingMessage, "headers">) => { taskId: string; bearerToken: string } | null;
  }).extractProxyAuth;

  assert.equal(extractProxyAuth({ headers: {} }), null);
  assert.equal(extractProxyAuth({ headers: { "proxy-authorization": "Bearer invalid-token" } }), null);
  assert.equal(extractProxyAuth({ headers: { "proxy-authorization": "Basic not-base64" } }), null);
});

test("SandyHttpProxy replaces placeholders and strips hop-by-hop headers", async () => {
  const proxy = createProxy();

  const result = await (proxy as unknown as {
    resolveTokenPlaceholders: (taskId: string, targetHost: string, headers: Record<string, string | string[] | undefined>) => Promise<{
      resolvedHeaders: Record<string, string | string[]>;
      rejectionMessage: string | null;
    }>;
  }).resolveTokenPlaceholders("task-1", "127.0.0.1", {
    "x-api-key": "SANDY_TOKEN_api_key",
    "proxy-authorization": "Bearer ignored",
    "proxy-connection": "keep-alive",
    connection: "close",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
    upgrade: "h2c",
    "x-custom-header": "preserved",
  });

  assert.equal(result.rejectionMessage, null);
  assert.deepEqual(result.resolvedHeaders, {
    "x-api-key": "real-secret-key",
    "x-custom-header": "preserved",
  });
});

test("SandyHttpProxy rejects denied placeholder approvals", async () => {
  const proxy = createProxy({
    authorizeHttpTokenUse: async () => ({
      outcome: "denied",
      message: "User denied this request.",
    }),
  });

  const result = await (proxy as unknown as {
    resolveTokenPlaceholders: (taskId: string, targetHost: string, headers: Record<string, string | string[] | undefined>) => Promise<{
      resolvedHeaders: Record<string, string | string[]>;
      rejectionMessage: string | null;
    }>;
  }).resolveTokenPlaceholders("task-1", "127.0.0.1", {
    "x-api-key": "SANDY_TOKEN_api_key",
  });

  assert.deepEqual(result.resolvedHeaders, {});
  assert.equal(result.rejectionMessage, "User denied this request.");
});

test("SandyHttpProxy forwards MITM-decrypted HTTPS requests over https with rewritten headers", async () => {
  const originalHttpsRequest = https.request;
  const access = new SandyMcpProxyAccess("test-secret");
  const proxy = createProxy({ access });
  const requestBody = new PassThrough();
  const response = new RecordingResponse();
  const requestFinished = new Promise<void>((resolve) => response.on("finish", () => resolve()));

  let capturedOptions: https.RequestOptions | null = null;
  let upstreamBody = "";
  https.request = ((options: https.RequestOptions | string | URL, callback?: (res: IncomingMessage) => void) => {
    capturedOptions = typeof options === "string" || options instanceof URL ? {} : options;
    const writable = new Writable({
      write(chunk, _encoding, done) {
        upstreamBody += String(chunk);
        done();
      },
    });
    writable.on("finish", () => {
      const upstreamRes = new PassThrough() as PassThrough & IncomingMessage;
      upstreamRes.statusCode = 200;
      upstreamRes.headers = { "content-type": "text/plain" };
      callback?.(upstreamRes);
      upstreamRes.end("secure-ok");
    });
    return writable as unknown as http.ClientRequest;
  }) as typeof https.request;

  try {
    Object.assign(requestBody, {
      method: "POST",
      url: "/secure?x=1",
      headers: {
        host: "localhost:8443",
        "x-api-key": "SANDY_TOKEN_api_key",
        connection: "close",
      },
    } satisfies Partial<IncomingMessage>);

    const proxyPromise = (proxy as unknown as {
      handlePlainProxy: (
        req: IncomingMessage,
        res: ServerResponse,
        taskId: string,
        targetProtocolOverride?: "http:" | "https:",
      ) => Promise<void>;
    }).handlePlainProxy(requestBody as unknown as IncomingMessage, response as unknown as ServerResponse, "task-1", "https:");

    requestBody.end("payload");
    await proxyPromise;
    await requestFinished;

    assert.ok(capturedOptions);
    const requestOptions = capturedOptions as https.RequestOptions;
    assert.equal(requestOptions.host, "localhost");
    assert.equal(requestOptions.port, 8443);
    assert.equal(requestOptions.path, "/secure?x=1");
    assert.equal(requestOptions.method, "POST");
    assert.equal((requestOptions.headers as Record<string, string>)["x-api-key"], "real-secret-key");
    assert.equal((requestOptions.headers as Record<string, string>)["connection"], undefined);
    assert.equal(upstreamBody, "payload");
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "secure-ok");
  } finally {
    https.request = originalHttpsRequest;
  }
});

test("SandyHttpProxy routes CONNECT requests to MITM handling when CA is configured", async () => {
  const access = new SandyMcpProxyAccess("test-secret");
  const proxy = createProxy({
    access,
    caCert: "cert",
    caKey: "key",
  });
  const { bearerToken } = access.issueWorkerGrant("task-1");
  let mitmCalled = false;

  (proxy as unknown as { handleConnectWithMitm: (...args: unknown[]) => void }).handleConnectWithMitm = () => {
    mitmCalled = true;
  };

  await (proxy as unknown as {
    handleConnectRequest: (req: IncomingMessage, clientSocket: Socket, head: Buffer) => Promise<void>;
  }).handleConnectRequest(
    {
      url: "localhost:443",
      headers: {
        "proxy-authorization": `Bearer ${bearerToken}`,
      },
    } as IncomingMessage,
    {
      end() {},
      destroy() {},
      write() { return true; },
    } as unknown as Socket,
    Buffer.alloc(0),
  );

  assert.equal(mitmCalled, true);
});
