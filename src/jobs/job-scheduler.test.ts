import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { JobStore } from "./job-store.js";
import { JobScheduler } from "./job-scheduler.js";
import type { JobDefinition } from "./job-validation.js";

function makeTempConfigDirectory(): string {
  const tmpRoot = join(process.cwd(), "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  return mkdtempSync(join(tmpRoot, "sandy-job-scheduler-"));
}

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
  const configDirectory = makeTempConfigDirectory();
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
  const configDirectory = makeTempConfigDirectory();
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
  const configDirectory = makeTempConfigDirectory();
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

test("JobScheduler runNow prevents future one-shot from launching again at scheduled time", async () => {
  const configDirectory = makeTempConfigDirectory();
  const store = new JobStore(configDirectory);
  const runAt = new Date(Date.now() + 300);
  await store.upsertDefinition(createJob({
    id: "one-shot",
    name: "One shot",
    schedule: { kind: "one_shot", runAt: runAt.toISOString() },
  }));

  const launches: string[] = [];
  const scheduler = new JobScheduler(store, async (job) => {
    launches.push(job.id);
    return "task-one-shot";
  });

  await scheduler.start();
  await scheduler.runNow("one-shot");
  assert.equal(launches.length, 1);

  await new Promise<void>((resolve) => setTimeout(resolve, 500));
  assert.equal(launches.length, 1);

  scheduler.stop();
});

test("JobScheduler runNow races with one-shot timer firing at the same time", async () => {
  const configDirectory = makeTempConfigDirectory();
  const store = new JobStore(configDirectory);
  // Timer fires immediately (scheduled in the past).
  await store.upsertDefinition(createJob({
    id: "one-shot",
    name: "One shot",
    schedule: { kind: "one_shot", runAt: new Date(Date.now() - 1000).toISOString() },
  }));

  let signalLaunchStarted!: () => void;
  let releaseLaunch!: () => void;
  const launchStarted = new Promise<void>((resolve) => { signalLaunchStarted = resolve; });

  let launchCount = 0;
  const scheduler = new JobScheduler(store, async () => {
    signalLaunchStarted();
    await new Promise<void>((resolve) => { releaseLaunch = resolve; });
    launchCount++;
    return "task-1";
  });

  await scheduler.start();

  // Wait for the startup one-shot timer callback to enter its launcher.
  await launchStarted;

  // runNow → stops the timer (already fired, redundant but harmless) → hits
  // the `launching` guard because the timer's launch is in progress.
  await assert.rejects(
    () => scheduler.runNow("one-shot"),
    /already has a launch in progress/,
  );

  releaseLaunch();
  // Wait for the slow launcher to finish.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(launchCount, 1);

  scheduler.stop();
});
