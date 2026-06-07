import { mkdir } from "node:fs/promises";
import { logger } from "../logger.js";
import { validateSchedule } from "./job-validation.js";
import type { JobDefinition } from "./job-types.js";
import { JobStore } from "./job-store.js";

type Timer = ReturnType<typeof setTimeout>;

export type JobSchedulerLauncher = (job: JobDefinition, workspacePath: string) => Promise<string>;

export class JobScheduler {
  private readonly timers = new Map<string, Timer>();
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
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async refresh(): Promise<void> {
    if (this.stopped) return;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
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
      const delay = Math.max(0, Date.parse(definition.schedule.runAt) - Date.now());
      this.timers.set(definition.id, setTimeout(() => void this.launch(definition).catch((error) => this.logLaunchFailure(definition, error)), delay));
      return;
    }

    const nextRunAt = nextCronRunAt(definition.schedule.expression, new Date());
    const delay = Math.max(0, nextRunAt.getTime() - Date.now());
    this.timers.set(definition.id, setTimeout(() => {
      void this.launch(definition)
        .catch((error) => this.logLaunchFailure(definition, error))
        .finally(() => {
          if (!this.stopped) void this.register(definition).catch((error) => this.logLaunchFailure(definition, error));
        });
    }, delay));
  }

  private async launch(definition: JobDefinition): Promise<string> {
    if (this.launching.has(definition.id)) {
      throw new Error(`Job ${definition.id} already has a launch in progress.`);
    }
    this.launching.add(definition.id);
    try {
      const workspacePath = this.store.workspacePath(definition.id);
      await mkdir(workspacePath, { recursive: true });
      const taskId = await this.launcher(definition, workspacePath);
      await this.store.recordLaunch(definition.id, taskId, new Date().toISOString());
      return taskId;
    } finally {
      this.launching.delete(definition.id);
    }
  }

  private logLaunchFailure(definition: JobDefinition, error: unknown): void {
    logger.error("job.launch_failed", error, "Scheduled job launch failed.", { jobId: definition.id });
  }
}

function nextCronRunAt(expression: string, after: Date): Date {
  const fields = expression.trim().split(/\s+/);
  const normalized = fields.length === 5 ? ["0", ...fields] : fields;
  const parsed = normalized.map((field, index) => parseCronField(field, index));
  const cursor = new Date(after.getTime() + 1000);
  cursor.setMilliseconds(0);
  for (let i = 0; i < 366 * 24 * 60 * 60; i += 1) {
    if (
      parsed[0]!.has(cursor.getSeconds())
      && parsed[1]!.has(cursor.getMinutes())
      && parsed[2]!.has(cursor.getHours())
      && parsed[3]!.has(cursor.getDate())
      && parsed[4]!.has(cursor.getMonth() + 1)
      && parsed[5]!.has(cursor.getDay())
    ) return cursor;
    cursor.setSeconds(cursor.getSeconds() + 1);
  }
  throw new Error(`Could not find a future run time for cron expression "${expression}".`);
}

function parseCronField(field: string, index: number): Set<number> {
  const minByIndex = [0, 0, 0, 1, 1, 0];
  const maxByIndex = [59, 59, 23, 31, 12, 7];
  const min = minByIndex[index] ?? 0;
  const max = maxByIndex[index] ?? 59;
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rawBase, rawStep] = part.split("/");
    const base = rawBase ?? "*";
    const step = rawStep ? Number(rawStep) : 1;
    const [rawStart, rawEnd] = base === "*" || base === "?"
      ? [min, max]
      : base.includes("-")
        ? base.split("-").map(Number)
        : [Number(base), Number(base)];
    const start = rawStart ?? min;
    const end = rawEnd ?? max;
    for (let value = start; value <= end; value += step) values.add(value === 7 && index === 5 ? 0 : value);
  }
  return values;
}
