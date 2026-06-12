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
