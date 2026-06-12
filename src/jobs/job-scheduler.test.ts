import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "./job-store.js";
import { JobScheduler } from "./job-scheduler.js";
import type { JobDefinition } from "./job-validation.js";

function createJob(overrides?: Partial<JobDefinition>): JobDefinition {
  return {
    id: "daily-cleanup",
    name: "Daily cleanup",
    enabled: true,
    schedule: { kind: "cron", expression: "0 9 * * *" },
    skillId: "cleanup-skill",
    ...overrides,
  };
}

test("JobScheduler runNow records launches", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "sandy-job-scheduler-"));
  const store = new JobStore(configDirectory);
  await store.upsertDefinition(createJob());

  const launches: Array<{ jobId: string; workspacePath: string | null }> = [];
  const scheduler = new JobScheduler(store, async (job, workspacePath) => {
    launches.push({ jobId: job.id, workspacePath });
    return "task-1";
  });

  const taskId = await scheduler.runNow("daily-cleanup");
  const runtimeState = await store.getRuntimeState("daily-cleanup");

  assert.equal(taskId, "task-1");
  assert.equal(launches.length, 1);
  assert.match(launches[0]?.workspacePath ?? "", /daily-cleanup$/);
  assert.notEqual(runtimeState.lastRunAt, null);
});

test("JobScheduler prevents duplicate launches while one is in progress", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "sandy-job-scheduler-"));
  const store = new JobStore(configDirectory);
  await store.upsertDefinition(createJob());

  let releaseLaunch!: () => void;
  let signalLaunchStarted!: () => void;
  const launchStarted = new Promise<void>((resolve) => {
    signalLaunchStarted = resolve;
  });
  const scheduler = new JobScheduler(store, async () => {
    signalLaunchStarted();
    await new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    return "task-1";
  });

  const firstLaunch = scheduler.runNow("daily-cleanup");
  await launchStarted;

  await assert.rejects(() => scheduler.runNow("daily-cleanup"), /already has a launch in progress/);

  releaseLaunch();
  await firstLaunch;
});

test("JobScheduler launches past one-shot jobs once at startup", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "sandy-job-scheduler-"));
  const store = new JobStore(configDirectory);
  await store.upsertDefinition(createJob({
    id: "one-shot",
    name: "One shot",
    schedule: { kind: "one_shot", runAt: new Date(Date.now() - 1_000).toISOString() },
  }));

  const launches: string[] = [];
  const scheduler = new JobScheduler(store, async (job) => {
    launches.push(job.id);
    return "task-one-shot";
  });

  await scheduler.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const runtimeState = await store.getRuntimeState("one-shot");
  assert.deepEqual(launches, ["one-shot"]);
  assert.notEqual(runtimeState.lastRunAt, null);

  scheduler.stop();
});
