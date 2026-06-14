import type { JobDefinition } from "./job-validation.js";
import type { JobMutationRequest } from "./job-types.js";
import type { JobScheduler } from "./job-scheduler.js";
import type { JobStore } from "./job-store.js";
import { assertNever } from "../utils/assert-never.js";

export interface JobService {
  listJobs(): Promise<JobDefinition[]>;
  getJob(jobId: string): Promise<JobDefinition | null>;
  applyMutation(mutation: JobMutationRequest): Promise<string>;
}

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

}


