import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { SandboxHandle, SandboxRunner, LaunchTaskRequest } from "./sandbox-runner.js";
import type { HostCommand, SubAgentEvent } from "../types.js";
import { SubAgentBridge } from "../websocket/subagent-bridge.js";

export type DockerSandboxRunnerOptions = {
  workerImage: string;
  shareRoot: string;
  openAiApiKey: string;
};

export class DockerSandboxRunner implements SandboxRunner {
  constructor(
    private readonly options: DockerSandboxRunnerOptions,
    private readonly bridge: SubAgentBridge,
  ) {}

  async launchTask(
    request: LaunchTaskRequest,
    onEvent: (event: SubAgentEvent) => Promise<void>,
  ): Promise<SandboxHandle> {
    const sharePath = join(this.options.shareRoot, request.taskId);
    await mkdir(sharePath, { recursive: true });

    this.bridge.registerTask(request.taskId, onEvent);

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
      `SANDY_WS_URL=${this.bridge.workerUrl(request.taskId)}`,
      "-e",
      `OPENAI_API_KEY=${this.options.openAiApiKey}`,
      "-v",
      `${sharePath}:/workspace/share`,
      this.options.workerImage,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        void onEvent({
          type: "progress",
          message,
        });
      }
    });

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
      this.bridge.unregisterTask(request.taskId);
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
      this.bridge.unregisterTask(request.taskId);
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
        await this.sendToWorker(request.taskId, {
          type: "user_message",
          text,
        });
      },
      resolvePrivilege: async (requestId: string, decision: "approve" | "deny") => {
        await this.sendToWorker(request.taskId, {
          type: "privilege_decision",
          requestId,
          decision,
        });
      },
      cancel: async (reason: string) => {
        finished = true;
        this.bridge.unregisterTask(request.taskId);
        await this.sendToWorkerSafe(request.taskId, {
          type: "cancel",
          reason,
        });
        child.kill("SIGTERM");
        await this.sendDockerKill(containerName);
      },
    };
  }

  private async sendToWorker(taskId: string, command: HostCommand): Promise<void> {
    await this.bridge.sendCommand(taskId, command);
  }

  private async sendToWorkerSafe(taskId: string, command: HostCommand): Promise<void> {
    try {
      await this.bridge.sendCommand(taskId, command);
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
