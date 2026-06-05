import {readdir, rm} from "node:fs/promises";
import {type ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import {join} from "node:path";
import {createInterface} from "node:readline";
import type {WorkerNetworkConfig} from "../config.js";
import {logger} from "../logger.js";
import type {ChatGPTExternalTokens, HostCommand, PrivilegeResolutionResult, SubAgentEvent, TaskInputPayload} from "../types.js";
import {parseSubAgentEvent, serializeHostCommand} from "../types.js";
import type {LaunchTaskRequest, SandboxHandle, SandboxRunner, ShareInspection} from "./sandbox-runner.js";
import type {ReservedTaskBundle, TaskBundlePool} from "./task-bundle-types.js";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 300_000;
type TaskId = string;

type TaskBundleRecord = {
  bundle: ReservedTaskBundle;
  retired: boolean;
};

export type DockerSandboxRunnerOptions = {
  workerImage: string;
  resolveWorkerImage?: () => string;
  workerNetwork: WorkerNetworkConfig;
  workerCodexConfigBuilder: (taskId: string) => {
    codexConfigToml: string | null;
    environment: Record<string, string>;
  };
  httpProxyUrlFactory?: (taskId: string) => string | null;
  handshakeTimeoutMs?: number;
  spawnImpl?: typeof spawn;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

export class DockerSandboxRunner implements SandboxRunner {
  private readonly handshakeTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly taskBundles = new Map<TaskId, TaskBundleRecord>();
  private shutdownPromise: Promise<void> | null = null;
  private shutdownRequested = false;

  constructor(
    private readonly options: DockerSandboxRunnerOptions,
    private readonly pool: TaskBundlePool,
  ) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  }

  start(): void {
    this.pool.start();
  }

  async getTaskSharePath(taskId: string): Promise<string> {
    const existingRecord = this.taskBundles.get(taskId);
    if (existingRecord) {
      return existingRecord.bundle.shareHostPath;
    }
    if (this.shutdownRequested) {
      throw new Error("Sandbox runner is shutting down and cannot create task shares.");
    }

    const bundle = await this.pool.acquire(taskId);
    this.taskBundles.set(taskId, { bundle, retired: false });
    return bundle.shareHostPath;
  }

  async launchTask(
    request: LaunchTaskRequest,
    onEvent: (event: SubAgentEvent) => Promise<void>,
  ): Promise<SandboxHandle> {
    if (this.shutdownRequested) {
      throw new Error("Sandbox runner is shutting down and cannot launch new tasks.");
    }

    let taskBundleRecord: TaskBundleRecord | null;
    try {
      taskBundleRecord = this.taskBundles.get(request.taskId) ?? null;
      if (!taskBundleRecord) {
        const bundle = await this.pool.acquire(request.taskId);
        taskBundleRecord = { bundle, retired: false };
        this.taskBundles.set(request.taskId, taskBundleRecord);
      }
      const reservedBundle = taskBundleRecord.bundle;
      const activeTaskBundleRecord = taskBundleRecord;

      const builtWorkerConfig = this.options.workerCodexConfigBuilder(request.taskId);
      const httpProxyUrl = this.options.httpProxyUrlFactory?.(request.taskId) ?? null;

      let finished = false;
      let workerConnected = false;
      let taskInitialized = false;
      let terminalEventSeen = false;
      let shutdownRequested = false;
      let disconnectReported = false;
      let resolveTaskInitialized: (() => void) | null = null;
      let rejectTaskInitialized: ((error: Error) => void) | null = null;
      let retirePromise: Promise<void> | null = null;
      const taskInitializedBarrier = new Promise<void>((resolve, reject) => {
        resolveTaskInitialized = resolve;
        rejectTaskInitialized = (error: Error) => {
          reject(error);
        };
      });
      void taskInitializedBarrier.catch(() => {});

      const retireBundle = (): Promise<void> => {
        if (retirePromise) {
          return retirePromise;
        }
        retirePromise = this.pool.retireBundle(reservedBundle)
          .then(() => {
            activeTaskBundleRecord.retired = true;
          })
          .catch((error) => {
            logger.error("sandbox.retire_bundle_failed", error, String(error), {
              taskId: reservedBundle.taskId,
              bundleId: reservedBundle.bundleId,
            });
          });
        return retirePromise;
      };

      logger.info("sandbox.launching", {
        chatId: request.chatId,
        taskId: request.taskId,
        taskName: request.taskName,
        sharePath: reservedBundle.shareHostPath,
        workerImage: this.resolveWorkerImage(),
        workerNetworkMode: this.options.workerNetwork.mode,
      });

      const child = reservedBundle.child;

      const handshakeTimer = this.setTimeoutImpl(() => {
        if (workerConnected || terminalEventSeen || shutdownRequested) {
          return;
        }
        logger.error("sandbox.handshake_timeout", null, undefined, {
          taskId: request.taskId,
          timeoutMs: this.handshakeTimeoutMs,
        });
        void reportDisconnect("Sub-agent worker did not complete startup handshake in time.");
        shutdownRequested = true;
        void retireBundle();
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
              taskId: request.taskId,
              taskBrief: request.taskBrief,
              input: request.initialInput,
              taskLanguage: request.taskLanguage,
              config: request.workerStartConfig,
              environment: builtWorkerConfig.environment,
              codexConfigToml: builtWorkerConfig.codexConfigToml,
              httpProxyUrl,
            });
            taskInitialized = true;
            resolveTaskInitialized?.();
          } catch (error) {
            rejectTaskInitialized?.(new Error(this.describeWriteFailure(error)));
            await reportDisconnect(this.describeWriteFailure(error));
          }
        }
      };

      const handleEventDeliveryFailure = async (event: SubAgentEvent, error: unknown): Promise<void> => {
        logger.error("sandbox.event_handler_failed", error, "Unknown event delivery failure.", {
          taskId: request.taskId,
          eventType: event.type,
        });
        if (finished || shutdownRequested) {
          return;
        }
        finished = true;
        shutdownRequested = true;
        clearHandshakeTimer();
        await retireBundle();
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
        rejectTaskInitialized?.(new Error(message));
        clearHandshakeTimer();
        logger.error("sandbox.worker_disconnected", null, undefined, {
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
        containerName: reservedBundle.containerName,
        guardContainerName: reservedBundle.guardContainerName,
        proxyContainerName: reservedBundle.proxyContainerName,
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
        if (finished) {
          return;
        }
        finished = true;
        clearHandshakeTimer();
        void retireBundle();
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
        void retireBundle();
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

      reservedBundle.guardChild?.on("error", (error) => {
        logger.error("sandbox.network_guard_failed", error, error.message, {
          taskId: request.taskId,
        });
      });

      reservedBundle.guardChild?.on("exit", (code, signal) => {
        if (finished || shutdownRequested || terminalEventSeen) {
          return;
        }
        logger.error("sandbox.network_guard_exited", null, undefined, {
          taskId: request.taskId,
          code,
          signal,
        });
        void reportDisconnect(`Task network guard exited before task completion (code=${code}, signal=${signal}).`);
        shutdownRequested = true;
        clearHandshakeTimer();
        void retireBundle();
      });

      reservedBundle.proxyChild?.on("error", (error) => {
        logger.error("sandbox.http_proxy_failed", error, error.message, {
          taskId: request.taskId,
        });
      });

      reservedBundle.proxyChild?.on("exit", (code, signal) => {
        if (finished || shutdownRequested || terminalEventSeen) {
          return;
        }
        logger.error("sandbox.http_proxy_exited", null, undefined, {
          taskId: request.taskId,
          code,
          signal,
        });
        void reportDisconnect(`HTTP proxy container exited before task completion (code=${code}, signal=${signal}).`);
        shutdownRequested = true;
        clearHandshakeTimer();
        void retireBundle();
      });

      return {
        sendUserMessage: async (input: TaskInputPayload) => {
          logger.debugContent("sandbox.user_message", {
            taskId: request.taskId,
            text: input.text,
            imageCount: input.images.length,
          });
          try {
            if (!taskInitialized) {
              await taskInitializedBarrier;
            }
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
          await retireBundle();
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
          await retireBundle();
        },
        resolveAuthRefresh: async (tokens: ChatGPTExternalTokens | null) => {
          logger.info("sandbox.auth_refresh", {
            taskId: request.taskId,
            hasTokens: tokens !== null,
          });
          try {
            await this.sendToWorker(child, {
              type: "chatgpt_auth_refresh_result",
              tokens,
              error: tokens ? null : "Token refresh failed.",
            });
          } catch (error) {
            logger.error("sandbox.auth_refresh_write_failed", error, this.describeWriteFailure(error), {
              taskId: request.taskId,
            });
          }
        },
      };
    } catch (error) {
      const cleanupRecord = this.taskBundles.get(request.taskId);
      if (cleanupRecord) {
        try {
          await this.deleteTaskShare(request.taskId);
        } catch (cleanupError) {
          logger.error("sandbox.share_cleanup_failed", cleanupError, String(cleanupError), {
            taskId: request.taskId,
            sharePath: cleanupRecord.bundle.shareHostPath,
          });
        }
      }
      throw error;
    }
  }

  private resolveWorkerImage(): string {
    return this.options.resolveWorkerImage?.() ?? this.options.workerImage;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shutdownRequested = true;
    this.shutdownPromise = this.pool.shutdown().then(() => {
      logger.info("sandbox.shutdown_complete", {});
    });
    return this.shutdownPromise;
  }

  async inspectTaskShare(taskId: string): Promise<ShareInspection> {
    const sharePath = this.requireTaskBundleRecord(taskId).bundle.shareHostPath;
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
    const taskBundleRecord = this.requireTaskBundleRecord(taskId);
    const sharePath = taskBundleRecord.bundle.shareHostPath;
    if (!taskBundleRecord.retired) {
      await this.pool.retireBundle(taskBundleRecord.bundle);
      taskBundleRecord.retired = true;
    }
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
        try {
          await rm(sharePath, {recursive: true, force: true});
        } catch (cleanupError) {
          if (!isPermissionError(cleanupError)) {
            throw cleanupError;
          }
        }
      } else {
        throw error;
      }
    }
    logger.info("sandbox.share_deleted", {
      taskId,
      sharePath,
    });
    this.taskBundles.delete(taskId);
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
        "sh",
        workerImage,
        "-lc",
        "rm -rf /target/* /target/.[!.]* /target/..?*",
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
          logger.error("sandbox.share_cleanup_docker_failed", null, undefined, {
            taskId,
            sharePath,
            exitCode: code,
          });
          reject(new Error(`Docker share cleanup exited with code ${code}`));
        }
      });
      child.on("error", (error) => {
        logger.error("sandbox.share_cleanup_docker_failed", error, String(error), {
          taskId,
          sharePath,
        });
        reject(error);
      });
    });
  }

  private requireTaskBundleRecord(taskId: string): TaskBundleRecord {
    const record = this.taskBundles.get(taskId);
    if (!record) {
      throw new Error(`No tracked share path is registered for task ${taskId}.`);
    }
    return record;
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

  private forwardContainerLog(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>,
  ): void {
    const payload = {
      source: "worker",
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
        logger.error(event, null, undefined, payload);
        return;
    }
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
