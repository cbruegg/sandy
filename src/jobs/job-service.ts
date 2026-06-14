import type { JobDefinition } from "./job-validation.js";
import type { JobMutationRequest } from "./job-types.js";
import type { JobScheduler } from "./job-scheduler.js";
import type { JobStore } from "./job-store.js";
import { assertNever } from "../assert-never.js";

export interface JobService {
  listJobs(): Promise<JobDefinition[]>;
  getJob(jobId: string): Promise<JobDefinition | null>;
  applyMutation(mutation: JobMutationRequest): Promise<JobMutationResult>;
}

export type JobMutationResult = {
  readonly message: string;
  readonly deletedJob: JobDefinition | null;
};

export class ScheduledJobService implements JobService {
  constructor(
    private readonly store: JobStore,
    private readonly scheduler: JobScheduler,
  ) {}

  async listJobs(): Promise<JobDefinition[]> {
    return await this.store.listDefinitions();
  }

  async getJob(jobId: string): Promise<JobDefinition | null> {
    return await this.store.getDefinition(jobId);
  }

  async applyMutation(mutation: JobMutationRequest): Promise<JobMutationResult> {
    switch (mutation.operation) {
      case "create":
      case "update":
        if (!mutation.definition) throw new Error("Job definition is required.");
        await this.store.upsertDefinition(mutation.definition);
        await this.scheduler.refresh();
        return { message: `Updated job ${mutation.jobId}.`, deletedJob: null };
      case "delete": {
        const deletedJob = await this.store.getDefinition(mutation.jobId);
        await this.store.deleteDefinition(mutation.jobId);
        await this.scheduler.refresh();
        return { message: `Deleted job ${mutation.jobId}.`, deletedJob };
      }
      case "enable":
        await this.store.setEnabled(mutation.jobId, true);
        await this.scheduler.refresh();
        return { message: `Enabled job ${mutation.jobId}.`, deletedJob: null };
      case "disable":
        await this.store.setEnabled(mutation.jobId, false);
        await this.scheduler.refresh();
        return { message: `Disabled job ${mutation.jobId}.`, deletedJob: null };
      case "run_now": {
        const taskId = await this.scheduler.runNow(mutation.jobId);
        return { message: `Launched task ${taskId}.`, deletedJob: null };
      }
      default:
        assertNever(mutation.operation);
    }
  }

}
