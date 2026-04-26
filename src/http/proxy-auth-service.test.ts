import { test } from "bun:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { ProxyAuthService } from "./proxy-auth-service.js";

const TEST_SOCKET_PATH = "/tmp/sandy-test-proxy-auth.sock";

function cleanupSocket(): void {
  if (existsSync(TEST_SOCKET_PATH)) {
    unlinkSync(TEST_SOCKET_PATH);
  }
}

async function sendAuthRequest(
  socketPath: string,
  request: { taskId: string; tokenId: string; host: string },
): Promise<{ outcome: string; message: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
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

test("ProxyAuthService approves authorized requests", async () => {
  cleanupSocket();
  const service = new ProxyAuthService({
    socketPath: TEST_SOCKET_PATH,
    authorize: async () => ({ outcome: "approved", message: "ok" }),
  });
  await service.start();

  const result = await sendAuthRequest(TEST_SOCKET_PATH, {
    taskId: "task-1",
    tokenId: "token-1",
    host: "api.example.com",
  });

  assert.equal(result.outcome, "approved");
  assert.equal(result.message, "ok");

  await service.stop();
});

test("ProxyAuthService denies unauthorized requests", async () => {
  cleanupSocket();
  const service = new ProxyAuthService({
    socketPath: TEST_SOCKET_PATH,
    authorize: async () => ({ outcome: "denied", message: "not allowed" }),
  });
  await service.start();

  const result = await sendAuthRequest(TEST_SOCKET_PATH, {
    taskId: "task-1",
    tokenId: "token-1",
    host: "api.example.com",
  });

  assert.equal(result.outcome, "denied");
  assert.equal(result.message, "not allowed");

  await service.stop();
});

test("ProxyAuthService handles authorization errors gracefully", async () => {
  cleanupSocket();
  const service = new ProxyAuthService({
    socketPath: TEST_SOCKET_PATH,
    authorize: async () => {
      throw new Error("database down");
    },
  });
  await service.start();

  const result = await sendAuthRequest(TEST_SOCKET_PATH, {
    taskId: "task-1",
    tokenId: "token-1",
    host: "api.example.com",
  });

  assert.equal(result.outcome, "failed");
  assert.match(result.message, /database down/);

  await service.stop();
});

test("ProxyAuthService handles invalid request format", async () => {
  cleanupSocket();
  const service = new ProxyAuthService({
    socketPath: TEST_SOCKET_PATH,
    authorize: async () => ({ outcome: "approved", message: "ok" }),
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
    authorize: async () => ({ outcome: "approved", message: "ok" }),
  });
  await service.start();
  assert.ok(existsSync(TEST_SOCKET_PATH));

  await service.stop();
  assert.ok(!existsSync(TEST_SOCKET_PATH));
});
