import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { configureLogger, logger } from "../logger.js";
import { SandyMcpProxy } from "./proxy.js";
import { ProxyAccess } from "../proxy-access.js";
import { McpServerRegistryImpl } from "./server-registry.js";
import {
  parseHostToMcpSidecarMessage,
  type McpSidecarBootstrapMessage,
  type McpSidecarUpstreamRequestMessage,
  type McpSidecarUpstreamResultMessage,
} from "./sidecar-protocol.js";
import type { NativeToolCallResult } from "./proxy-contract.js";
import type { PrivilegeResolutionResult } from "../types.js";

function send(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function main(): Promise<void> {
  configureLogger({
    forwardLog: (payload) => {
      send({
        type: "log",
        ...payload,
      });
    },
  });

  const input = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  const bootstrap = await readBootstrapMessage(input);
  const access = new ProxyAccess(bootstrap.workerProxyTokenSecret);
  const pendingUpstreamRequests = new Map<string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();
  const registry = new McpServerRegistryImpl(
    bootstrap.oauthStateDirectory,
    bootstrap.mcpServers,
    async (request) => await requestHostMcp(request, pendingUpstreamRequests),
  );
  const pendingAuthorization = new Map<string, (result: PrivilegeResolutionResult) => void>();
  const pendingNativeToolCalls = new Map<string, (result: NativeToolCallResult) => void>();
  let shuttingDown = false;

  const proxy = new SandyMcpProxy({
    access,
    registry,
    port: 8080,
    authorizeToolCall: async (request) => {
      const requestId = randomUUID();
      send({
        type: "authorization_request",
        requestId,
        ...request,
      });

      return await new Promise<PrivilegeResolutionResult>((resolve) => {
        pendingAuthorization.set(requestId, resolve);
      });
    },
    authorizeResourceRead: async (request) => {
      const requestId = randomUUID();
      send({
        type: "resource_authorization_request",
        requestId,
        ...request,
      });

      return await new Promise<PrivilegeResolutionResult>((resolve) => {
        pendingAuthorization.set(requestId, resolve);
      });
    },
    executeNativeToolCall: async (request) => {
      const requestId = randomUUID();
      send({
        type: "native_tool_call_request",
        requestId,
        ...request,
      });

      return await new Promise<NativeToolCallResult>((resolve) => {
        pendingNativeToolCalls.set(requestId, resolve);
      });
    },
  });

  input.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed || shuttingDown) {
      return;
    }

    try {
      const message = parseHostToMcpSidecarMessage(trimmed);
      if (message.type === "authorization_result") {
        pendingAuthorization.get(message.requestId)?.(message.result);
        pendingAuthorization.delete(message.requestId);
        return;
      }
      if (message.type === "native_tool_call_result") {
        pendingNativeToolCalls.get(message.requestId)?.({
          isError: message.isError,
          message: message.message,
        });
        pendingNativeToolCalls.delete(message.requestId);
        return;
      }
      if (message.type === "upstream_result") {
        handleUpstreamResult(message, pendingUpstreamRequests);
        return;
      }
      if (message.type === "release_task") {
        void Promise.resolve(registry.releaseTask?.(message.taskId)).catch((error) => {
          logger.warn("mcp.registry.task_release_failed", {
            taskId: message.taskId,
            message: error instanceof Error ? error.message : "Unknown task release failure.",
          });
        });
        return;
      }
      if (message.type === "shutdown") {
        shuttingDown = true;
        void proxy.stop().finally(() => {
          process.exit(0);
        });
      }
    } catch (error) {
      send({
        type: "fatal_error",
        message: error instanceof Error ? error.message : "Invalid host-side sidecar control message.",
      });
    }
  });

  try {
    await proxy.start();
    send({ type: "ready" });
  } catch (error) {
    send({
      type: "fatal_error",
      message: error instanceof Error ? error.message : "MCP sidecar failed to start.",
    });
    process.exit(1);
  }
}

async function readBootstrapMessage(input: ReturnType<typeof createInterface>): Promise<McpSidecarBootstrapMessage> {
  return await new Promise<McpSidecarBootstrapMessage>((resolve, reject) => {
    const onLine = (line: string) => {
      try {
        const message = parseHostToMcpSidecarMessage(line);
        if (message.type !== "bootstrap") {
          input.off("line", onLine);
          reject(new Error(`Expected bootstrap message, received ${message.type}.`));
          return;
        }
        input.off("line", onLine);
        resolve(message);
      } catch (error) {
        input.off("line", onLine);
        reject(error instanceof Error ? error : new Error("Invalid bootstrap message."));
      }
    };

    input.on("line", onLine);
    input.once("close", () => {
      reject(new Error("Host control channel closed before sidecar bootstrap."));
    });
  });
}

async function requestHostMcp(
  request: Omit<McpSidecarUpstreamRequestMessage, "type" | "requestId">,
  pendingUpstreamRequests: Map<string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>,
): Promise<unknown> {
  const requestId = randomUUID();
  const pending = await new Promise<unknown>((resolve, reject) => {
    pendingUpstreamRequests.set(requestId, {
      resolve,
      reject,
    });
    send({
      type: "upstream_request",
      requestId,
      ...request,
    });
  });
  return pending;
}

function handleUpstreamResult(
  message: McpSidecarUpstreamResultMessage,
  pendingUpstreamRequests: Map<string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>,
): void {
  const pending = pendingUpstreamRequests.get(message.requestId);
  if (!pending) {
    return;
  }
  pendingUpstreamRequests.delete(message.requestId);
  if (message.ok) {
    pending.resolve(message.result);
    return;
  }
  pending.reject(new Error(message.errorMessage));
}
