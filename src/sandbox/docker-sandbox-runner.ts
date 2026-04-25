import {copyFile, mkdir, mkdtemp, readdir, rm, writeFile} from "node:fs/promises";
import {type ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join, relative, resolve} from "node:path";
import {createInterface} from "node:readline";
import type {WorkerNetworkConfig} from "../config.js";
import {logger} from "../logger.js";
import {sharedWorkspaceMountPath} from "../shared-workspace.js";
import {workerSkillsPath} from "../subagent/worker-codex-config.js";
import type {HostCommand, PrivilegeResolutionResult, SubAgentEvent} from "../types.js";
import {parseSubAgentEvent, serializeHostCommand} from "../types.js";
import {launchNetworkGuardContainer, type StartedNetworkGuard} from "./network-guard.js";
import type {LaunchTaskRequest, SandboxHandle, SandboxRunner, ShareInspection} from "./sandbox-runner.js";

const workerCodexSeedMountPath = "/run/sandy-codex-seed";
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
  handshakeTimeoutMs?: number;
  spawnImpl?: typeof spawn;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

type ActiveTaskContainer = {
  child: ChildProcessWithoutNullStreams;
  guardChild: ChildProcessWithoutNullStreams | null;
  guardContainerName: string | null;
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
    const workerCodexConfig = builtWorkerConfig?.codexConfigToml ?? null;
    const workerEnvironment = builtWorkerConfig?.environment ?? {};
    const workerImage = this.resolveWorkerImage();
    let workerCodexHomeTempDir: string | null = null;
    const needsWorkerCodexHome = Boolean(this.options.codexAuthFile || workerCodexConfig);
    if (needsWorkerCodexHome) {
      workerCodexHomeTempDir = await mkdtemp(join(tmpdir(), "sandy-worker-codex-home-"));
      if (this.options.codexAuthFile) {
        try {
          await copyFile(this.options.codexAuthFile, join(workerCodexHomeTempDir, "auth.json"));
        } catch (error) {
          await rm(workerCodexHomeTempDir, {recursive: true, force: true});
          throw error;
        }
      }
      if (workerCodexConfig) {
        try {
          await writeFile(join(workerCodexHomeTempDir, "config.toml"), workerCodexConfig, "utf8");
        } catch (error) {
          await rm(workerCodexHomeTempDir, {recursive: true, force: true});
          throw error;
        }
      }
    }

    let tempConfigCleanedUp = false;
    const cleanupWorkerCodexConfig = async (): Promise<void> => {
      if (tempConfigCleanedUp || !workerCodexHomeTempDir) {
        return;
      }
      tempConfigCleanedUp = true;
      await rm(workerCodexHomeTempDir, {recursive: true, force: true});
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
      networkGuard = await this.launchNetworkGuard(request.taskId);
    } catch (error) {
      await cleanupWorkerCodexConfig();
      throw error;
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
      `SANDY_TASK_BRIEF=${request.taskBrief}`,
      "-e",
      `SANDY_CHANNEL_FORMATTING=${JSON.stringify(request.channelFormatting)}`,
    ];

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

    if (workerCodexHomeTempDir) {
      dockerArgs.push(
        "-v",
        `${workerCodexHomeTempDir}:${workerCodexSeedMountPath}:ro`,
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
      cleanupWorkerCodexConfig,
    });

    const cleanupTaskContainers = async (): Promise<void> => {
      await this.cleanupTaskContainers(containerName, networkGuard?.containerName ?? null);
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
      if (event.type === "worker_connected") {
        workerConnected = true;
        clearHandshakeTimer();
      }
      if (event.type === "task_done" || event.type === "final_result" || event.type === "task_error") {
        terminalEventSeen = true;
        clearHandshakeTimer();
      }
      await onEvent(event);
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

    return {
      sendUserMessage: async (text: string) => {
        logger.debugContent("sandbox.user_message", {
          taskId: request.taskId,
          text,
        });
        try {
          await this.sendToWorker(child, {
            type: "user_message",
            text,
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
      await Promise.all([
        activeContainer.cleanupWorkerCodexConfig(),
        this.cleanupTaskContainers(containerName, activeContainer.guardContainerName),
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
    await rm(sharePath, {recursive: true, force: true});
    logger.info("sandbox.share_deleted", {
      taskId,
      sharePath,
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

  private async launchNetworkGuard(taskId: string): Promise<StartedNetworkGuard | null> {
    return await launchNetworkGuardContainer({
      taskId,
      workerNetwork: this.options.workerNetwork,
      networkGuardImage: this.options.networkGuardImage,
      workerNetworkName: this.options.workerNetworkName,
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      spawnImpl: this.spawnImpl,
      setTimeoutImpl: this.setTimeoutImpl,
      clearTimeoutImpl: this.clearTimeoutImpl,
      cleanupContainer: async (containerName) => this.cleanupContainer(containerName),
    });
  }

  private async cleanupTaskContainers(containerName: string, guardContainerName: string | null): Promise<void> {
    const containerNames = [containerName];
    if (guardContainerName) {
      containerNames.push(guardContainerName);
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

function isAbsolutePathEscape(path: string): boolean {
  return path.startsWith("/");
}
