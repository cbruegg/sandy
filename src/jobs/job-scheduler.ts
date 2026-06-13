import { mkdir } from "node:fs/promises";
import { CronJob } from "cron";
import { logger } from "../logger.js";
import { validateSchedule } from "./job-validation.js";
import type { JobDefinition } from "./job-validation.js";
import { JobStore } from "./job-store.js";

export type JobSchedulerLauncher = (job: JobDefinition, workspacePath: string | null) => Promise<string>;

export class JobScheduler {
  private readonly scheduledJobs = new Map<string, CronJob>();
  private readonly launching = new Set<string>();
  private stopped = true;

  constructor(
    private readonly store: JobStore,
    private readonly launcher: JobSchedulerLauncher,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
  }

  stop(): void {
    this.stopped = true;
    for (const job of this.scheduledJobs.values()) void job.stop();
    this.scheduledJobs.clear();
  }

  async refresh(): Promise<void> {
    if (this.stopped) return;
    for (const job of this.scheduledJobs.values()) void job.stop();
    this.scheduledJobs.clear();
    const definitions = await this.store.listDefinitions();
    for (const definition of definitions) {
      if (definition.enabled) await this.register(definition);
    }
  }

  async runNow(jobId: string): Promise<string> {
    const definition = await this.store.getDefinition(jobId);
    if (!definition) throw new Error(`Job ${jobId} does not exist.`);
    return await this.launch(definition);
  }

  private async register(definition: JobDefinition): Promise<void> {
    validateSchedule(definition.schedule);
    if (definition.schedule.kind === "one_shot") {
      const runtimeState = await this.store.getRuntimeState(definition.id);
      if (runtimeState.lastRunAt !== null) return;
      const runAt = Date.parse(definition.schedule.runAt);
      if (runAt <= Date.now()) {
        queueMicrotask(() => {
          if (!this.stopped) void this.launch(definition).catch((error) => this.logLaunchFailure(definition, error));
        });
        return;
      }
      const oneShotJob = CronJob.from({
        cronTime: new Date(runAt),
        start: true,
        onTick: async () => {
          const runtimeState = await this.store.getRuntimeState(definition.id);
          if (runtimeState.lastRunAt !== null) return;
          await this.launch(definition);
        },
        errorHandler: (error) => this.logLaunchFailure(definition, error),
      });
      this.scheduledJobs.set(definition.id, oneShotJob);
      return;
    }

    const cronJob = CronJob.from({
      cronTime: definition.schedule.expression,
      timeZone: definition.schedule.timezone,
      waitForCompletion: true,
      start: true,
      onTick: async () => {
        await this.launch(definition);
      },
      errorHandler: (error) => this.logLaunchFailure(definition, error),
    });
    this.scheduledJobs.set(definition.id, cronJob);
  }

  private async launch(definition: JobDefinition): Promise<string> {
    if (this.launching.has(definition.id)) {
      throw new Error(`Job ${definition.id} already has a launch in progress.`);
    }
    this.launching.add(definition.id);
    try {
      const workspacePath = definition.schedule.kind === "cron" ? this.store.workspacePath(definition.id) : null;
      if (workspacePath) await mkdir(workspacePath, { recursive: true });
      const taskId = await this.launcher(definition, workspacePath);
      await this.store.recordLaunch(definition.id, new Date().toISOString());
      return taskId;
    } finally {
      this.launching.delete(definition.id);
    }
  }

  private logLaunchFailure(definition: JobDefinition, error: unknown): void {
    logger.error("job.launch_failed", error, "Scheduled job launch failed.", { jobId: definition.id });
  }
}
