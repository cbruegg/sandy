import type { ChannelAdapter } from "../channel/channel-adapter.js";
import { cp, mkdir } from "node:fs/promises";
import type { HostfsBroker } from "../hostfs/hostfs-broker.js";
import type { HostDirectoryAccessLevel } from "../hostfs/path-policy.js";
import type { JobMutationRequest } from "../jobs/job-types.js";
import type { JobService } from "../jobs/job-service.js";
import { messages } from "../messages.js";
import { dirname } from "node:path";
import { resolveAbsoluteHostPath } from "../host-paths.js";
import type { SandboxTaskBundle } from "../sandbox/sandbox-runner.js";
import type { SkillService } from "../skills.js";
import { resolveTaskShareHostPath } from "../shared-workspace.js";
import type { ActiveTaskState } from "../types.js";
import type { ChatId } from "../types.js";
import type { FileCopyWorkerToolPayload, NativeWorkerToolCallResult } from "../subagent/worker-tools.js";

type UserVisibleOperationRunner = (input: {
  chatId: ChatId;
  taskId: string;
  taskName: string;
  operation: (channel: ChannelAdapter) => Promise<void>;
}) => Promise<void>;

export type WorkerToolsHandlerDependencies = {
  readonly jobService: JobService;
  readonly skillService: SkillService;
  readonly hostfsBroker: HostfsBroker;
  readonly getTaskSharePath: (taskId: string) => string;
  readonly getTaskBundle: (taskId: string) => SandboxTaskBundle;
  readonly runUserVisibleOperation: UserVisibleOperationRunner;
};

type FileCopyOperationResult = {
  outcome: "approved" | "failed";
  message: string;
};

export class WorkerToolsHandler {
  constructor(private readonly deps: WorkerToolsHandlerDependencies) {}

  async sendFileToChannel(input: {
    chatId: ChatId;
    task: ActiveTaskState;
    sharePath: string;
    caption?: string;
  }): Promise<NativeWorkerToolCallResult> {
    await this.deps.runUserVisibleOperation({
      chatId: input.chatId,
      taskId: input.task.taskId,
      taskName: input.task.taskName,
      operation: async (channel) => {
        await channel.sendFile(
          input.chatId,
          resolveTaskShareHostPath(this.deps.getTaskSharePath(input.task.taskId), input.sharePath, "send_file_to_channel path"),
          input.caption,
        );
      },
    });
    return { isError: false, message: messages.sharedFileSentToUser(input.sharePath) };
  }

  async requestInteraction(input: {
    chatId: ChatId;
    task: ActiveTaskState;
    message?: string;
  }): Promise<NativeWorkerToolCallResult> {
    if (input.task.origin.kind !== "launchedByJob") {
      return { isError: false, message: messages.requestInteractionAlreadyInteractive() };
    }
    if (input.task.interactionState === "interacting") {
      return { isError: false, message: messages.requestInteractionAlreadyInteractive() };
    }
    if (input.task.interactionState === "waitingToInteract") {
      return { isError: false, message: messages.requestInteractionAlreadyRequested() };
    }

    await this.deps.runUserVisibleOperation({
      chatId: input.chatId,
      taskId: input.task.taskId,
      taskName: input.task.taskName,
      operation: async (channel) => {
        await channel.sendTaskUpdate(input.chatId, messages.jobRequestsInteraction(input.task.taskName, input.message));
      },
    });
    return { isError: false, message: messages.requestInteractionApproved() };
  }

  async listJobs(): Promise<NativeWorkerToolCallResult> {
    const jobs = await this.deps.jobService.listJobs();
    return { isError: false, message: JSON.stringify(jobs) };
  }

  async getJob(jobId: string): Promise<NativeWorkerToolCallResult> {
    const job = await this.deps.jobService.getJob(jobId);
    if (!job) {
      return { isError: true, message: messages.jobDoesNotExist(jobId) };
    }
    return { isError: false, message: JSON.stringify(job) };
  }

  async applySkillMutation(input: {
    operation: "create" | "update" | "delete";
    skillId: string;
    name?: string;
    description?: string;
    body?: string;
  }): Promise<void> {
    switch (input.operation) {
      case "create":
        await this.deps.skillService.createSkill({
          skillId: input.skillId,
          name: input.name ?? "",
          description: input.description ?? "",
          body: input.body ?? "",
        });
        return;
      case "update":
        await this.deps.skillService.updateSkill({
          skillId: input.skillId,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
        });
        return;
      case "delete":
        await this.deps.skillService.deleteSkill({ skillId: input.skillId });
        return;
      default:
        assertNever(input.operation);
    }
  }

  async applyJobMutation(mutation: JobMutationRequest): Promise<string> {
    return await this.deps.jobService.applyMutation(mutation);
  }

  async applyFileCopy(
    request: FileCopyWorkerToolPayload,
    input: { taskId: string },
  ): Promise<FileCopyOperationResult> {
    const taskSharePath = this.deps.getTaskSharePath(input.taskId);

    try {
      switch (request.type) {
        case "copy_into_share":
          return await this.copyIntoShare(request, taskSharePath);
        case "copy_out_of_share":
          return await this.copyOutOfShare(request, taskSharePath);
        default:
          return assertNever(request);
      }
    } catch (error) {
      return {
        outcome: "failed",
        message: error instanceof Error ? error.message : "Privilege operation failed.",
      };
    }
  }

  async mountHostDirectory(input: {
    taskId: string;
    path: string;
    level: HostDirectoryAccessLevel;
  }): Promise<{ ok: true; grantPath: string } | { ok: false; error: string }> {
    const taskBundle = this.deps.getTaskBundle(input.taskId);
    if (!taskBundle.hostfsVolumeName) {
      return {
        ok: false,
        error: "This task bundle does not have a hostfs mount.",
      };
    }

    const result = await this.deps.hostfsBroker.requestDirectoryAccess(
      taskBundle.bundleId,
      input.taskId,
      input.path,
      input.level,
    );
    if (!result.ok) {
      return result;
    }

    return {
      ok: true,
      grantPath: result.grantPath,
    };
  }

  private async copyIntoShare(
    request: Extract<FileCopyWorkerToolPayload, { type: "copy_into_share" }>,
    taskSharePath: string,
  ): Promise<FileCopyOperationResult> {
    const sourcePath = resolveAbsoluteHostPath(request.sourcePath, "copy_into_share sourcePath");
    const targetPath = resolveTaskShareHostPath(taskSharePath, request.targetPath, "copy_into_share targetPath");

    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });

    return {
      outcome: "approved",
      message: `Copied ${sourcePath} into the shared workspace at ${request.targetPath}.`,
    };
  }

  private async copyOutOfShare(
    request: Extract<FileCopyWorkerToolPayload, { type: "copy_out_of_share" }>,
    taskSharePath: string,
  ): Promise<FileCopyOperationResult> {
    const sourcePath = resolveTaskShareHostPath(taskSharePath, request.sourcePath, "copy_out_of_share sourcePath");
    const targetPath = resolveAbsoluteHostPath(request.targetPath, "copy_out_of_share targetPath");

    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });

    return {
      outcome: "approved",
      message: `Copied ${request.sourcePath} out of the shared workspace to ${targetPath}.`,
    };
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected worker tool handler case: ${String(value)}`);
}
