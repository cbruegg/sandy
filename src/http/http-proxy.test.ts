import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { PassThrough, Writable } from "node:stream";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { SandyMcpProxyAccess } from "../mcp/proxy-access.js";
import { createCertificateAuthority, createLeafCertificate } from "./ca.js";
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

async function waitForServer(server: http.Server | https.Server, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine server port.");
  }
  return address.port;
}

async function closeServer(server: http.Server | https.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const NODE_TLS_CONNECT_CLIENT_SCRIPT = `
const fs = require("node:fs");
const net = require("node:net");
const tls = require("node:tls");

const [proxyPort, upstreamPort, bearerToken, caCertPath] = process.argv.slice(1);
let settled = false;
let stage = "connecting to proxy";

function fail(error) {
  if (settled) {
    return;
  }
  settled = true;
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
}

function succeed(response) {
  if (settled) {
    return;
  }
  settled = true;
  console.log(response);
  process.exit(0);
}

const socket = net.createConnection({ host: "127.0.0.1", port: Number(proxyPort) }, () => {
  stage = "sending CONNECT request";
  socket.write([
    "CONNECT localhost:" + upstreamPort + " HTTP/1.1",
    "Host: localhost:" + upstreamPort,
    "Proxy-Authorization: Bearer " + bearerToken,
    "",
    "",
  ].join("\\r\\n"));
});

let connectResponse = Buffer.alloc(0);
socket.on("data", function onConnectData(chunk) {
  connectResponse = Buffer.concat([connectResponse, chunk]);
  const markerIndex = connectResponse.indexOf("\\r\\n\\r\\n");
  if (markerIndex === -1) {
    stage = "waiting for complete CONNECT response";
    return;
  }

  socket.off("data", onConnectData);
  stage = "validating CONNECT response";
  const responseHead = connectResponse.subarray(0, markerIndex + 4).toString("utf8");
  if (!responseHead.startsWith("HTTP/1.1 200 Connection Established")) {
    fail(new Error("Unexpected CONNECT response: " + responseHead));
    return;
  }

  const extra = connectResponse.subarray(markerIndex + 4);
  if (extra.length > 0) {
    socket.unshift(extra);
  }

  const tlsSocket = tls.connect({
    ca: fs.readFileSync(caCertPath),
    rejectUnauthorized: true,
    servername: "localhost",
    socket,
  }, () => {
    stage = "sending HTTPS request";
    tlsSocket.write([
      "GET /secure HTTP/1.1",
      "Host: localhost:" + upstreamPort,
      "X-Api-Key: SANDY_TOKEN_api_key",
      "Proxy-Connection: keep-alive",
      "Connection: close",
      "",
      "",
    ].join("\\r\\n"));
  });

  let response = "";
  tlsSocket.on("data", (responseChunk) => {
    stage = "receiving HTTPS response";
    response += responseChunk.toString("utf8");
  });
  tlsSocket.on("end", () => {
    if (!response.includes("secure-ok")) {
      fail(new Error("HTTPS response did not contain expected body: " + response));
      return;
    }
    succeed(response);
  });
  tlsSocket.on("error", fail);
});
socket.on("error", fail);

setTimeout(() => fail(new Error("Node CONNECT/TLS client timed out at stage: " + stage)), 10000);
`.trim();

async function runNodeTlsConnectClient(input: {
  bearerToken: string;
  caCertPath: string;
  proxyPort: number;
  upstreamPort: number;
}, timeoutMs = 12_000): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn("node", [
      "-e",
      NODE_TLS_CONNECT_CLIENT_SCRIPT,
      String(input.proxyPort),
      String(input.upstreamPort),
      input.bearerToken,
      input.caCertPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error([
        `Node CONNECT/TLS client timed out after ${timeoutMs}ms`,
        `stdout: ${Buffer.concat(stdout).toString("utf8")}`,
        `stderr: ${Buffer.concat(stderr).toString("utf8")}`,
      ].join("\n")));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
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

test("SandyHttpProxy handles a real CONNECT TLS MITM request end to end", async () => {
  const ca = await createCertificateAuthority();
  const upstreamLeaf = createLeafCertificate(ca.cert, ca.key, "localhost");
  const originalGlobalAgent = https.globalAgent;
  const testAgent = new https.Agent({ ca: ca.cert });
  const access = new SandyMcpProxyAccess("test-secret");
  let authorizeSeen = false;
  const proxy = createProxy({
    access,
    caCert: ca.cert,
    caKey: ca.key,
    authorizeHttpTokenUse: async () => {
      authorizeSeen = true;
      return { outcome: "approved", message: "ok" };
    },
  });
  let proxyStarted = false;
  let upstreamHeaders: IncomingHttpHeaders | null = null;
  let upstreamUrl: string | undefined;

  const upstreamServer = https.createServer({
    cert: upstreamLeaf.cert,
    key: upstreamLeaf.key,
  }, (req, res) => {
    upstreamHeaders = req.headers;
    upstreamUrl = req.url;
    res.writeHead(200, {
      "content-length": String(Buffer.byteLength("secure-ok")),
      "content-type": "text/plain",
      connection: "close",
    });
    res.end("secure-ok");
  });

  try {
    https.globalAgent = testAgent;
    const upstreamPort = await waitForServer(upstreamServer, "localhost");
    await proxy.start();
    proxyStarted = true;

    const { bearerToken } = access.issueWorkerGrant("task-1");
    assert.ok(ca.certPath);
    const response = await runNodeTlsConnectClient({
      bearerToken,
      caCertPath: ca.certPath,
      proxyPort: proxy.getPort(),
      upstreamPort,
    });

    assert.equal(response.code, 0, [
      response.stderr,
      `authorizeSeen=${authorizeSeen}`,
      `upstreamHeaders=${JSON.stringify(upstreamHeaders)}`,
    ].join("\n"));
    assert.match(response.stdout, /^HTTP\/1\.1 200 OK/);
    assert.match(response.stdout, /secure-ok/);
    assert.equal(upstreamUrl, "/secure");
    assert.ok(upstreamHeaders);
    assert.equal(upstreamHeaders["x-api-key"], "real-secret-key");
    assert.equal(upstreamHeaders["proxy-connection"], undefined);
    assert.equal(upstreamHeaders["proxy-authorization"], undefined);
  } finally {
    if (proxyStarted) {
      await proxy.stop();
    }
    await closeServer(upstreamServer);
    testAgent.destroy();
    https.globalAgent = originalGlobalAgent;
    if (ca.certPath) {
      await rm(ca.certPath, { force: true });
    }
  }
}, 15_000);

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
