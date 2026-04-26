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
import { mcpWorkerNetworkNamePrefix } from "./worker-network-name.js";
import {
  parseMcpSidecarToHostMessage,
  type McpSidecarAuthorizationRequestMessage,
  type McpSidecarLogMessage,
} from "./sidecar-protocol.js";

type McpSidecarManagerOptions = {
  configDirectory: string;
  mcpServers: Record<string, McpServerConfig>;
  workerNetworkName: string;
  sidecarImage: string;
  networkGuardImage?: string;
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
  private readonly guardContainerName = `sandy-sidecar-guard-${randomUUID()}`;
  private readonly hostGatewayAlias = "host.docker.internal:host-gateway";
  private readonly startupTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private child: ChildProcessWithoutNullStreams | null = null;
  private guardChild: ChildProcessWithoutNullStreams | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly options: McpSidecarManagerOptions,
    private readonly access: SandyMcpProxyAccess,
  ) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 300_000;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  }

  async start(): Promise<void> {
    const hasMCP = Object.keys(this.options.mcpServers).length > 0;
    if (this.started || !hasMCP) {
      return;
    }

    this.started = true;
    const oauthStateDirectory = buildHostOauthStateDirectory(this.options.configDirectory);
    await mkdir(oauthStateDirectory, { recursive: true });
    await this.pruneStaleNetworks();
    await this.runDockerCommand(["network", "create", this.options.workerNetworkName]);

    const guardImage = this.options.networkGuardImage ?? "sandy-network-guard:latest";
    const guardDockerArgs = [
      "run",
      "--rm",
      "-i",
      "--name",
      this.guardContainerName,
      "--network",
      this.options.workerNetworkName,
      "--network-alias",
      mcpProxyContainerAlias,
      "--cap-add",
      "NET_ADMIN",
      "--cap-drop",
      "NET_RAW",
      "-e",
      "SANDY_NETWORK_GUARD_MODE=public_internet_only",
      "-e",
      "SANDY_NETWORK_GUARD_ALLOWED_LOCAL_CIDRS=",
      guardImage,
    ];

    this.guardChild = this.spawnImpl("docker", guardDockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.guardChild.stdin.end();

    await this.waitForGuardReady(this.guardChild, this.guardContainerName);

    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      "--name",
      this.containerName,
      "--network",
      `container:${this.guardContainerName}`,
      "--add-host",
      this.hostGatewayAlias,
      "-v",
      `${oauthStateDirectory}:${sidecarOauthMountPath}`,
    ];

    dockerArgs.push(this.options.sidecarImage);

    const child = this.spawnImpl("docker", dockerArgs, {
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

    if (this.guardChild) {
      this.guardChild.kill("SIGTERM");
      this.guardChild = null;
      await this.runDockerCommand(["rm", "-f", this.guardContainerName], true);
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
      })    });
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
        logger.error(message.event, message.data);
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

  private async waitForGuardReady(
    guardChild: ChildProcessWithoutNullStreams,
    containerName: string,
  ): Promise<void> {
    const guardStdout = createInterface({
      input: guardChild.stdout,
      crlfDelay: Infinity,
    });

    await new Promise<void>((resolve, reject) => {
      const timer = this.setTimeoutImpl(() => {
        guardChild.kill("SIGTERM");
        reject(new Error("Sidecar network guard did not become ready in time."));
      }, this.startupTimeoutMs);

      guardStdout.on("line", (line) => {
        if (line.trim() === "ready") {
          this.clearTimeoutImpl(timer);
          guardStdout.close();
          resolve();
        }
      });

      guardChild.once("error", (error) => {
        this.clearTimeoutImpl(timer);
        reject(error);
      });

      guardChild.once("exit", (code, signal) => {
        this.clearTimeoutImpl(timer);
        reject(new Error(`Sidecar network guard exited before ready (code=${code}, signal=${signal}).`));
      });
    });

    guardChild.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        logger.warn("mcp.sidecar.guard_stderr", {
          containerName,
          message,
        });
      }
    });
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
