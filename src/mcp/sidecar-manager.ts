import { mkdir } from "node:fs/promises";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { McpServerConfig } from "../config.js";
import { logger } from "../logger.js";
import type { PrivilegeResolutionResult } from "../types.js";
import { ProxyAccess } from "../proxy-access.js";
import type { McpUpstreamMethod } from "./sidecar-protocol.js";
import type {
  AuthorizeMcpResourceRead,
  AuthorizeMcpToolCall,
  ExecuteNativeToolCall,
} from "./proxy-contract.js";
import { buildHostOauthStateDirectory, sidecarOauthMountPath } from "./oauth-paths.js";
import { mcpProxyContainerAlias } from "./proxy-route.js";
import { mcpWorkerNetworkNamePrefix } from "./worker-network-name.js";
import {
  parseMcpSidecarToHostMessage,
  type McpSidecarAuthorizationRequestMessage,
  type McpSidecarNativeToolCallRequestMessage,
  type McpSidecarResourceAuthorizationRequestMessage,
  type McpSidecarLogMessage,
  type McpSidecarUpstreamRequestMessage,
} from "./sidecar-protocol.js";

type McpSidecarManagerOptions = {
  configDirectory: string;
  mcpServers: Record<string, McpServerConfig>;
  workerNetworkName: string;
  sidecarImage: string;
  startupTimeoutMs?: number;
  spawnImpl?: typeof spawn;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  authorizeToolCall: AuthorizeMcpToolCall;
  authorizeResourceRead: AuthorizeMcpResourceRead;
  executeNativeToolCall: ExecuteNativeToolCall;
  executeUpstreamMcpRequest: (input: {
    taskId: string;
    serverId: string;
    method: McpUpstreamMethod;
    params: unknown;
  }) => Promise<unknown>;
};

export class McpSidecarManager {
  private readonly containerName = `sandy-mcp-proxy-${randomUUID()}`;
  private readonly hostGatewayAlias = "host.docker.internal:host-gateway";
  private readonly startupTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private child: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly options: McpSidecarManagerOptions,
    private readonly access: ProxyAccess,
  ) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 300_000;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    const oauthStateDirectory = buildHostOauthStateDirectory(this.options.configDirectory);
    await mkdir(oauthStateDirectory, { recursive: true });
    await this.pruneStaleNetworks();
    await this.runDockerCommand(["network", "create", this.options.workerNetworkName]);

    const child = this.spawnImpl("docker", [
      "run",
      "--rm",
      "-i",
      "--name",
      this.containerName,
      "--network",
      this.options.workerNetworkName,
      "--network-alias",
      mcpProxyContainerAlias,
      "--add-host",
      this.hostGatewayAlias,
      "-v",
      `${oauthStateDirectory}:${sidecarOauthMountPath}`,
      this.options.sidecarImage,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const stdout = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    let ready = false;
    let startupResolved = false;
    let startupReject: ((reason?: unknown) => void) | null = null;
    const startupPromise = new Promise<void>((resolve, reject) => {
      startupReject = reject;
      const timer = this.setTimeoutImpl(() => {
        if (!ready) {
          reject(new Error("MCP sidecar did not become ready in time."));
        }
      }, this.startupTimeoutMs);

      const finish = (fn: () => void) => {
        if (startupResolved) {
          return;
        }
        startupResolved = true;
        this.clearTimeoutImpl(timer);
        fn();
      };

      stdout.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        try {
          const message = parseMcpSidecarToHostMessage(trimmed);
          if (message.type === "ready") {
            ready = true;
            finish(resolve);
            return;
          }
          if (message.type === "fatal_error") {
            finish(() => reject(new Error(`MCP sidecar failed: ${message.message}`)));
            return;
          }
          if (message.type === "authorization_request") {
            this.dispatchAuthorizationRequest(message);
            return;
          }
          if (message.type === "resource_authorization_request") {
            this.dispatchResourceAuthorizationRequest(message);
            return;
          }
          if (message.type === "native_tool_call_request") {
            this.dispatchNativeToolCallRequest(message);
            return;
          }
          if (message.type === "upstream_request") {
            this.dispatchUpstreamRequest(message);
            return;
          }
          if (message.type === "log") {
            this.forwardSidecarLog(message);
            return;
          }
        } catch (error) {
          logger.warn("mcp.sidecar.stdout_invalid", {
            message: error instanceof Error ? error.message : "Invalid sidecar output.",
            line: trimmed,
          });
        }
      });

      child.once("exit", (code, signal) => {
        this.child = null;
        if (!ready) {
          finish(() => reject(new Error(`MCP sidecar exited before ready (code=${code}, signal=${signal}).`)));
          return;
        }
        logger.warn("mcp.sidecar.exited", {
          code,
          signal,
        });
      });
    });

    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        logger.warn("mcp.sidecar.stderr", {
          message,
        });
      }
    });

    child.once("error", (error) => {
      startupReject?.(error);
    });

    this.sendToSidecar({
      type: "bootstrap",
      oauthStateDirectory: sidecarOauthMountPath,
      workerProxyTokenSecret: this.access.sharedSecret,
      mcpServers: this.options.mcpServers,
    });

    try {
      await startupPromise;
      logger.info("mcp.sidecar.started", {
        containerName: this.containerName,
        networkName: this.options.workerNetworkName,
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;

    if (this.child) {
      try {
        this.sendToSidecar({ type: "shutdown" });
      } catch {
        // Ignore broken control-channel errors during shutdown.
      }
      this.child.stdin.end();
      this.child.kill("SIGTERM");
      this.child = null;
      await this.runDockerCommand(["rm", "-f", this.containerName], true);
    }

    if (this.started) {
      await this.runDockerCommand(["network", "rm", this.options.workerNetworkName], true);
    }
  }

  private dispatchAuthorizationRequest(message: McpSidecarAuthorizationRequestMessage): void {
    void this.handleAuthorizationRequest(message).catch((error) => {
      const failureMessage = error instanceof Error ? error.message : "Unknown authorization request failure.";

      logger.warn("mcp.sidecar.authorization_request_failed", {
        requestId: message.requestId,
        taskId: message.taskId,
        serverId: message.serverId,
        toolName: message.toolName,
        message: failureMessage,
      });

      this.sendToSidecar({
        type: "authorization_result",
        requestId: message.requestId,
        result: {
          requestId: message.requestId,
          outcome: "failed",
          message: failureMessage,
        } satisfies PrivilegeResolutionResult,
      });
    });
  }

  private async handleAuthorizationRequest(message: McpSidecarAuthorizationRequestMessage): Promise<void> {
    const result = await this.options.authorizeToolCall({
      taskId: message.taskId,
      serverId: message.serverId,
      toolName: message.toolName,
      arguments: message.arguments,
    });

    this.sendToSidecar({
      type: "authorization_result",
      requestId: message.requestId,
      result,
    });
  }

  private dispatchResourceAuthorizationRequest(message: McpSidecarResourceAuthorizationRequestMessage): void {
    void this.handleResourceAuthorizationRequest(message).catch((error) => {
      const failureMessage = error instanceof Error ? error.message : "Unknown resource authorization request failure.";

      logger.warn("mcp.sidecar.resource_authorization_request_failed", {
        requestId: message.requestId,
        taskId: message.taskId,
        serverId: message.serverId,
        uri: message.uri,
        message: failureMessage,
      });

      this.sendToSidecar({
        type: "authorization_result",
        requestId: message.requestId,
        result: {
          requestId: message.requestId,
          outcome: "failed",
          message: failureMessage,
        } satisfies PrivilegeResolutionResult,
      });
    });
  }

  private async handleResourceAuthorizationRequest(message: McpSidecarResourceAuthorizationRequestMessage): Promise<void> {
    const result = await this.options.authorizeResourceRead({
      taskId: message.taskId,
      serverId: message.serverId,
      uri: message.uri,
    });

    this.sendToSidecar({
      type: "authorization_result",
      requestId: message.requestId,
      result,
    });
  }

  private dispatchNativeToolCallRequest(message: McpSidecarNativeToolCallRequestMessage): void {
    void this.handleNativeToolCallRequest(message).catch((error) => {
      const failureMessage = error instanceof Error ? error.message : "Unknown native tool call request failure.";

      logger.warn("mcp.sidecar.native_tool_call_request_failed", {
        requestId: message.requestId,
        taskId: message.taskId,
        toolName: message.toolName,
        message: failureMessage,
      });

      this.sendToSidecar({
        type: "native_tool_call_result",
        requestId: message.requestId,
        isError: true,
        message: failureMessage,
      });
    });
  }

  private dispatchUpstreamRequest(message: McpSidecarUpstreamRequestMessage): void {
    void this.handleUpstreamRequest(message).catch((error) => {
      const failureMessage = error instanceof Error ? error.message : "Unknown upstream MCP request failure.";

      logger.warn("mcp.sidecar.upstream_request_failed", {
        requestId: message.requestId,
        taskId: message.taskId,
        serverId: message.serverId,
        method: message.method,
        message: failureMessage,
      });

      this.sendToSidecar({
        type: "upstream_result",
        requestId: message.requestId,
        ok: false,
        errorMessage: failureMessage,
      });
    });
  }

  private async handleUpstreamRequest(message: McpSidecarUpstreamRequestMessage): Promise<void> {
    logger.debug("mcp.sidecar.upstream_request_executing", {
      requestId: message.requestId,
      taskId: message.taskId,
      serverId: message.serverId,
      method: message.method,
      params: message.params,
    });

    const result = await this.options.executeUpstreamMcpRequest({
      taskId: message.taskId,
      serverId: message.serverId,
      method: message.method,
      params: message.params,
    });

    logger.debug("mcp.sidecar.upstream_request_executed", {
      requestId: message.requestId,
      taskId: message.taskId,
      serverId: message.serverId,
      method: message.method,
    });

    this.sendToSidecar({
      type: "upstream_result",
      requestId: message.requestId,
      ok: true,
      result,
    });
  }

  private async handleNativeToolCallRequest(message: McpSidecarNativeToolCallRequestMessage): Promise<void> {
    logger.debug("mcp.sidecar.native_tool_call_executing", {
      requestId: message.requestId,
      taskId: message.taskId,
      toolName: message.toolName,
      arguments: message.arguments,
    });

    try {
      const result = await this.options.executeNativeToolCall({
        taskId: message.taskId,
        toolName: message.toolName,
        arguments: message.arguments,
      });

      logger.debug("mcp.sidecar.native_tool_call_executed", {
        requestId: message.requestId,
        taskId: message.taskId,
        toolName: message.toolName,
        isError: result.isError,
      });

      this.sendToSidecar({
        type: "native_tool_call_result",
        requestId: message.requestId,
        isError: result.isError,
        message: result.message,
      });
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : "Unknown native tool call failure.";

      logger.warn("mcp.sidecar.native_tool_call_failed", {
        requestId: message.requestId,
        taskId: message.taskId,
        toolName: message.toolName,
        message: failureMessage,
      });

      this.sendToSidecar({
        type: "native_tool_call_result",
        requestId: message.requestId,
        isError: true,
        message: failureMessage,
      });
    }
  }

  private forwardSidecarLog(message: McpSidecarLogMessage): void {
    switch (message.level) {
      case "debug":
        logger.debug(message.event, message.data);
        return;
      case "info":
        logger.info(message.event, message.data);
        return;
      case "warn":
        logger.warn(message.event, message.data);
        return;
      case "error":
        logger.error(message.event, null, undefined, message.data);
        return;
    }
  }

  private sendToSidecar(message: object): void {
    if (!this.child) {
      throw new Error("MCP sidecar is not running.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async pruneStaleNetworks(): Promise<void> {
    const existingNetworkNames = await this.runDockerCommandCapture(["network", "ls", "--format", "{{.Name}}"]);
    const staleNetworkNames = existingNetworkNames
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name.startsWith(mcpWorkerNetworkNamePrefix) && name !== this.options.workerNetworkName);

    for (const networkName of staleNetworkNames) {
      await this.runDockerCommand(["network", "rm", networkName], true);
    }
  }

  private async runDockerCommand(args: string[], ignoreFailure = false): Promise<void> {
    await this.runDockerCommandCapture(args, ignoreFailure);
  }

  private async runDockerCommandCapture(args: string[], ignoreFailure = false): Promise<string> {
    const child = this.spawnImpl("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    return await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0 || ignoreFailure) {
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() || `docker ${args.join(" ")} exited with code ${code}`));
      });
    });
  }
}
