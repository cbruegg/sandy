import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { rm } from "node:fs/promises";
// @ts-expect-error imports the Node bundle which has no corresponding .d.ts
import { createCertificateAuthority, createLeafCertificate, SandyHttpProxy, SandyMcpProxyAccess } from "../../dist/http/http-proxy-test-exports.js";

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

test("SandyHttpProxy handles a real CONNECT TLS MITM request end to end", { timeout: 15_000 }, async () => {
  const ca = await createCertificateAuthority();
  const upstreamLeaf = createLeafCertificate(ca.cert, ca.key, "localhost");
  const access = new SandyMcpProxyAccess("test-secret");
  const proxy = createProxy({
    access,
    caCert: ca.cert,
    caKey: ca.key,
  });
  let proxyStarted = false;
  let upstreamHeaders: http.IncomingHttpHeaders | null = null;
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

  const originalGlobalAgent = https.globalAgent;
  const testAgent = new https.Agent({ ca: ca.cert });

  try {
    https.globalAgent = testAgent;
    const upstreamPort = await waitForServer(upstreamServer, "localhost");
    await proxy.start();
    proxyStarted = true;

    const { bearerToken } = access.issueWorkerGrant("task-1");

    const rawSocket = net.createConnection({ host: "127.0.0.1", port: proxy.getPort() });
    await new Promise<void>((resolve, reject) => {
      rawSocket.once("connect", resolve);
      rawSocket.once("error", reject);
    });

    rawSocket.write([
      `CONNECT localhost:${upstreamPort} HTTP/1.1`,
      `Host: localhost:${upstreamPort}`,
      `Proxy-Authorization: Bearer ${bearerToken}`,
      "",
      "",
    ].join("\r\n"));

    const connectResponse = await new Promise<Buffer>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.includes("\r\n\r\n")) {
          rawSocket.off("data", onData);
          resolve(buffer);
        }
      };
      rawSocket.on("data", onData);
      rawSocket.once("error", reject);
      setTimeout(() => reject(new Error("Timeout waiting for CONNECT response")), 5_000);
    });

    assert.match(connectResponse.toString("utf8"), /^HTTP\/1\.1 200 Connection Established/);

    const tlsSocket = tls.connect({
      ca: ca.cert,
      rejectUnauthorized: true,
      servername: "localhost",
      socket: rawSocket,
    });

    await new Promise<void>((resolve, reject) => {
      tlsSocket.once("secureConnect", resolve);
      tlsSocket.once("error", reject);
      setTimeout(() => reject(new Error("Timeout waiting for TLS handshake")), 5_000);
    });

    tlsSocket.write([
      "GET /secure HTTP/1.1",
      `Host: localhost:${upstreamPort}`,
      "X-Api-Key: SANDY_TOKEN_api_key",
      "Proxy-Connection: keep-alive",
      "Connection: close",
      "",
      "",
    ].join("\r\n"));

    const response = await new Promise<Buffer>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
      };
      tlsSocket.on("data", onData);
      tlsSocket.once("end", () => {
        resolve(buffer);
      });
      tlsSocket.once("error", reject);
      setTimeout(() => reject(new Error("Timeout waiting for HTTPS response")), 5_000);
    });

    const responseStr = response.toString("utf8");
    assert.match(responseStr, /^HTTP\/1\.1 200 OK/);
    assert.match(responseStr, /secure-ok/);
    assert.strictEqual(upstreamUrl, "/secure");
    assert.ok(upstreamHeaders);
    assert.strictEqual(upstreamHeaders["x-api-key"], "real-secret-key");
    assert.strictEqual(upstreamHeaders["proxy-connection"], undefined);
    assert.strictEqual(upstreamHeaders["proxy-authorization"], undefined);
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
});
