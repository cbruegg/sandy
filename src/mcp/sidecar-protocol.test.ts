import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseHostToMcpSidecarMessage, parseMcpSidecarToHostMessage } from "./sidecar-protocol.js";

test("parseHostToMcpSidecarMessage accepts shutdown requests", () => {
  assert.deepEqual(parseHostToMcpSidecarMessage(JSON.stringify({
    type: "shutdown",
  })), {
    type: "shutdown",
  });
});

test("parseHostToMcpSidecarMessage accepts bootstrap messages", () => {
  const message = {
    type: "bootstrap",
    oauthStateDirectory: "/tmp/oauth",
    workerProxyTokenSecret: "secret123",
    mcpServers: {
      stdioServer: {
        transport: "stdio" as const,
        command: "node",
        args: ["server.js"],
        workingDirectory: "/app",
        env: { KEY: "value" },
      },
      httpServer: {
        transport: "streamable_http" as const,
        url: "http://localhost:3000",
        oauthScopes: ["read", "write"],
      },
    },
  };
  assert.deepEqual(parseHostToMcpSidecarMessage(JSON.stringify(message)), message);
});

test("parseHostToMcpSidecarMessage accepts authorization_result messages", () => {
  const message = {
    type: "authorization_result" as const,
    requestId: "req-1",
    result: {
      requestId: "req-1",
      outcome: "approved" as const,
      message: "Granted",
      scope: "once" as const,
    },
  };
  assert.deepEqual(parseHostToMcpSidecarMessage(JSON.stringify(message)), message);
});

test("parseHostToMcpSidecarMessage accepts native_tool_call_result messages", () => {
  const message = {
    type: "native_tool_call_result" as const,
    requestId: "req-2",
    isError: false,
    message: "Done",
  };
  assert.deepEqual(parseHostToMcpSidecarMessage(JSON.stringify(message)), message);
});

test("parseHostToMcpSidecarMessage accepts successful upstream_result messages", () => {
  const message = {
    type: "upstream_result" as const,
    requestId: "req-3",
    ok: true as const,
    result: { tools: [] },
  };
  assert.deepEqual(parseHostToMcpSidecarMessage(JSON.stringify(message)), message);
});

test("parseHostToMcpSidecarMessage accepts error upstream_result messages", () => {
  const message = {
    type: "upstream_result" as const,
    requestId: "req-4",
    ok: false as const,
    errorMessage: "Connection failed",
  };
  assert.deepEqual(parseHostToMcpSidecarMessage(JSON.stringify(message)), message);
});

test("parseHostToMcpSidecarMessage throws on invalid JSON", () => {
  assert.throws(() => parseHostToMcpSidecarMessage("not json"), /JSON/);
});

test("parseHostToMcpSidecarMessage throws on non-object input", () => {
  assert.throws(() => parseHostToMcpSidecarMessage("42"), /Invalid host-to-sidecar message/);
  assert.throws(() => parseHostToMcpSidecarMessage("null"), /Invalid host-to-sidecar message/);
  assert.throws(() => parseHostToMcpSidecarMessage('"string"'), /Invalid host-to-sidecar message/);
});

test("parseHostToMcpSidecarMessage throws on unsupported type", () => {
  assert.throws(
    () => parseHostToMcpSidecarMessage(JSON.stringify({ type: "unknown" })),
    /Unsupported host-to-sidecar message type/
  );
});

test("parseHostToMcpSidecarMessage throws on missing required fields", () => {
  assert.throws(
    () => parseHostToMcpSidecarMessage(JSON.stringify({ type: "bootstrap", oauthStateDirectory: "" })),
    /Too small/
  );
});

test("parseMcpSidecarToHostMessage accepts ready messages", () => {
  assert.deepEqual(parseMcpSidecarToHostMessage(JSON.stringify({ type: "ready" })), { type: "ready" });
});

test("parseMcpSidecarToHostMessage accepts authorization_request messages", () => {
  const message = {
    type: "authorization_request" as const,
    requestId: "req-1",
    taskId: "task-1",
    serverId: "server-1",
    toolName: "readFile",
    arguments: { path: "/tmp" },
  };
  assert.deepEqual(parseMcpSidecarToHostMessage(JSON.stringify(message)), message);
});

test("parseMcpSidecarToHostMessage accepts resource_authorization_request messages", () => {
  const message = {
    type: "resource_authorization_request" as const,
    requestId: "req-2",
    taskId: "task-1",
    serverId: "server-1",
    uri: "file:///tmp/data.txt",
  };
  assert.deepEqual(parseMcpSidecarToHostMessage(JSON.stringify(message)), message);
});

test("parseMcpSidecarToHostMessage accepts native_tool_call_request messages", () => {
  const message = {
    type: "native_tool_call_request" as const,
    requestId: "req-3",
    taskId: "task-1",
    toolName: "executeCode",
    arguments: { code: "1+1" },
  };
  assert.deepEqual(parseMcpSidecarToHostMessage(JSON.stringify(message)), message);
});

test("parseMcpSidecarToHostMessage accepts upstream_request messages", () => {
  const message = {
    type: "upstream_request" as const,
    requestId: "req-4",
    taskId: "task-1",
    serverId: "server-1",
    method: "listTools" as const,
    params: {},
  };
  assert.deepEqual(parseMcpSidecarToHostMessage(JSON.stringify(message)), message);
});

test("parseMcpSidecarToHostMessage accepts fatal_error messages", () => {
  const message = {
    type: "fatal_error" as const,
    message: "Something went wrong",
  };
  assert.deepEqual(parseMcpSidecarToHostMessage(JSON.stringify(message)), message);
});

test("parseMcpSidecarToHostMessage accepts log messages", () => {
  const message = {
    type: "log" as const,
    timestamp: "2024-01-01T00:00:00Z",
    level: "info" as const,
    event: "boot",
    data: { version: "1.0.0" },
  };
  assert.deepEqual(parseMcpSidecarToHostMessage(JSON.stringify(message)), message);
});

test("parseMcpSidecarToHostMessage accepts log messages without optional data", () => {
  const message = {
    type: "log" as const,
    timestamp: "2024-01-01T00:00:00Z",
    level: "warn" as const,
    event: "deprecated_api",
  };
  assert.deepEqual(parseMcpSidecarToHostMessage(JSON.stringify(message)), message);
});

test("parseMcpSidecarToHostMessage throws on invalid JSON", () => {
  assert.throws(() => parseMcpSidecarToHostMessage("not json"), /JSON/);
});

test("parseMcpSidecarToHostMessage throws on non-object input", () => {
  assert.throws(() => parseMcpSidecarToHostMessage("42"), /Invalid sidecar control message/);
  assert.throws(() => parseMcpSidecarToHostMessage("null"), /Invalid sidecar control message/);
  assert.throws(() => parseMcpSidecarToHostMessage('"string"'), /Invalid sidecar control message/);
});

test("parseMcpSidecarToHostMessage throws on unsupported type", () => {
  assert.throws(
    () => parseMcpSidecarToHostMessage(JSON.stringify({ type: "unknown" })),
    /Unsupported sidecar control message type/
  );
});

test("parseMcpSidecarToHostMessage throws on missing required fields", () => {
  assert.throws(
    () => parseMcpSidecarToHostMessage(JSON.stringify({ type: "fatal_error", message: "" })),
    /Too small/
  );
});
