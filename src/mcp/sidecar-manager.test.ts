import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as setImmediateCallback } from "node:timers";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { McpSidecarManager } from "./sidecar-manager.js";
import { ProxyAccess } from "../proxy-access.js";
import { createMcpWorkerNetworkName, mcpWorkerNetworkNamePrefix } from "./worker-network-name.js";

class FakeChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly killSignals: Array<NodeJS.Signals | number> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal ?? "SIGTERM");
    return true;
  }
}

test("McpSidecarManager creates the Docker network, bootstraps the sidecar, and removes the network on shutdown", async () => {
  const sidecarChild = new FakeChildProcess();
  let stdinContent = "";
  sidecarChild.stdin.on("data", (chunk: Buffer | string) => {
    stdinContent += String(chunk);
  });
  const invocations: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    invocations.push([...args]);
    const child = new FakeChildProcess();
    if (args[0] === "network" && args[1] === "ls") {
      queueMicrotask(() => {
        child.stdout.write(`${mcpWorkerNetworkNamePrefix}stale-one\nbridge\n`);
        child.emit("exit", 0, null);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }
    if (args[0] === "run") {
      sidecarChild.stdout.write('{"type":"ready"}\n');
      return sidecarChild as unknown as ChildProcessWithoutNullStreams;
    }
    queueMicrotask(() => {
      child.emit("exit", 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const access = new ProxyAccess("shared-secret");
  const workerNetworkName = createMcpWorkerNetworkName();
  const manager = new McpSidecarManager({
    configDirectory: "/tmp/sandy-config",
    mcpServers: {
      todoist: {
        transport: "streamable_http",
        url: "https://todoist.example/mcp",
        oauthScopes: [],
      },
    },
    workerNetworkName,
    sidecarImage: "sandy-mcp-proxy:latest",
    spawnImpl,
    authorizeToolCall: async () => ({
      requestId: "approval-1",
      outcome: "approved",
      message: "approved",
    }),
    authorizeResourceRead: async () => ({
      requestId: "approval-1",
      outcome: "approved",
      message: "approved",
    }),
    executeNativeToolCall: async () => ({
      isError: false,
      message: "ok",
    }),
    executeUpstreamMcpRequest: async () => ({}),
  }, access);

  await manager.start();
  await manager.stop();

  const firstInvocation = invocations[0];
  assert.deepEqual(firstInvocation, ["network", "ls", "--format", "{{.Name}}"]);
  const pruneInvocation = invocations[1];
  assert.deepEqual(pruneInvocation, ["network", "rm", `${mcpWorkerNetworkNamePrefix}stale-one`]);
  const createInvocation = invocations[2];
  assert.ok(createInvocation);
  assert.equal(createInvocation[0], "network");
  assert.equal(createInvocation[1], "create");
  assert.equal(createInvocation[2], workerNetworkName);
  const runInvocation = invocations.find((invocation) => invocation[0] === "run");
  assert.ok(runInvocation);
  assert.ok(runInvocation.includes("--network-alias"));
  assert.ok(runInvocation.includes("--add-host"));
  assert.ok(runInvocation.includes("host.docker.internal:host-gateway"));
  assert.ok(runInvocation.some((arg) => arg.includes("/run/sandy-controller:ro")));
  assert.ok(runInvocation.some((arg) => arg.startsWith("SANDY_CONTROLLER_HEARTBEAT_PATH=")));
  assert.ok(runInvocation.some((arg) => arg.startsWith("SANDY_CONTROLLER_HEARTBEAT_TIMEOUT_MS=")));
  assert.ok(invocations.some((invocation) => invocation[0] === "network" && invocation[1] === "rm"));
  assert.match(stdinContent, /"type":"bootstrap"/);
  assert.match(stdinContent, /"workerProxyTokenSecret":"shared-secret"/);
});

test("McpSidecarManager returns a failed authorization result when authorization handling throws", async () => {
  const sidecarChild = new FakeChildProcess();
  let stdinContent = "";
  sidecarChild.stdin.on("data", (chunk: Buffer | string) => {
    stdinContent += String(chunk);
  });

  const spawnImpl = ((_command: string, args: readonly string[]) => {
    const child = new FakeChildProcess();
    if (args[0] === "network" && args[1] === "ls") {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }
    if (args[0] === "run") {
      sidecarChild.stdout.write('{"type":"ready"}\n');
      return sidecarChild as unknown as ChildProcessWithoutNullStreams;
    }
    queueMicrotask(() => {
      child.emit("exit", 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const manager = new McpSidecarManager({
    configDirectory: "/tmp/sandy-config",
    mcpServers: {
      todoist: {
        transport: "streamable_http",
        url: "https://todoist.example/mcp",
        oauthScopes: [],
      },
    },
    workerNetworkName: createMcpWorkerNetworkName(),
    sidecarImage: "sandy-mcp-proxy:latest",
    spawnImpl,
    authorizeToolCall: async () => {
      throw new Error("approval service unavailable");
    },
    authorizeResourceRead: async () => {
      throw new Error("approval service unavailable");
    },
    executeNativeToolCall: async () => ({
      isError: false,
      message: "ok",
    }),
    executeUpstreamMcpRequest: async () => ({}),
  }, new ProxyAccess("shared-secret"));

  await manager.start();
  sidecarChild.stdout.write(
    JSON.stringify({
      type: "authorization_request",
      requestId: "request-1",
      taskId: "task-1",
      serverId: "todoist",
      toolName: "list_tasks",
      arguments: { project: "Inbox" },
    }) + "\n",
  );
  await new Promise<void>((resolve) => setImmediateCallback(resolve));
  await manager.stop();

  assert.match(stdinContent, /"type":"authorization_result"/);
  assert.match(stdinContent, /"requestId":"request-1"/);
  assert.match(stdinContent, /"outcome":"failed"/);
  assert.match(stdinContent, /approval service unavailable/);
});

test("McpSidecarManager forwards structured sidecar logs through the host logger", async () => {
  const sidecarChild = new FakeChildProcess();
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    const child = new FakeChildProcess();
    if (args[0] === "network" && args[1] === "ls") {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }
    if (args[0] === "run") {
      sidecarChild.stdout.write('{"type":"ready"}\n');
      return sidecarChild as unknown as ChildProcessWithoutNullStreams;
    }
    queueMicrotask(() => {
      child.emit("exit", 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const forwardedLogs: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const originalConsoleLog = console.log;
  console.log = (value?: unknown, ...rest: unknown[]) => {
    if (typeof value === "string") {
      const parsed = JSON.parse(value) as {
        event?: string;
        data?: Record<string, unknown>;
      };
      if (parsed.event === "mcp.proxy.request_handled") {
        forwardedLogs.push({
          event: parsed.event,
          data: parsed.data,
        });
      }
    }
    return originalConsoleLog.call(console, value, ...rest);
  };

  const manager = new McpSidecarManager({
    configDirectory: "/tmp/sandy-config",
    mcpServers: {
      todoist: {
        transport: "streamable_http",
        url: "https://todoist.example/mcp",
        oauthScopes: [],
      },
    },
    workerNetworkName: createMcpWorkerNetworkName(),
    sidecarImage: "sandy-mcp-proxy:latest",
    spawnImpl,
    authorizeToolCall: async () => ({
      requestId: "approval-1",
      outcome: "approved",
      message: "approved",
    }),
    authorizeResourceRead: async () => ({
      requestId: "approval-1",
      outcome: "approved",
      message: "approved",
    }),
    executeNativeToolCall: async () => ({
      isError: false,
      message: "ok",
    }),
    executeUpstreamMcpRequest: async () => ({}),
  }, new ProxyAccess("shared-secret"));

  await manager.start();
  sidecarChild.stdout.write(
    JSON.stringify({
      type: "log",
      timestamp: "2026-04-18T20:00:00.000Z",
      level: "info",
      event: "mcp.proxy.request_handled",
      data: {
        taskId: "task-1",
        serverId: "homeassistant",
      },
    }) + "\n",
  );
  await new Promise<void>((resolve) => setImmediateCallback(resolve));
  await manager.stop();
  console.log = originalConsoleLog;

  assert.deepEqual(forwardedLogs, [{
    event: "mcp.proxy.request_handled",
    data: {
      taskId: "task-1",
      serverId: "homeassistant",
    },
  }]);
});

test("McpSidecarManager answers native Sandy tool calls over the control channel", async () => {
  const sidecarChild = new FakeChildProcess();
  let stdinContent = "";
  sidecarChild.stdin.on("data", (chunk: Buffer | string) => {
    stdinContent += String(chunk);
  });

  const spawnImpl = ((_command: string, args: readonly string[]) => {
    const child = new FakeChildProcess();
    if (args[0] === "network" && args[1] === "ls") {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }
    if (args[0] === "run") {
      sidecarChild.stdout.write('{"type":"ready"}\n');
      return sidecarChild as unknown as ChildProcessWithoutNullStreams;
    }
    queueMicrotask(() => {
      child.emit("exit", 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const manager = new McpSidecarManager({
    configDirectory: "/tmp/sandy-config",
    mcpServers: {},
    workerNetworkName: createMcpWorkerNetworkName(),
    sidecarImage: "sandy-mcp-proxy:latest",
    spawnImpl,
    authorizeToolCall: async () => ({
      requestId: "approval-1",
      outcome: "approved",
      message: "approved",
    }),
    authorizeResourceRead: async () => ({
      requestId: "approval-1",
      outcome: "approved",
      message: "approved",
    }),
    executeNativeToolCall: async () => ({
      isError: false,
      message: "native-ok",
    }),
    executeUpstreamMcpRequest: async () => ({}),
  }, new ProxyAccess("shared-secret"));

  await manager.start();
  sidecarChild.stdout.write(
    JSON.stringify({
      type: "native_tool_call_request",
      requestId: "request-1",
      taskId: "task-1",
      toolName: "send_file_to_channel",
      arguments: { path: "/workspace/share/test.txt" },
    }) + "\n",
  );
  await new Promise<void>((resolve) => setImmediateCallback(resolve));
  await manager.stop();

  assert.match(stdinContent, /"type":"native_tool_call_result"/);
  assert.match(stdinContent, /"requestId":"request-1"/);
  assert.match(stdinContent, /"isError":false/);
  assert.match(stdinContent, /native-ok/);
});

test("McpSidecarManager returns a failed native tool call result when native tool execution throws", async () => {
  const sidecarChild = new FakeChildProcess();
  let stdinContent = "";
  sidecarChild.stdin.on("data", (chunk: Buffer | string) => {
    stdinContent += String(chunk);
  });

  const spawnImpl = ((_command: string, args: readonly string[]) => {
    const child = new FakeChildProcess();
    if (args[0] === "network" && args[1] === "ls") {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }
    if (args[0] === "run") {
      sidecarChild.stdout.write('{"type":"ready"}\n');
      return sidecarChild as unknown as ChildProcessWithoutNullStreams;
    }
    queueMicrotask(() => {
      child.emit("exit", 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const manager = new McpSidecarManager({
    configDirectory: "/tmp/sandy-config",
    mcpServers: {},
    workerNetworkName: createMcpWorkerNetworkName(),
    sidecarImage: "sandy-mcp-proxy:latest",
    spawnImpl,
    authorizeToolCall: async () => ({
      requestId: "approval-1",
      outcome: "approved",
      message: "approved",
    }),
    authorizeResourceRead: async () => ({
      requestId: "approval-1",
      outcome: "approved",
      message: "approved",
    }),
    executeNativeToolCall: async () => {
      throw new Error("native tool failed");
    },
    executeUpstreamMcpRequest: async () => ({}),
  }, new ProxyAccess("shared-secret"));

  await manager.start();
  sidecarChild.stdout.write(
    JSON.stringify({
      type: "native_tool_call_request",
      requestId: "request-1",
      taskId: "task-1",
      toolName: "send_file_to_channel",
      arguments: { path: "/workspace/share/test.txt" },
    }) + "\n",
  );
  await new Promise<void>((resolve) => setImmediateCallback(resolve));
  await manager.stop();

  assert.match(stdinContent, /"type":"native_tool_call_result"/);
  assert.match(stdinContent, /"requestId":"request-1"/);
  assert.match(stdinContent, /"isError":true/);
  assert.match(stdinContent, /native tool failed/);
});

test("McpSidecarManager forwards stdio MCP requests to the host registry", async () => {
  const sidecarChild = new FakeChildProcess();
  let stdinContent = "";
  sidecarChild.stdin.on("data", (chunk: Buffer | string) => {
    stdinContent += String(chunk);
  });

  const spawnImpl = ((_command: string, args: readonly string[]) => {
    const child = new FakeChildProcess();
    if (args[0] === "network" && args[1] === "ls") {
      queueMicrotask(() => {
        child.emit("exit", 0, null);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    }
    if (args[0] === "run") {
      sidecarChild.stdout.write('{"type":"ready"}\n');
      return sidecarChild as unknown as ChildProcessWithoutNullStreams;
    }
    queueMicrotask(() => {
      child.emit("exit", 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const manager = new McpSidecarManager({
    configDirectory: "/tmp/sandy-config",
    mcpServers: {
      spotify: {
        transport: "stdio",
        command: "node",
        args: ["build/index.js"],
        workingDirectory: "/tmp/spotify",
        env: {},
      },
    },
    workerNetworkName: createMcpWorkerNetworkName(),
    sidecarImage: "sandy-mcp-proxy:latest",
    spawnImpl,
    authorizeToolCall: async () => ({
      requestId: "approval-1",
      outcome: "approved",
      message: "approved",
    }),
    authorizeResourceRead: async () => ({
      requestId: "approval-1",
      outcome: "approved",
      message: "approved",
    }),
    executeNativeToolCall: async () => ({
      isError: false,
      message: "ok",
    }),
    executeUpstreamMcpRequest: async (input) => ({
      serverId: input.serverId,
      method: input.method,
      params: input.params,
    }),
  }, new ProxyAccess("shared-secret"));

  await manager.start();
  sidecarChild.stdout.write(
    JSON.stringify({
      type: "upstream_request",
      requestId: "request-1",
      taskId: "task-1",
      serverId: "spotify",
      method: "callTool",
      params: {
        name: "play",
        arguments: {},
      },
    }) + "\n",
  );
  await new Promise<void>((resolve) => setImmediateCallback(resolve));
  await manager.stop();

  assert.match(stdinContent, /"type":"upstream_result"/);
  assert.match(stdinContent, /"requestId":"request-1"/);
  assert.match(stdinContent, /"ok":true/);
  assert.match(stdinContent, /"serverId":"spotify"/);
  assert.match(stdinContent, /"method":"callTool"/);
});
