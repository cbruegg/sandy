import { mkdir, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { logger } from "../logger.js";
import type { SandboxHandle, SandboxRunner, LaunchTaskRequest, ShareInspection } from "./sandbox-runner.js";
import type { HostCommand, PrivilegeResolutionResult, SubAgentEvent } from "../types.js";
import { parseSubAgentEvent, serializeHostCommand } from "../types.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.js";

export type DockerSandboxRunnerOptions = {
  workerImage: string;
  shareRoot: string;
  openAiApiKey: string | null;
  codexAuthFile: string | null;
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

  constructor(private readonly options: DockerSandboxRunnerOptions) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  }

  async launchTask(
    request: LaunchTaskRequest,
    onEvent: (event: SubAgentEvent) => Promise<void>,
  ): Promise<SandboxHandle> {
    const sharePath = this.getTaskSharePath(request.taskId);
    await mkdir(sharePath, { recursive: true });

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
      workerImage: this.options.workerImage,
    });

    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      "--name",
      containerName,
      "-e",
      `SANDY_TASK_ID=${request.taskId}`,
      "-e",
      `SANDY_TASK_BRIEF=${request.taskBrief}`,
      "-e",
      `SANDY_CHANNEL_FORMATTING=${JSON.stringify(request.channelFormatting)}`,
    ];

    if (this.options.openAiApiKey) {
      dockerArgs.push("-e", `OPENAI_API_KEY=${this.options.openAiApiKey}`);
    }

    if (this.options.codexAuthFile) {
      dockerArgs.push(
        "-v",
        `${this.options.codexAuthFile}:/root/.codex/auth.json:ro`,
      );
    }

    dockerArgs.push(
      "-v",
      `${sharePath}:${sharedWorkspaceMountPath}`,
      this.options.workerImage,
    );

    const child = this.spawnImpl("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

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
      void this.sendDockerKill(containerName);
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
      await this.sendDockerKill(containerName);
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
    });

    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        logger.warn("sandbox.stderr", {
          taskId: request.taskId,
          message,
        });
        emitEventSafely({
          type: "progress",
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

    return {
      sendUserMessage: async (text: string) => {
        logger.debug("sandbox.user_message", {
          taskId: request.taskId,
          textPreview: text.length <= 120 ? text : `${text.slice(0, 117)}...`,
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
      close: () => {
        if (finished || shutdownRequested) {
          return Promise.resolve();
        }
        finished = true;
        shutdownRequested = true;
        clearHandshakeTimer();
        logger.info("sandbox.closing", {
          taskId: request.taskId,
        });
        child.stdin.end();
        return Promise.resolve();
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
        await this.sendDockerKill(containerName);
      },
    };
  }

  async inspectTaskShare(taskId: string): Promise<ShareInspection> {
    const sharePath = this.getTaskSharePath(taskId);
    let entries;
    try {
      entries = await readdir(sharePath, { withFileTypes: true });
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
    await rm(sharePath, { recursive: true, force: true });
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

  private async sendDockerKill(containerName: string): Promise<void> {
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

    const entries = await readdir(directoryPath, { withFileTypes: true });
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
