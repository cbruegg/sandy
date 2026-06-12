import { z } from "zod";
import { CronTime } from "cron";

const jobIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const jobScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("one_shot"), runAt: z.string().datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal("cron"), expression: z.string().min(1), timezone: z.string().min(1).optional() }).strict(),
]);

const jobDefinitionSchema = z.object({
  id: jobIdSchema,
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  schedule: jobScheduleSchema,
  skillId: z.string().trim().min(1),
}).strict();

const jobRuntimeStateSchema = z.object({
  jobId: z.string().min(1),
  lastRunAt: z.string().nullable(),
}).strict();

export const jobsFileSchema = z.object({
  definitions: z.array(jobDefinitionSchema),
  runtimeState: z.array(jobRuntimeStateSchema),
}).strict();

export type JobSchedule = z.infer<typeof jobScheduleSchema>;
export type JobDefinition = z.infer<typeof jobDefinitionSchema>;
export type JobRuntimeState = z.infer<typeof jobRuntimeStateSchema>;
export type JobsFile = z.infer<typeof jobsFileSchema>;

export function validateJobDefinition(definition: JobDefinition): JobDefinition {
  const parsed = jobDefinitionSchema.parse(definition);
  validateSchedule(parsed.schedule);
  return parsed;
}

export function validateSchedule(schedule: JobSchedule): void {
  if (schedule.kind === "one_shot") {
    const runAt = Date.parse(schedule.runAt);
    if (!Number.isFinite(runAt)) {
      throw new Error("One-shot runAt must be a valid ISO date-time.");
    }
    return;
  }

  try {
    new CronTime(schedule.expression, schedule.timezone);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid cron expression.";
    throw new Error(`Invalid cron schedule: ${message}`, { cause: error });
  }
}
