import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { SandboxHandle, SandboxRunner, LaunchTaskRequest } from "./sandbox-runner.js";
import type { HostCommand, SubAgentEvent } from "../types.js";
import { parseSubAgentEvent, serializeHostCommand } from "../types.js";

export type DockerSandboxRunnerOptions = {
  workerImage: string;
  shareRoot: string;
  openAiApiKey: string;
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

    const child = spawn("docker", [
      "run",
      "--rm",
      "--name",
      containerName,
      "-e",
      `SANDY_TASK_ID=${request.taskId}`,
      "-e",
      `SANDY_TASK_BRIEF=${request.taskBrief}`,
      "-e",
      `OPENAI_API_KEY=${this.options.openAiApiKey}`,
      "-v",
      `${sharePath}:/workspace/share`,
      this.options.workerImage,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.attachStdoutParser(child, onEvent);
    void onEvent({ type: "worker_connected" });

    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) {
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
        return;
      }
      void onEvent({
        type: "task_error",
        message: `Sub-agent container exited unexpectedly (code=${code}, signal=${signal}).`,
      });
    });

    return {
      sendUserMessage: async (text: string) => {
        await this.sendToWorker(child, {
          type: "user_message",
          text,
        });
      },
      resolvePrivilege: async (requestId: string, decision: "approve" | "deny") => {
        await this.sendToWorker(child, {
          type: "privilege_decision",
          requestId,
          decision,
        });
      },
      cancel: async (reason: string) => {
        finished = true;
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
        void onEvent(event);
      } catch {
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
      const child = spawn("docker", ["rm", "-f", containerName], {
        stdio: "ignore",
      });
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
  }
}
