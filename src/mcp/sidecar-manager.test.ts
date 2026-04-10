import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { McpSidecarManager } from "./sidecar-manager.js";
import { SandyMcpProxyAccess } from "./proxy-access.js";
import { createMcpWorkerNetworkName } from "./worker-network-name.js";

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
  const invocations: Array<{ command: string; args: string[] }> = [];
  const spawnImpl = ((command: string, args: readonly string[]) => {
    invocations.push({ command, args: [...args] });
    const child = new FakeChildProcess();
    if (args[0] === "run") {
      sidecarChild.stdout.write('{"type":"ready"}\n');
      return sidecarChild as unknown as ChildProcessWithoutNullStreams;
    }
    queueMicrotask(() => {
      child.emit("exit", 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const access = new SandyMcpProxyAccess("shared-secret");
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
  }, access);

  await manager.start();
  await manager.stop();

  assert.equal(invocations[0].args[0], "network");
  assert.equal(invocations[0].args[1], "create");
  assert.equal(invocations[0].args[2], workerNetworkName);
  assert.ok(invocations.some((invocation) => invocation.args[0] === "run" && invocation.args.includes("--network-alias")));
  assert.ok(invocations.some((invocation) => invocation.args[0] === "network" && invocation.args[1] === "rm"));
  assert.match(stdinContent, /"type":"bootstrap"/);
  assert.match(stdinContent, /"workerProxyTokenSecret":"shared-secret"/);
});
