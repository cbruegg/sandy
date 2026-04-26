import { test } from "bun:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { SandyMcpProxyAccess } from "../mcp/proxy-access.js";
import { ProxyAuthService } from "./proxy-auth-service.js";
import { serializeProxyAuthRequest } from "./proxy-auth-protocol.js";

const TEST_SOCKET_PATH = "/tmp/sandy-test-proxy-auth.sock";

function cleanupSocket(): void {
  if (existsSync(TEST_SOCKET_PATH)) {
    unlinkSync(TEST_SOCKET_PATH);
  }
}

async function sendAuthRequest(
  socketPath: string,
  request: {
    proxyAuthUsername: string;
    proxyAuthPassword: string;
    targetHost: string;
    headers: Array<{ name: string; value: string }>;
  },
): Promise<{ outcome: string; message?: string; headers?: Array<{ name: string; value: string }> }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";

    socket.on("connect", () => {
      socket.write(serializeProxyAuthRequest(request));
    });

    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) {
          try {
            resolve(JSON.parse(line) as { outcome: string; message?: string; headers?: Array<{ name: string; value: string }> });
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Failed to parse authorization response."));
          }
          socket.end();
          return;
        }
      }
    });

    socket.on("error", reject);
  });
}

test("ProxyAuthService resolves headers for approved requests", async () => {
  cleanupSocket();
  const access = new SandyMcpProxyAccess("test-secret");
  const service = new ProxyAuthService({
    socketPath: TEST_SOCKET_PATH,
    access,
    httpTokens: { token_1: { value: "real-secret" } },
    authorizeHttpTokenUse: async () => ({ outcome: "approved", message: "ok" }),
  });
  await service.start();

  const result = await sendAuthRequest(TEST_SOCKET_PATH, {
    proxyAuthUsername: "Bearer",
    proxyAuthPassword: access.issueWorkerGrant("task-1").bearerToken,
    targetHost: "api.example.com",
    headers: [
      { name: "x-api-key", value: "SANDY_TOKEN_token_1" },
      { name: "proxy-connection", value: "keep-alive" },
    ],
  });

  assert.equal(result.outcome, "approved");
  assert.deepEqual(result.headers, [
    { name: "x-api-key", value: "real-secret" },
  ]);

  await service.stop();
});

test("ProxyAuthService denies rejected token approvals", async () => {
  cleanupSocket();
  const access = new SandyMcpProxyAccess("test-secret");
  const service = new ProxyAuthService({
    socketPath: TEST_SOCKET_PATH,
    access,
    httpTokens: { token_1: { value: "real-secret" } },
    authorizeHttpTokenUse: async () => ({ outcome: "denied", message: "not allowed" }),
  });
  await service.start();

  const result = await sendAuthRequest(TEST_SOCKET_PATH, {
    proxyAuthUsername: "Bearer",
    proxyAuthPassword: access.issueWorkerGrant("task-1").bearerToken,
    targetHost: "api.example.com",
    headers: [{ name: "authorization", value: "Bearer SANDY_TOKEN_token_1" }],
  });

  assert.equal(result.outcome, "denied");
  assert.equal(result.message, "not allowed");

  await service.stop();
});

test("ProxyAuthService handles authorization errors gracefully", async () => {
  cleanupSocket();
  const access = new SandyMcpProxyAccess("test-secret");
  const service = new ProxyAuthService({
    socketPath: TEST_SOCKET_PATH,
    access,
    httpTokens: { token_1: { value: "real-secret" } },
    authorizeHttpTokenUse: async () => {
      throw new Error("database down");
    },
  });
  await service.start();

  const result = await sendAuthRequest(TEST_SOCKET_PATH, {
    proxyAuthUsername: "Bearer",
    proxyAuthPassword: access.issueWorkerGrant("task-1").bearerToken,
    targetHost: "api.example.com",
    headers: [{ name: "authorization", value: "Bearer SANDY_TOKEN_token_1" }],
  });

  assert.equal(result.outcome, "failed");
  assert.match(result.message ?? "", /database down/);

  await service.stop();
});

test("ProxyAuthService handles invalid request format", async () => {
  cleanupSocket();
  const service = new ProxyAuthService({
    socketPath: TEST_SOCKET_PATH,
    access: new SandyMcpProxyAccess("test-secret"),
    httpTokens: { token_1: { value: "real-secret" } },
    authorizeHttpTokenUse: async () => ({ outcome: "approved", message: "ok" }),
  });
  await service.start();

  const result = await new Promise<{ outcome: string; message: string }>((resolve, reject) => {
    const socket = createConnection(TEST_SOCKET_PATH);
    let buffer = "";

    socket.on("connect", () => {
      socket.write("not-json\n");
    });

    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) {
          try {
            resolve(JSON.parse(line) as { outcome: string; message: string });
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Failed to parse invalid-request response."));
          }
          socket.end();
          return;
        }
      }
    });

    socket.on("error", reject);
  });

  assert.equal(result.outcome, "failed");
  assert.match(result.message, /Invalid authorization request format/);

  await service.stop();
});

test("ProxyAuthService cleans up socket on stop", async () => {
  cleanupSocket();
  const service = new ProxyAuthService({
    socketPath: TEST_SOCKET_PATH,
    access: new SandyMcpProxyAccess("test-secret"),
    httpTokens: { token_1: { value: "real-secret" } },
    authorizeHttpTokenUse: async () => ({ outcome: "approved", message: "ok" }),
  });
  await service.start();
  assert.ok(existsSync(TEST_SOCKET_PATH));

  await service.stop();
  assert.ok(!existsSync(TEST_SOCKET_PATH));
});

test("ProxyAuthService denies invalid worker grants", async () => {
  cleanupSocket();
  const service = new ProxyAuthService({
    socketPath: TEST_SOCKET_PATH,
    access: new SandyMcpProxyAccess("test-secret"),
    httpTokens: { token_1: { value: "real-secret" } },
    authorizeHttpTokenUse: async () => ({ outcome: "approved", message: "ok" }),
  });
  await service.start();

  const result = await sendAuthRequest(TEST_SOCKET_PATH, {
    proxyAuthUsername: "Bearer",
    proxyAuthPassword: "invalid",
    targetHost: "api.example.com",
    headers: [{ name: "authorization", value: "Bearer SANDY_TOKEN_token_1" }],
  });

  assert.equal(result.outcome, "denied");
  assert.match(result.message ?? "", /(invalid|malformed)/i);

  await service.stop();
});
