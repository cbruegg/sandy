import { z } from "zod";
import type { JobDefinition, JobSchedule } from "./job-types.js";

const jobIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);

const jobScheduleSchema: z.ZodType<JobSchedule> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("one_shot"), runAt: z.string().datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal("cron"), expression: z.string().min(1), timezone: z.string().min(1).optional() }).strict(),
]);

export const jobDefinitionSchema: z.ZodType<JobDefinition> = z.object({
  id: jobIdSchema,
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  schedule: jobScheduleSchema,
  skillId: z.string().trim().min(1),
  prompt: z.string().optional(),
}).strict();

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

  const fields = schedule.expression.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    throw new Error("Cron expressions must contain 5 or 6 fields.");
  }
  // Conservative first-version validation. The scheduler below supports common
  // cron syntax: *, numbers, ranges, lists, and step values.
  const offset = fields.length === 5 ? 1 : 0;
  fields.forEach((field, index) => validateCronField(field, index + offset));
}

function validateCronField(field: string, index: number): void {
  const maxByIndex = [59, 59, 23, 31, 12, 7];
  const minByIndex = [0, 0, 0, 1, 1, 0];
  const min = minByIndex[index] ?? 0;
  const max = maxByIndex[index] ?? 59;
  for (const part of field.split(",")) {
    const [rawBase, step] = part.split("/");
    const base = rawBase ?? "*";
    if (step !== undefined && (!/^\d+$/.test(step) || Number(step) <= 0)) {
      throw new Error(`Invalid cron step in field "${field}".`);
    }
    if (base === "*" || base === "?") continue;
    const range = base.split("-");
    if (range.length > 2 || range.some((value) => !/^\d+$/.test(value))) {
      throw new Error(`Invalid cron field "${field}".`);
    }
    for (const value of range) {
      const number = Number(value);
      if (number < min || number > max) {
        throw new Error(`Cron field value ${number} is outside ${min}-${max}.`);
      }
    }
  }
}
