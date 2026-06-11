import type { ChannelAdapter } from "../channel/channel-adapter.js";
import type { JobService } from "../jobs/job-service.js";
import type { JobDefinition } from "../jobs/job-validation.js";
import { resolveTaskShareHostPath } from "../shared-workspace.js";
import type { ActiveTaskState } from "../types.js";

type UserVisibleOperationRunner = (input: {
  chatId: string;
  taskId: string;
  taskName: string;
  operation: () => Promise<void>;
}) => Promise<void>;

export type WorkerToolsHandlerDependencies = {
  readonly channel: Pick<ChannelAdapter, "sendFile">;
  readonly jobService: JobService;
  readonly getTaskSharePath: (taskId: string) => string;
  readonly runUserVisibleOperation: UserVisibleOperationRunner;
};

export class WorkerToolsHandler {
  constructor(private readonly deps: WorkerToolsHandlerDependencies) {}

  async sendFileToChannel(input: {
    chatId: string;
    task: ActiveTaskState;
    sharePath: string;
    caption?: string;
  }): Promise<void> {
    await this.deps.runUserVisibleOperation({
      chatId: input.chatId,
      taskId: input.task.taskId,
      taskName: input.task.taskName,
      operation: async () => {
        await this.deps.channel.sendFile(
          input.chatId,
          resolveTaskShareHostPath(this.deps.getTaskSharePath(input.task.taskId), input.sharePath, "send_file_to_channel path"),
          input.caption,
        );
      },
    });
  }

  async listJobs(): Promise<JobDefinition[]> {
    return await this.deps.jobService.listJobs();
  }

  async getJob(jobId: string): Promise<JobDefinition | null> {
    return await this.deps.jobService.getJob(jobId);
  }
}
