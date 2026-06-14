import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { JobStore } from "./job-store.js";

async function makeTempConfigDirectory(): Promise<string> {
  const tmpRoot = join(process.cwd(), "tmp");
  await mkdir(tmpRoot, { recursive: true });
  return await mkdtemp(join(tmpRoot, "sandy-jobs-"));
}

test("JobStore separates definitions from runtime state", async () => {
  const configDirectory = await makeTempConfigDirectory();
  try {
    const store = new JobStore(configDirectory);
    await store.upsertDefinition({
      id: "daily-cleanup",
      name: "Daily cleanup",
      enabled: true,
      schedule: { kind: "cron", expression: "0 9 * * *" },
      skillId: "cleanup",
    });

    assert.equal((await store.listDefinitions()).length, 1);
    assert.deepEqual(await store.getRuntimeState("daily-cleanup"), {
      jobId: "daily-cleanup",
      lastRunAt: null,
    });

    await store.recordLaunch("daily-cleanup", "2026-06-07T10:00:00.000Z");
    assert.equal((await store.getDefinition("daily-cleanup"))?.name, "Daily cleanup");
    assert.deepEqual(await store.getRuntimeState("daily-cleanup"), {
      jobId: "daily-cleanup",
      lastRunAt: "2026-06-07T10:00:00.000Z",
    });
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("JobStore serializes concurrent writes so no update is lost", async () => {
  const configDirectory = await makeTempConfigDirectory();
  try {
    const store = new JobStore(configDirectory);
    await store.upsertDefinition({
      id: "daily-cleanup",
      name: "Daily cleanup",
      enabled: true,
      schedule: { kind: "cron", expression: "0 9 * * *" },
      skillId: "cleanup",
    });

    await Promise.all([
      store.recordLaunch("daily-cleanup", "2026-06-07T10:00:00.000Z"),
      store.setEnabled("daily-cleanup", false),
    ]);

    const definition = await store.getDefinition("daily-cleanup");
    const runtimeState = await store.getRuntimeState("daily-cleanup");

    assert.equal(definition?.enabled, false);
    assert.equal(runtimeState.lastRunAt, "2026-06-07T10:00:00.000Z");
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("JobStore validates cron expressions during upsert", async () => {
  const configDirectory = await makeTempConfigDirectory();
  try {
    const store = new JobStore(configDirectory);
    await assert.rejects(async () => await store.upsertDefinition({
      id: "bad-job",
      name: "Bad job",
      enabled: true,
      schedule: { kind: "cron", expression: "not cron" },
      skillId: "cleanup",
    }), /Invalid cron schedule/);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("JobStore.deleteOldOneShots removes consumed one-shot jobs with stale lastRunAt", async () => {
  const configDirectory = await makeTempConfigDirectory();
  try {
    const store = new JobStore(configDirectory);

    // A consumed one-shot with an old lastRunAt
    const oldRunAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await store.upsertDefinition({
      id: "old-shot",
      name: "Old shot",
      enabled: true,
      schedule: { kind: "one_shot", runAt: oldRunAt },
      skillId: "cleanup",
    });
    await store.recordLaunch("old-shot", oldRunAt);

    // A one-shot that has not run yet
    await store.upsertDefinition({
      id: "pending-shot",
      name: "Pending shot",
      enabled: true,
      schedule: { kind: "one_shot", runAt: new Date(Date.now() + 9999).toISOString() },
      skillId: "cleanup",
    });

    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const deleted = await store.deleteOldOneShots(cutoff);

    assert.equal(deleted, 1);

    const definitions = await store.listDefinitions();
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0]!.id, "pending-shot");

    // Runtime state for old-shot should also be removed
    const oldState = await store.getRuntimeState("old-shot");
    // getRuntimeState creates a default if missing, so we check lastRunAt
    assert.equal(oldState.lastRunAt, null);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});
