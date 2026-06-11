import type { ChannelAdapter } from "../channel/channel-adapter.js";
import type { JobService } from "../jobs/job-service.js";
import { resolveTaskShareHostPath } from "../shared-workspace.js";
import type { ActiveTaskState } from "../types.js";
import type {NativeWorkerToolCallResult} from "../orchestrator/privileges.ts";
import {messages} from "../messages.ts";

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
  }): Promise<NativeWorkerToolCallResult> {
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
    return { isError: false, message: messages.sharedFileSentToUser(input.sharePath) }
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
}
