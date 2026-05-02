import {copyFile, mkdir, mkdtemp, readdir, rm, writeFile} from "node:fs/promises";
import {type ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join, relative, resolve} from "node:path";
import {createInterface} from "node:readline";
import type {WorkerNetworkConfig} from "../config.js";
import {logger, type LogLevel} from "../logger.js";
import {sharedWorkspaceMountPath} from "../shared-workspace.js";
import {workerSkillsPath} from "../subagent/worker-codex-config.js";
import type {HostCommand, PrivilegeResolutionResult, SubAgentEvent, TaskInputPayload} from "../types.js";
import {parseSubAgentEvent, serializeHostCommand} from "../types.js";
import { parseHttpProxyContainerMessage, serializeHttpProxyHostMessage, type HttpProxyAuthRequestMessage, type HttpProxyAuthResponseMessage } from "../http/http-proxy-protocol.js";
import {launchNetworkGuardContainer, type StartedNetworkGuard} from "./network-guard.js";
import type {LaunchTaskRequest, SandboxHandle, SandboxRunner, ShareInspection} from "./sandbox-runner.js";

const workerCodexSeedMountPath = "/run/sandy-codex-seed";
const workerHttpTokenDescriptionsPath = "/run/sandy-http-token-descriptions.json";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 300_000;

type DockerSandboxRunnerOptions = {
  workerImage: string;
  resolveWorkerImage?: () => string;
  networkGuardImage?: string;
  shareRoot: string;
  codexModel?: string | null;
  openAiApiKey: string | null;
  codexAuthFile: string | null;
  skillsDirectory: string | null;
  workerCodexBinaryPath?: string | null;
  workerNetworkName?: string | null;
  workerNetwork: WorkerNetworkConfig;
  workerCodexConfigBuilder: (taskId: string) => {
    codexConfigToml: string | null;
    environment: Record<string, string>;
  };
  httpTokenDescriptions?: Record<string, string>;
  httpProxyUrlFactory?: (taskId: string) => string | null;
  handshakeTimeoutMs?: number;
  logLevel?: LogLevel;
  spawnImpl?: typeof spawn;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  httpProxyCaCertPath?: string | null;
  httpProxyConfDirPath?: string | null;
  httpProxyImage?: string | null;
  resolveHttpProxyRequest?: (request: HttpProxyAuthRequestMessage) => Promise<HttpProxyAuthResponseMessage>;
};

type ActiveTaskContainer = {
  child: ChildProcessWithoutNullStreams;
  guardChild: ChildProcessWithoutNullStreams | null;
  guardContainerName: string | null;
  proxyChild: ChildProcessWithoutNullStreams | null;
  proxyContainerName: string | null;
  cleanupWorkerCodexConfig: () => Promise<void>;
};

export class DockerSandboxRunner implements SandboxRunner {
  private readonly handshakeTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly activeContainers = new Map<string, ActiveTaskContainer>();
  private shutdownPromise: Promise<void> | null = null;
  private shutdownRequested = false;

  constructor(private readonly options: DockerSandboxRunnerOptions) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  }

  async launchTask(
    request: LaunchTaskRequest,
    onEvent: (event: SubAgentEvent) => Promise<void>,
  ): Promise<SandboxHandle> {
    if (this.shutdownRequested) {
      throw new Error("Sandbox runner is shutting down and cannot launch new tasks.");
    }

    const sharePath = this.getTaskSharePath(request.taskId);
    await mkdir(sharePath, {recursive: true});
    const builtWorkerConfig = this.options.workerCodexConfigBuilder(request.taskId);
    const workerCodexConfig = builtWorkerConfig.codexConfigToml;
    const workerEnvironment = builtWorkerConfig.environment;
    const httpTokenDescriptions = this.options.httpTokenDescriptions ?? {};
    const httpProxyUrl = this.options.httpProxyUrlFactory?.(request.taskId) ?? null;
    if (httpProxyUrl) {
      assertHttpProxySupportConfigured(this.options);
    }
    const workerImage = this.resolveWorkerImage();
    let workerTempDir: string | null = null;
    let workerCodexHomeTempDir: string | null = null;
    let workerHttpTokenDescriptionsTempPath: string | null = null;
    const needsWorkerCodexHome = Boolean(this.options.codexAuthFile || workerCodexConfig);
    if (needsWorkerCodexHome || Object.keys(httpTokenDescriptions).length > 0) {
      workerTempDir = await mkdtemp(join(tmpdir(), "sandy-worker-launch-"));
    }
    if (needsWorkerCodexHome) {
      workerCodexHomeTempDir = join(workerTempDir!, "codex-home");
      await mkdir(workerCodexHomeTempDir, {recursive: true});
      if (this.options.codexAuthFile) {
        try {
          await copyFile(this.options.codexAuthFile, join(workerCodexHomeTempDir, "auth.json"));
        } catch (error) {
          await rm(workerTempDir!, {recursive: true, force: true});
          throw error;
        }
      }
      if (workerCodexConfig) {
        try {
          await writeFile(join(workerCodexHomeTempDir, "config.toml"), workerCodexConfig, "utf8");
        } catch (error) {
          await rm(workerTempDir!, {recursive: true, force: true});
          throw error;
        }
      }
    }

    if (Object.keys(httpTokenDescriptions).length > 0) {
      workerHttpTokenDescriptionsTempPath = join(workerTempDir!, "http-token-descriptions.json");
      try {
        await writeFile(
          workerHttpTokenDescriptionsTempPath,
          JSON.stringify(httpTokenDescriptions, null, 2),
          "utf8",
        );
      } catch (error) {
        await rm(workerTempDir!, {recursive: true, force: true});
        throw error;
      }
    }

    const hasProxyConfig = Boolean(
      httpProxyUrl
      && this.options.httpProxyImage
      && this.options.httpProxyConfDirPath
      && this.options.httpProxyCaCertPath
      && this.options.resolveHttpProxyRequest
    );

    let tempConfigCleanedUp = false;
    const cleanupWorkerCodexConfig = async (): Promise<void> => {
      if (tempConfigCleanedUp) {
        return;
      }
      tempConfigCleanedUp = true;
      if (workerTempDir) {
        await rm(workerTempDir, {recursive: true, force: true});
      }
    };

    const containerName = `sandy-${request.taskId}`;
    let finished = false;
    let workerConnected = false;
    let terminalEventSeen = false;
    let shutdownRequested = false;
    let disconnectReported = false;
    logger.info("sandbox.launching", {
      chatId: request.chatId,
      taskId: request.taskId,
      taskName: request.taskName,
      sharePath,
      workerImage,
      workerNetworkMode: this.options.workerNetwork.mode,
    });

    let networkGuard: StartedNetworkGuard | null = null;
    try {
      networkGuard = await this.launchNetworkGuard(request.taskId, httpProxyUrl !== null);
    } catch (error) {
      await cleanupWorkerCodexConfig();
      throw error;
    }

    let proxyContainerName: string | null = null;
    let proxyChild: ChildProcessWithoutNullStreams | null = null;

    if (hasProxyConfig) {
      if (!networkGuard) {
        throw new Error("HTTP proxy requires a network guard container.");
      }
      proxyContainerName = `sandy-http-proxy-${request.taskId}`;
      const proxyDockerArgs = [
        "run",
        "--rm",
        "-i",
        "--name",
        proxyContainerName,
        "--network",
        `container:${networkGuard.containerName}`,
        "--cap-drop",
        "NET_ADMIN",
        "--cap-drop",
        "NET_RAW",
        "-v",
        `${this.options.httpProxyConfDirPath}:/run/sandy-mitmproxy-conf:ro`,
        "-e",
        "MITMPROXY_CONFDIR=/run/sandy-mitmproxy-conf",
        this.options.httpProxyImage!,
      ];

      proxyChild = this.spawnImpl("docker", proxyDockerArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      try {
        await this.attachProxyControlChannelAndWaitForReady(
          proxyChild,
          proxyContainerName,
          async (proxyRequest) => await this.options.resolveHttpProxyRequest!(proxyRequest),
        );
      } catch (error) {
        proxyChild.kill("SIGTERM");
        await cleanupWorkerCodexConfig();
        throw error;
      }
    }

    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      "--name",
      containerName,
      // Drop network-manipulation capabilities so the worker cannot rewrite
      // the guard's firewall rules and break out of network isolation.
      "--cap-drop",
      "NET_ADMIN",
      "--cap-drop",
      "NET_RAW",
      "-e",
      `SANDY_TASK_ID=${request.taskId}`,
      "-e",
      `SANDY_CHANNEL_FORMATTING=${JSON.stringify(request.channelFormatting)}`,
    ];

    if (this.options.logLevel) {
      dockerArgs.push("-e", `SANDY_LOG_LEVEL=${this.options.logLevel}`);
    }

    if (this.options.codexModel) {
      dockerArgs.push("-e", `SANDY_CODEX_MODEL=${this.options.codexModel}`);
    }

    if (this.options.openAiApiKey) {
      dockerArgs.push("-e", `OPENAI_API_KEY=${this.options.openAiApiKey}`);
    }

    if (this.options.workerCodexBinaryPath) {
      dockerArgs.push("-e", "SANDY_CODEX_PATH=/usr/local/bin/codex");
    }

    for (const [name, value] of Object.entries(workerEnvironment)) {
      dockerArgs.push("-e", `${name}=${value}`);
    }

    if (httpProxyUrl) {
      dockerArgs.push("-e", `SANDY_HTTP_PROXY_URL=${httpProxyUrl}`);
      dockerArgs.push("-e", "SANDY_HTTP_PROXY_WRAPPER=/usr/local/bin/sandy-http-proxy-exec");
    }

    if (httpProxyUrl) {
      // The proxy CA must be present when proxying is enabled; the earlier
      // assertion guarantees this, but we assert again at the point of use
      // so the dependency is visible here.
      if (!this.options.httpProxyCaCertPath) {
        throw new Error("HTTP proxy CA cert path is required when proxy URL is set.");
      }
      // Mount the Sandy CA into the system anchors directory so the worker
      // retains the default system trust store. The entrypoint runs
      // update-ca-certificates to refresh the bundle before starting.
      dockerArgs.push("-v", `${this.options.httpProxyCaCertPath}:/etc/pki/trust/anchors/sandy-ca.pem:ro`);
    }

    if (workerCodexHomeTempDir) {
      dockerArgs.push(
        "-v",
        `${workerCodexHomeTempDir}:${workerCodexSeedMountPath}:ro`,
      );
    }

    if (workerHttpTokenDescriptionsTempPath) {
      dockerArgs.push(
        "-v",
        `${workerHttpTokenDescriptionsTempPath}:${workerHttpTokenDescriptionsPath}:ro`,
      );
    }

    if (this.options.workerCodexBinaryPath) {
      dockerArgs.push(
        "-v",
        `${this.options.workerCodexBinaryPath}:/usr/local/bin/codex:ro`,
      );
    }

    if (this.options.skillsDirectory) {
      dockerArgs.push(
        "-v",
        `${this.options.skillsDirectory}:${workerSkillsPath}:ro`,
      );
    }

    if (networkGuard) {
      // Share the guard's namespace so the worker gets internet access through
      // the guard's firewall, but cannot talk to the local network directly.
      dockerArgs.push(
        "--network",
        `container:${networkGuard.containerName}`,
      );
    } else if (this.options.workerNetworkName) {
      dockerArgs.push(
        "--network",
        this.options.workerNetworkName,
      );
    }

    dockerArgs.push(
      "-v",
      `${sharePath}:${sharedWorkspaceMountPath}`,
      workerImage,
    );

    const child = this.spawnImpl("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.activeContainers.set(containerName, {
      child,
      guardChild: networkGuard?.child ?? null,
      guardContainerName: networkGuard?.containerName ?? null,
      proxyChild,
      proxyContainerName,
      cleanupWorkerCodexConfig,
    });

    const cleanupTaskContainers = async (): Promise<void> => {
      await this.cleanupTaskContainers(
        containerName,
        networkGuard?.containerName ?? null,
        proxyContainerName,
      );
    };

    const handshakeTimer = this.setTimeoutImpl(() => {
      if (workerConnected || terminalEventSeen || shutdownRequested) {
        return;
      }
      logger.error("sandbox.handshake_timeout", {
        taskId: request.taskId,
        timeoutMs: this.handshakeTimeoutMs,
      });
      void reportDisconnect("Sub-agent worker did not complete startup handshake in time.");
      shutdownRequested = true;
      child.kill("SIGTERM");
      void cleanupTaskContainers();
    }, this.handshakeTimeoutMs);

    const clearHandshakeTimer = () => {
      this.clearTimeoutImpl(handshakeTimer);
    };

    const emitEvent = async (event: SubAgentEvent): Promise<void> => {
      await onEvent(event);
      if (event.type === "task_done" || event.type === "final_result" || event.type === "task_error") {
        terminalEventSeen = true;
        clearHandshakeTimer();
      }
      if (event.type === "worker_connected") {
        workerConnected = true;
        clearHandshakeTimer();
        try {
          await this.sendToWorker(child, {
            type: "start_task",
            taskBrief: request.taskBrief,
            input: request.initialInput,
            taskLanguage: request.taskLanguage,
          });
        } catch (error) {
          await reportDisconnect(this.describeWriteFailure(error));
        }
      }
    };

    const handleEventDeliveryFailure = async (event: SubAgentEvent, error: unknown): Promise<void> => {
      logger.error("sandbox.event_handler_failed", {
        taskId: request.taskId,
        eventType: event.type,
        message: error instanceof Error ? error.message : "Unknown event delivery failure.",
      });
      if (finished || shutdownRequested) {
        return;
      }
      finished = true;
      shutdownRequested = true;
      clearHandshakeTimer();
      child.kill("SIGTERM");
      await cleanupTaskContainers();
    };

    const emitEventSafely = (event: SubAgentEvent): void => {
      void emitEvent(event).catch(async (error) => {
        await handleEventDeliveryFailure(event, error);
      });
    };

    const reportDisconnect = async (message: string): Promise<void> => {
      if (disconnectReported || terminalEventSeen || shutdownRequested) {
        return;
      }
      disconnectReported = true;
      clearHandshakeTimer();
      logger.error("sandbox.worker_disconnected", {
        taskId: request.taskId,
        message,
      });
      await emitEvent({
        type: "worker_disconnected",
        message,
      });
    };

    this.attachStdoutParser(child, emitEventSafely);
    logger.info("sandbox.started", {
      taskId: request.taskId,
      containerName,
      guardContainerName: networkGuard?.containerName ?? null,
      proxyContainerName,
    });

    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        logger.warn("sandbox.stderr", {
          taskId: request.taskId,
          message,
        });
      }
    });

    child.on("error", (error) => {
      this.activeContainers.delete(containerName);
      if (finished) {
        return;
      }
      finished = true;
      clearHandshakeTimer();
      void cleanupWorkerCodexConfig();
      void cleanupTaskContainers();
      logger.error("sandbox.launch_failed", {
        taskId: request.taskId,
        message: error.message,
      });
      emitEventSafely({
        type: "task_error",
        message: `Failed to launch Docker sub-agent: ${error.message}`,
      });
    });

    child.stdout.on("close", () => {
      if (finished || shutdownRequested || terminalEventSeen) {
        return;
      }
      void reportDisconnect("Sub-agent control channel disconnected before task completion.");
    });

    child.on("exit", (code, signal) => {
      this.activeContainers.delete(containerName);
      void cleanupWorkerCodexConfig();
      void cleanupTaskContainers();
      if (finished) {
        return;
      }
      finished = true;
      clearHandshakeTimer();
      if (shutdownRequested) {
        logger.info("sandbox.exited", {
          taskId: request.taskId,
          code,
          signal,
        });
        return;
      }
      if (terminalEventSeen && code === 0) {
        logger.info("sandbox.exited", {
          taskId: request.taskId,
          code,
          signal,
        });
        return;
      }
      void reportDisconnect(`Sub-agent container exited before task completion (code=${code}, signal=${signal}).`);
    });

    networkGuard?.child.on("error", (error) => {
      logger.error("sandbox.network_guard_failed", {
        taskId: request.taskId,
        message: error.message,
      });
    });

    networkGuard?.child.on("exit", (code, signal) => {
      if (finished || shutdownRequested || terminalEventSeen) {
        return;
      }
      logger.error("sandbox.network_guard_exited", {
        taskId: request.taskId,
        code,
        signal,
      });
      void reportDisconnect(`Task network guard exited before task completion (code=${code}, signal=${signal}).`);
      shutdownRequested = true;
      clearHandshakeTimer();
      child.kill("SIGTERM");
      void cleanupTaskContainers();
    });

    proxyChild?.on("error", (error) => {
      logger.error("sandbox.http_proxy_failed", {
        taskId: request.taskId,
        message: error.message,
      });
    });

    proxyChild?.on("exit", (code, signal) => {
      if (finished || shutdownRequested || terminalEventSeen) {
        return;
      }
      logger.error("sandbox.http_proxy_exited", {
        taskId: request.taskId,
        code,
        signal,
      });
      void reportDisconnect(`HTTP proxy container exited before task completion (code=${code}, signal=${signal}).`);
      shutdownRequested = true;
      clearHandshakeTimer();
      child.kill("SIGTERM");
      void cleanupTaskContainers();
    });

    return {
      sendUserMessage: async (input: TaskInputPayload) => {
        logger.debugContent("sandbox.user_message", {
          taskId: request.taskId,
          text: input.text,
          imageCount: input.images.length,
        });
        try {
          await this.sendToWorker(child, {
            type: "user_message",
            input,
          });
        } catch (error) {
          await reportDisconnect(this.describeWriteFailure(error));
        }
      },
      resolvePrivilege: async (result: PrivilegeResolutionResult) => {
        logger.info("sandbox.privilege_decision", {
          taskId: request.taskId,
          requestId: result.requestId,
          outcome: result.outcome,
        });
        try {
          await this.sendToWorker(child, {
            type: "privilege_result",
            result,
          });
        } catch (error) {
          await reportDisconnect(this.describeWriteFailure(error));
        }
      },
      markFinished: async () => {
        logger.info("sandbox.mark_finished", {
          taskId: request.taskId,
        });
        try {
          await this.sendToWorker(child, {
            type: "mark_finished",
          });
        } catch (error) {
          await reportDisconnect(this.describeWriteFailure(error));
        }
      },
      close: async () => {
        if (finished || shutdownRequested) {
          return;
        }
        finished = true;
        shutdownRequested = true;
        clearHandshakeTimer();
        logger.info("sandbox.closing", {
          taskId: request.taskId,
        });
        child.stdin.end();
        child.kill("SIGTERM");
        await cleanupTaskContainers();
      },
      cancel: async (reason: string) => {
        finished = true;
        shutdownRequested = true;
        clearHandshakeTimer();
        logger.warn("sandbox.cancelling", {
          taskId: request.taskId,
          reason,
        });
        await this.sendToWorkerSafe(child, {
          type: "cancel",
          reason,
        });
        child.kill("SIGTERM");
        await cleanupTaskContainers();
      },
    };
  }

  private resolveWorkerImage(): string {
    return this.options.resolveWorkerImage?.() ?? this.options.workerImage;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownRequested = true;
    const activeContainers = [...this.activeContainers.entries()];
    this.shutdownPromise = Promise.all(activeContainers.map(async ([containerName, activeContainer]) => {
      logger.info("sandbox.shutdown_terminating", {
        containerName,
      });
      activeContainer.child.kill("SIGTERM");
      activeContainer.guardChild?.kill("SIGTERM");
      activeContainer.proxyChild?.kill("SIGTERM");
      await Promise.all([
        activeContainer.cleanupWorkerCodexConfig(),
        this.cleanupTaskContainers(containerName, activeContainer.guardContainerName, activeContainer.proxyContainerName),
      ]);
      this.activeContainers.delete(containerName);
    })).then(() => {
      logger.info("sandbox.shutdown_complete", {
        containerCount: activeContainers.length,
      });
    });

    return this.shutdownPromise;
  }

  async inspectTaskShare(taskId: string): Promise<ShareInspection> {
    const sharePath = this.getTaskSharePath(taskId);
    let entries;
    try {
      entries = await readdir(sharePath, {withFileTypes: true});
    } catch (error) {
      if (isMissingPathError(error)) {
        return {
          isEmpty: true,
          summary: null,
        };
      }
      throw error;
    }

    if (entries.length === 0) {
      return {
        isEmpty: true,
        summary: null,
      };
    }

    const lines = await this.buildShareOverview(sharePath, 0, 2, 12);
    return {
      isEmpty: false,
      summary: lines.join("\n"),
    };
  }

  async deleteTaskShare(taskId: string): Promise<void> {
    const sharePath = this.getTaskSharePath(taskId);
    try {
      await rm(sharePath, {recursive: true, force: true});
    } catch (error) {
      if (isPermissionError(error)) {
        logger.warn("sandbox.share_cleanup_permission_denied", {
          taskId,
          sharePath,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.deleteTaskShareWithDocker(taskId, sharePath);
      } else {
        throw error;
      }
    }
    logger.info("sandbox.share_deleted", {
      taskId,
      sharePath,
    });
  }

  private async deleteTaskShareWithDocker(taskId: string, sharePath: string): Promise<void> {
    const workerImage = this.resolveWorkerImage();
    logger.info("sandbox.share_cleanup_docker_starting", {
      taskId,
      sharePath,
      workerImage,
    });
    return new Promise<void>((resolve, reject) => {
      const child = this.spawnImpl("docker", [
        "run",
        "--rm",
        "-v",
        `${sharePath}:/target`,
        "--entrypoint",
        "rm",
        workerImage,
        "-rf",
        "/target",
      ], {
        stdio: "ignore",
      });
      child.on("exit", (code) => {
        if (code === 0) {
          logger.info("sandbox.share_cleanup_docker_finished", {
            taskId,
            sharePath,
          });
          resolve();
        } else {
          logger.error("sandbox.share_cleanup_docker_failed", {
            taskId,
            sharePath,
            exitCode: code,
          });
          reject(new Error(`Docker share cleanup exited with code ${code}`));
        }
      });
      child.on("error", (error) => {
        logger.error("sandbox.share_cleanup_docker_failed", {
          taskId,
          sharePath,
          error: error instanceof Error ? error.message : String(error),
        });
        reject(error);
      });
    });
  }

  getTaskSharePath(taskId: string): string {
    const shareRoot = resolve(this.options.shareRoot);
    const sharePath = resolve(shareRoot, taskId);
    const relativePath = relative(shareRoot, sharePath);

    if (relativePath.startsWith("..") || relativePath === "" || isAbsolutePathEscape(relativePath)) {
      throw new Error(`Task share path escapes the configured share root: ${taskId}`);
    }

    return sharePath;
  }

  private attachStdoutParser(child: ChildProcessWithoutNullStreams, onEvent: (event: SubAgentEvent) => void): void {
    const stdout = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      try {
        const event = parseSubAgentEvent(trimmed);
        logger.debug("sandbox.worker_event", {
          eventType: event.type,
        });
        if (event.type === "assistant_output" || event.type === "final_result") {
          logger.debugContent("sandbox.model_response", {
            eventType: event.type,
            text: event.text,
          });
        }
         if (event.type === "worker_log") {
           this.forwardContainerLog(event.level, event.event, event.data);
           return;
         }
        onEvent(event);
      } catch {
        logger.warn("sandbox.stdout_non_json", {
          line: trimmed,
        });
        onEvent({
          type: "progress",
          message: trimmed,
        });
      }
    });
  }

  private async sendToWorker(
    child: ChildProcessWithoutNullStreams,
    command: HostCommand,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const payload = `${serializeHostCommand(command)}\n`;
      child.stdin.write(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async sendToWorkerSafe(
    child: ChildProcessWithoutNullStreams,
    command: HostCommand,
  ): Promise<void> {
    try {
      await this.sendToWorker(child, command);
    } catch {
      // Ignore command delivery failures during cancellation.
    }
  }

  private async launchNetworkGuard(taskId: string, needsNamespaceHolder: boolean): Promise<StartedNetworkGuard | null> {
    return await launchNetworkGuardContainer({
      taskId,
      workerNetwork: this.options.workerNetwork,
      networkGuardImage: this.options.networkGuardImage,
      workerNetworkName: this.options.workerNetworkName,
      // HTTP proxying still needs a shared namespace container even when the
      // worker network mode is unrestricted, because the proxy binds localhost.
      needsNamespaceHolder,
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      spawnImpl: this.spawnImpl,
      setTimeoutImpl: this.setTimeoutImpl,
      clearTimeoutImpl: this.clearTimeoutImpl,
      cleanupContainer: async (containerName) => this.cleanupContainer(containerName),
    });
  }

  private async attachProxyControlChannelAndWaitForReady(
    proxyChild: ChildProcessWithoutNullStreams,
    containerName: string,
    resolveHttpProxyRequest: (request: HttpProxyAuthRequestMessage) => Promise<HttpProxyAuthResponseMessage>,
  ): Promise<void> {
    const proxyStdout = createInterface({
      input: proxyChild.stdout,
      crlfDelay: Infinity,
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = this.setTimeoutImpl(() => {
        if (settled) {
          return;
        }
        settled = true;
        proxyChild.kill("SIGTERM");
        reject(new Error("HTTP proxy container did not become ready in time."));
      }, this.handshakeTimeoutMs);

      proxyStdout.on("line", (line) => {
        try {
          const message = parseHttpProxyContainerMessage(line.trim());
           if (message.type === "log") {
             this.forwardContainerLog(message.level, message.event, message.data, { containerName, source: "http_proxy_container" });
             return;
           }
          if (message.type === "auth_request") {
            void this.handleHttpProxyAuthRequest(proxyChild, resolveHttpProxyRequest, message);
            return;
          }
          if (message.type === "ready") {
            if (settled) {
              return;
            }
            settled = true;
            this.clearTimeoutImpl(timer);
            resolve();
            return;
          }
          if (message.type === "fatal_error") {
            if (settled) {
              return;
            }
            settled = true;
            this.clearTimeoutImpl(timer);
            reject(new Error(message.message ?? "HTTP proxy container failed during startup."));
          }
        } catch (error) {
          logger.error("sandbox.http_proxy_protocol_error", {
            containerName,
            line: line.trim(),
            message: error instanceof Error ? error.message : "Invalid proxy control message.",
          });
        }
      });

      proxyChild.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearTimeoutImpl(timer);
        reject(error);
      });

      proxyChild.once("exit", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearTimeoutImpl(timer);
        reject(new Error(`HTTP proxy container exited before ready (code=${code}, signal=${signal}).`));
      });
    });

    proxyChild.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        logger.warn("sandbox.http_proxy_stderr", {
          containerName,
          message,
        });
      }
    });
  }

  private async handleHttpProxyAuthRequest(
    proxyChild: ChildProcessWithoutNullStreams,
    resolveHttpProxyRequest: (request: HttpProxyAuthRequestMessage) => Promise<HttpProxyAuthResponseMessage>,
    request: HttpProxyAuthRequestMessage,
  ): Promise<void> {
    let response: HttpProxyAuthResponseMessage;
    try {
      response = await resolveHttpProxyRequest(request);
    } catch (error) {
      response = {
        type: "auth_response",
        requestId: request.requestId,
        outcome: "failed",
        message: error instanceof Error ? error.message : "Authorization service error.",
      };
    }

    await new Promise<void>((resolve, reject) => {
      proxyChild.stdin.write(serializeHttpProxyHostMessage(response), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private forwardContainerLog(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>,
    extraFields?: Record<string, unknown>,
  ): void {
    const payload = {
      source: "worker",
      ...extraFields,
      ...(data ?? {}),
    };
    switch (level) {
      case "debug":
        logger.debug(event, payload);
        return;
      case "info":
        logger.info(event, payload);
        return;
      case "warn":
        logger.warn(event, payload);
        return;
      case "error":
        logger.error(event, payload);
        return;
    }
  }

  private async cleanupTaskContainers(
    containerName: string,
    guardContainerName: string | null,
    proxyContainerName: string | null,
  ): Promise<void> {
    const containerNames = [containerName];
    if (guardContainerName) {
      containerNames.push(guardContainerName);
    }
    if (proxyContainerName) {
      containerNames.push(proxyContainerName);
    }
    await Promise.all(containerNames.map(async (name) => this.cleanupContainer(name)));
  }

  private async cleanupContainer(containerName: string): Promise<void> {
    await new Promise<void>((resolve) => {
      logger.debug("sandbox.force_remove", {
        containerName,
      });
      const child = this.spawnImpl("docker", ["rm", "-f", containerName], {
        stdio: "ignore",
      });
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
  }

  private describeWriteFailure(error: unknown): string {
    if (error instanceof Error) {
      return `Sub-agent control channel write failed: ${error.message}`;
    }
    return "Sub-agent control channel write failed.";
  }

  private async buildShareOverview(
    directoryPath: string,
    depth: number,
    maxDepth: number,
    remainingLines: number,
  ): Promise<string[]> {
    if (remainingLines <= 0) {
      return [];
    }

    const entries = await readdir(directoryPath, {withFileTypes: true});
    entries.sort((left, right) => left.name.localeCompare(right.name));

    const lines: string[] = [];
    let processedEntries = 0;
    for (const entry of entries) {
      if (lines.length >= remainingLines) {
        break;
      }
      processedEntries += 1;

      const indent = "  ".repeat(depth);
      const label = entry.isDirectory() ? `${entry.name}/` : entry.name;
      lines.push(`${indent}${label}`);

      if (entry.isDirectory() && depth + 1 < maxDepth && lines.length < remainingLines) {
        const childPath = join(directoryPath, entry.name);
        const childLines = await this.buildShareOverview(
          childPath,
          depth + 1,
          maxDepth,
          remainingLines - lines.length,
        );
        lines.push(...childLines);
      }
    }

    if (processedEntries < entries.length && lines.length >= remainingLines) {
      lines.push(`${"  ".repeat(depth)}...`);
    }

    return lines.slice(0, remainingLines);
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
}

function assertHttpProxySupportConfigured(options: DockerSandboxRunnerOptions): void {
  if (!options.httpProxyImage) {
    throw new Error("HTTP proxy URL factory requires httpProxyImage.");
  }
  if (!options.httpProxyCaCertPath) {
    throw new Error("HTTP proxy URL factory requires httpProxyCaCertPath.");
  }
  if (!options.httpProxyConfDirPath) {
    throw new Error("HTTP proxy URL factory requires httpProxyConfDirPath.");
  }
  if (!options.resolveHttpProxyRequest) {
    throw new Error("HTTP proxy URL factory requires resolveHttpProxyRequest.");
  }
}

function isAbsolutePathEscape(path: string): boolean {
  return path.startsWith("/");
}
