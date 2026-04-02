import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { logger } from "../logger.js";
import type { SandboxHandle, SandboxRunner, LaunchTaskRequest } from "./sandbox-runner.js";
import type { HostCommand, SubAgentEvent } from "../types.js";
import { parseSubAgentEvent, serializeHostCommand } from "../types.js";

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
    const sharePath = join(this.options.shareRoot, request.taskId);
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
      "--name",
      containerName,
      "-e",
      `SANDY_TASK_ID=${request.taskId}`,
      "-e",
      `SANDY_TASK_BRIEF=${request.taskBrief}`,
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
      `${sharePath}:/workspace/share`,
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

    this.attachStdoutParser(child, emitEvent);
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
        void emitEvent({
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
      void emitEvent({
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
      resolvePrivilege: async (requestId: string, decision: "approve" | "deny") => {
        logger.info("sandbox.privilege_decision", {
          taskId: request.taskId,
          requestId,
          decision,
        });
        try {
          await this.sendToWorker(child, {
            type: "privilege_decision",
            requestId,
            decision,
          });
        } catch (error) {
          await reportDisconnect(this.describeWriteFailure(error));
        }
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

  private attachStdoutParser(
    child: ChildProcessWithoutNullStreams,
    onEvent: (event: SubAgentEvent) => Promise<void>,
  ): void {
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
        void onEvent(event);
      } catch {
        logger.warn("sandbox.stdout_non_json", {
          line: trimmed,
        });
        void onEvent({
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
}
