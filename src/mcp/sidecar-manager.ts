import { mkdir } from "node:fs/promises";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { McpServerConfig } from "../config.js";
import { logger } from "../logger.js";
import type { PrivilegeResolutionResult } from "../types.js";
import { SandyMcpProxyAccess } from "./proxy-access.js";
import { buildHostOauthStateDirectory, sidecarOauthMountPath } from "./oauth-paths.js";
import { mcpProxyContainerAlias } from "./proxy-route.js";
import {
  parseMcpSidecarToHostMessage,
  type McpSidecarAuthorizationRequestMessage,
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
  authorizeToolCall: (input: {
    taskId: string;
    serverId: string;
    toolName: string;
    arguments: unknown;
  }) => Promise<PrivilegeResolutionResult>;
};

export class McpSidecarManager {
  private readonly containerName = `sandy-mcp-proxy-${randomUUID()}`;
  private readonly startupTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private child: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly options: McpSidecarManagerOptions,
    private readonly access: SandyMcpProxyAccess,
  ) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  }

  async start(): Promise<void> {
    if (this.started || Object.keys(this.options.mcpServers).length === 0) {
      return;
    }

    this.started = true;
    const oauthStateDirectory = buildHostOauthStateDirectory(this.options.configDirectory);
    await mkdir(oauthStateDirectory, { recursive: true });
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

      try {
        this.sendToSidecar({
          type: "authorization_result",
          requestId: message.requestId,
          result: {
            requestId: message.requestId,
            outcome: "failed",
            message: failureMessage,
          } satisfies PrivilegeResolutionResult,
        });
      } catch (sendError) {
        logger.warn("mcp.sidecar.authorization_result_failed", {
          requestId: message.requestId,
          taskId: message.taskId,
          serverId: message.serverId,
          toolName: message.toolName,
          message: sendError instanceof Error ? sendError.message : "Unknown authorization result delivery failure.",
        });
      }
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

  private sendToSidecar(message: object): void {
    if (!this.child) {
      throw new Error("MCP sidecar is not running.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async runDockerCommand(args: string[], ignoreFailure = false): Promise<void> {
    const child = this.spawnImpl("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0 || ignoreFailure) {
          resolve();
          return;
        }
        reject(new Error(stderr.trim() || `docker ${args.join(" ")} exited with code ${code}`));
      });
    });
  }
}
