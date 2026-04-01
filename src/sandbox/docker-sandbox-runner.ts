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
};

export class DockerSandboxRunner implements SandboxRunner {
  constructor(private readonly options: DockerSandboxRunnerOptions) {}

  async launchTask(
    request: LaunchTaskRequest,
    onEvent: (event: SubAgentEvent) => Promise<void>,
  ): Promise<SandboxHandle> {
    const sharePath = join(this.options.shareRoot, request.taskId);
    await mkdir(sharePath, { recursive: true });

    const containerName = `sandy-${request.taskId}`;
    let finished = false;
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

    const child = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.attachStdoutParser(child, onEvent);
    void onEvent({ type: "worker_connected" });
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
        void onEvent({
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
      logger.error("sandbox.launch_failed", {
        taskId: request.taskId,
        message: error.message,
      });
      void onEvent({
        type: "task_error",
        message: `Failed to launch Docker sub-agent: ${error.message}`,
      });
    });

    child.on("exit", (code, signal) => {
      if (finished) {
        return;
      }
      finished = true;
      if (code === 0 || signal === "SIGTERM") {
        logger.info("sandbox.exited", {
          taskId: request.taskId,
          code,
          signal,
        });
        return;
      }
      logger.error("sandbox.exited_unexpectedly", {
        taskId: request.taskId,
        code,
        signal,
      });
      void onEvent({
        type: "task_error",
        message: `Sub-agent container exited unexpectedly (code=${code}, signal=${signal}).`,
      });
    });

    return {
      sendUserMessage: async (text: string) => {
        logger.debug("sandbox.user_message", {
          taskId: request.taskId,
          textPreview: text.length <= 120 ? text : `${text.slice(0, 117)}...`,
        });
        await this.sendToWorker(child, {
          type: "user_message",
          text,
        });
      },
      resolvePrivilege: async (requestId: string, decision: "approve" | "deny") => {
        logger.info("sandbox.privilege_decision", {
          taskId: request.taskId,
          requestId,
          decision,
        });
        await this.sendToWorker(child, {
          type: "privilege_decision",
          requestId,
          decision,
        });
      },
      cancel: async (reason: string) => {
        finished = true;
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
      const child = spawn("docker", ["rm", "-f", containerName], {
        stdio: "ignore",
      });
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
  }
}
