import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildJobTaskBrief } from "./job-task-brief.js";

test("buildJobTaskBrief explains silent output and visibility requests", () => {
  const brief = buildJobTaskBrief({
    id: "job-1",
    name: "Daily cleanup",
    enabled: true,
    schedule: { kind: "cron", expression: "0 9 * * *" },
    skillId: "cleanup",
  }, "/host/jobs/job-1");

  assert.match(brief, /assistant messages and progress updates.*dropped/i);
  assert.match(brief, /privilege requests, and send_file_to_channel will ask Sandy to make this task visible/i);
  assert.match(brief, /Wait for Sandy's explicit notice that the task became interactive/i);
});
