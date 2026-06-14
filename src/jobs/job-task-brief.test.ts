import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildJobTaskBrief } from "./job-task-brief.js";
import {
  requestInteractionToolName,
  updateJobToolName,
  terminateTaskToolName,
} from "../subagent/worker-tools.js";
import type { JobDefinition } from "./job-validation.js";

function createJob(overrides?: Partial<JobDefinition>): JobDefinition {
  return {
    id: "cleanup-once",
    name: "One-shot cleanup",
    enabled: true,
    schedule: { kind: "one_shot", runAt: "2026-04-01T00:00:00.000Z" },
    skillId: "cleanup",
    ...overrides,
  };
}

test("one-shot job task brief includes rescheduling instructions", () => {
  const brief = buildJobTaskBrief(createJob(), null);
  assert.match(brief, /one-off job/);
  assert.match(brief, new RegExp(`sandy\\.${requestInteractionToolName}`));
  assert.match(brief, new RegExp(`sandy\\.${updateJobToolName}`));
  assert.match(brief, new RegExp(`sandy\\.${terminateTaskToolName}`));
});

test("cron job task brief does not include rescheduling instructions", () => {
  const brief = buildJobTaskBrief(createJob({
    schedule: { kind: "cron", expression: "0 9 * * *" },
  }), null);
  assert.doesNotMatch(brief, /one-off job/);
  assert.doesNotMatch(brief, new RegExp(`sandy\\.${updateJobToolName}`));
});
