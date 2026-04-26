import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { configureLogger } from "../logger.js";
import { SandyMcpProxy } from "./proxy.js";
import { SandyMcpProxyAccess } from "./proxy-access.js";
import { McpServerRegistryImpl } from "./server-registry.js";
import { parseHostToMcpSidecarMessage, type McpSidecarBootstrapMessage } from "./sidecar-protocol.js";
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
  const access = new SandyMcpProxyAccess(bootstrap.workerProxyTokenSecret);
  const registry = new McpServerRegistryImpl(bootstrap.oauthStateDirectory, bootstrap.mcpServers);
  const pendingAuthorization = new Map<string, (result: PrivilegeResolutionResult) => void>();
  let shuttingDown = false;

  const hasMcpServers = Object.keys(bootstrap.mcpServers).length > 0;

  let mcpProxy: SandyMcpProxy | null = null;

  if (hasMcpServers) {
    mcpProxy = new SandyMcpProxy({
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
    });
  }

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
      if (message.type === "shutdown") {
        shuttingDown = true;
        void shutdownAll().finally(() => {
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

  async function shutdownAll(): Promise<void> {
    const stops: Promise<void>[] = [];
    if (mcpProxy) stops.push(mcpProxy.stop());
    await Promise.all(stops);
  }

  try {
    const starts: Promise<void>[] = [];
    if (mcpProxy) starts.push(mcpProxy.start());
    await Promise.all(starts);
    send({ type: "ready" });
  } catch (error) {
    send({
      type: "fatal_error",
      message: error instanceof Error ? error.message : "Sidecar failed to start.",
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
