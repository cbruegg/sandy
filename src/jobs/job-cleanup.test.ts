import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { JobCleanupService } from "./job-cleanup.js";
import { JobStore } from "./job-store.js";
import { SkillService } from "../skills.js";

async function makeTempConfigDirectory(): Promise<string> {
  const tmpRoot = join(process.cwd(), "tmp");
  await mkdir(tmpRoot, { recursive: true });
  return await mkdtemp(join(tmpRoot, "sandy-cleanup-"));
}

test("JobCleanupService deletes consumed one-shot jobs older than retention", async () => {
  const configDirectory = await makeTempConfigDirectory();
  try {
    const store = new JobStore(configDirectory, new SkillService(configDirectory));

    // Add a one-shot job that ran 20 days ago (older than 14-day retention)
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await store.upsertDefinition({
      id: "old-one-shot",
      name: "Old one-shot",
      enabled: true,
      schedule: { kind: "one_shot", runAt: twentyDaysAgo },
      skillId: "test-skill",
    });
    await store.recordLaunch("old-one-shot", twentyDaysAgo);

    // Add a one-shot job that ran 3 days ago (within retention)
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    await store.upsertDefinition({
      id: "recent-one-shot",
      name: "Recent one-shot",
      enabled: true,
      schedule: { kind: "one_shot", runAt: threeDaysAgo },
      skillId: "test-skill",
    });
    await store.recordLaunch("recent-one-shot", threeDaysAgo);

    // Add a cron job
    await store.upsertDefinition({
      id: "cron-job",
      name: "Cron job",
      enabled: true,
      schedule: { kind: "cron", expression: "0 9 * * *" },
      skillId: "test-skill",
    });
    await store.recordLaunch("cron-job", twentyDaysAgo);

    // Add a not-yet-run one-shot
    await store.upsertDefinition({
      id: "pending-one-shot",
      name: "Pending one-shot",
      enabled: true,
      schedule: { kind: "one_shot", runAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
      skillId: "test-skill",
    });

    const service = new JobCleanupService(store);
    await service.runOnce();

    const remaining = await store.listDefinitions();
    const remainingIds = remaining.map((d) => d.id).sort();

    // old-one-shot should be deleted
    assert.equal(remainingIds.includes("old-one-shot"), false, "old-one-shot should be deleted");

    // recent-one-shot should remain
    assert.equal(remainingIds.includes("recent-one-shot"), true);

    // cron job should remain
    assert.equal(remainingIds.includes("cron-job"), true);

    // pending (not-yet-run) one-shot should remain
    assert.equal(remainingIds.includes("pending-one-shot"), true);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("JobCleanupService does not delete a one-shot that was rescheduled to the future after running", async () => {
  const configDirectory = await makeTempConfigDirectory();
  try {
    const store = new JobStore(configDirectory, new SkillService(configDirectory));

    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Create a one-shot that ran 20 days ago but was rescheduled to the future
    await store.upsertDefinition({
      id: "rescheduled-one-shot",
      name: "Rescheduled one-shot",
      enabled: true,
      schedule: { kind: "one_shot", runAt: twentyDaysAgo },
      skillId: "test-skill",
    });
    await store.recordLaunch("rescheduled-one-shot", twentyDaysAgo);

    // Reschedule by updating to a future runAt (simulates re-scheduling)
    await store.upsertDefinition({
      id: "rescheduled-one-shot",
      name: "Rescheduled one-shot",
      enabled: true,
      schedule: { kind: "one_shot", runAt: futureDate },
      skillId: "test-skill",
    });

    const service = new JobCleanupService(store);
    await service.runOnce();

    const remaining = await store.listDefinitions();
    assert.equal(remaining.length, 1, "Rescheduled one-shot should not be deleted");
    assert.equal(remaining[0]!.id, "rescheduled-one-shot");
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});
