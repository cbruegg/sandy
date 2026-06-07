import type { ChannelDestinationStore } from "../channel/channel-destination-store.js";
import type { JobDefinition, JobMutationRequest } from "./job-types.js";
import type { JobScheduler } from "./job-scheduler.js";
import type { JobStore } from "./job-store.js";

export type JobTaskLauncher = (job: JobDefinition, chatId: string, workspacePath: string | null) => Promise<string>;

export interface JobService {
  start(): Promise<void>;
  stop(): void;
  listJobs(): Promise<JobDefinition[]>;
  getJob(jobId: string): Promise<JobDefinition | null>;
  applyMutation(mutation: JobMutationRequest): Promise<string>;
  getDefaultChatId(): Promise<string | null>;
  persistDefaultChatId(chatId: string): Promise<void>;
}

export class ScheduledJobService implements JobService {
  constructor(
    private readonly store: JobStore,
    private readonly destinationStore: ChannelDestinationStore,
    private readonly scheduler: JobScheduler,
  ) {}

  async start(): Promise<void> {
    await this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  async listJobs(): Promise<JobDefinition[]> {
    return await this.store.listDefinitions();
  }

  async getJob(jobId: string): Promise<JobDefinition | null> {
    return await this.store.getDefinition(jobId);
  }

  async applyMutation(mutation: JobMutationRequest): Promise<string> {
    switch (mutation.operation) {
      case "create":
      case "update":
        if (!mutation.definition) throw new Error("Job definition is required.");
        await this.store.upsertDefinition(mutation.definition);
        await this.scheduler.refresh();
        return `Updated job ${mutation.jobId}.`;
      case "delete":
        await this.store.deleteDefinition(mutation.jobId);
        await this.scheduler.refresh();
        return `Deleted job ${mutation.jobId}.`;
      case "enable":
        await this.store.setEnabled(mutation.jobId, true);
        await this.scheduler.refresh();
        return `Enabled job ${mutation.jobId}.`;
      case "disable":
        await this.store.setEnabled(mutation.jobId, false);
        await this.scheduler.refresh();
        return `Disabled job ${mutation.jobId}.`;
      case "run_now": {
        const taskId = await this.scheduler.runNow(mutation.jobId);
        return `Launched task ${taskId}.`;
      }
      default:
        assertNever(mutation.operation);
    }
  }

  async getDefaultChatId(): Promise<string | null> {
    return await this.destinationStore.getDefaultChatId();
  }

  async persistDefaultChatId(chatId: string): Promise<void> {
    await this.destinationStore.setDefaultChatId(chatId);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected job mutation operation: ${String(value)}`);
}
