import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { JobStore } from "./job-store.js";
import { SkillService } from "../skills.js";

async function makeTempConfigDirectory(): Promise<string> {
  const tmpRoot = join(process.cwd(), "tmp");
  await mkdir(tmpRoot, { recursive: true });
  return await mkdtemp(join(tmpRoot, "sandy-jobs-"));
}

test("JobStore separates definitions from runtime state", async () => {
  const configDirectory = await makeTempConfigDirectory();
  try {
    const store = new JobStore(configDirectory, new SkillService(configDirectory));
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
    const store = new JobStore(configDirectory, new SkillService(configDirectory));
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
    const store = new JobStore(configDirectory, new SkillService(configDirectory));
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
    const store = new JobStore(configDirectory, new SkillService(configDirectory));

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

test("JobStore.deleteDefinition archives skills owned by deleted jobs", async () => {
  const configDirectory = await makeTempConfigDirectory();
  try {
    const skillService = new SkillService(configDirectory);
    const store = new JobStore(configDirectory, skillService);
    skillService.createSkill({
      skillId: "owned-cleanup",
      name: "Owned cleanup",
      description: "Runs cleanup for one job.",
      body: "Clean up.",
    });
    await store.upsertDefinition({
      id: "owned-job",
      name: "Owned job",
      enabled: true,
      schedule: { kind: "cron", expression: "0 9 * * *" },
      skillId: "owned-cleanup",
      jobOwnsSkill: true,
    });

    await store.deleteDefinition("owned-job");

    assert.equal(await store.getDefinition("owned-job"), null);
    assert.deepEqual(await readdir(skillService.getSkillsDirectory()), []);
    const archivedEntries = await readdir(join(configDirectory, "archive", "skills"));
    assert.equal(archivedEntries.length, 1);
    assert.match(archivedEntries[0]!, /^owned-cleanup-[0-9a-f-]{36}$/);
    assert.deepEqual(await readdir(join(configDirectory, "archive", "skills", archivedEntries[0]!)), ["SKILL.md"]);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("JobStore.deleteDefinition leaves shared skills in place", async () => {
  const configDirectory = await makeTempConfigDirectory();
  try {
    const skillService = new SkillService(configDirectory);
    const store = new JobStore(configDirectory, skillService);
    skillService.createSkill({
      skillId: "shared-cleanup",
      name: "Shared cleanup",
      description: "Runs cleanup for many jobs.",
      body: "Clean up.",
    });
    await store.upsertDefinition({
      id: "shared-job",
      name: "Shared job",
      enabled: true,
      schedule: { kind: "cron", expression: "0 9 * * *" },
      skillId: "shared-cleanup",
    });

    await store.deleteDefinition("shared-job");

    assert.deepEqual(await readdir(skillService.getSkillsDirectory()), ["shared-cleanup"]);
    await assert.rejects(() => readdir(join(configDirectory, "archive", "skills")), /ENOENT/);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("JobStore.deleteDefinition keeps an owned skill when another job still references it", async () => {
  const configDirectory = await makeTempConfigDirectory();
  try {
    const skillService = new SkillService(configDirectory);
    const store = new JobStore(configDirectory, skillService);
    skillService.createSkill({
      skillId: "shared-owned-skill",
      name: "Shared owned skill",
      description: "Starts owned, later shared.",
      body: "Run shared cleanup.",
    });
    await store.upsertDefinition({
      id: "original-owner",
      name: "Original owner",
      enabled: true,
      schedule: { kind: "cron", expression: "0 9 * * *" },
      skillId: "shared-owned-skill",
      jobOwnsSkill: true,
    });
    await store.upsertDefinition({
      id: "shared-follower",
      name: "Shared follower",
      enabled: true,
      schedule: { kind: "cron", expression: "0 10 * * *" },
      skillId: "shared-owned-skill",
    });

    await store.deleteDefinition("original-owner");

    assert.equal((await store.getDefinition("shared-follower"))?.skillId, "shared-owned-skill");
    assert.deepEqual(await readdir(skillService.getSkillsDirectory()), ["shared-owned-skill"]);
    await assert.rejects(() => readdir(join(configDirectory, "archive", "skills")), /ENOENT/);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("JobStore.deleteOldOneShots archives skills owned by cleaned-up jobs", async () => {
  const configDirectory = await makeTempConfigDirectory();
  try {
    const skillService = new SkillService(configDirectory);
    const store = new JobStore(configDirectory, skillService);
    skillService.createSkill({
      skillId: "old-shot-skill",
      name: "Old shot skill",
      description: "Runs one old shot.",
      body: "Run once.",
    });
    const oldRunAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await store.upsertDefinition({
      id: "old-owned-shot",
      name: "Old owned shot",
      enabled: true,
      schedule: { kind: "one_shot", runAt: oldRunAt },
      skillId: "old-shot-skill",
      jobOwnsSkill: true,
    });
    await store.recordLaunch("old-owned-shot", oldRunAt);

    const deleted = await store.deleteOldOneShots(Date.now() - 14 * 24 * 60 * 60 * 1000);

    assert.equal(deleted, 1);
    assert.equal((await readdir(join(configDirectory, "archive", "skills"))).length, 1);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("JobStore.deleteOldOneShots keeps an owned skill when another job still references it", async () => {
  const configDirectory = await makeTempConfigDirectory();
  try {
    const skillService = new SkillService(configDirectory);
    const store = new JobStore(configDirectory, skillService);
    skillService.createSkill({
      skillId: "old-shared-skill",
      name: "Old shared skill",
      description: "Owned by a one-shot until reused.",
      body: "Run once or later.",
    });
    const oldRunAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await store.upsertDefinition({
      id: "old-owned-shot",
      name: "Old owned shot",
      enabled: true,
      schedule: { kind: "one_shot", runAt: oldRunAt },
      skillId: "old-shared-skill",
      jobOwnsSkill: true,
    });
    await store.recordLaunch("old-owned-shot", oldRunAt);
    await store.upsertDefinition({
      id: "surviving-shared-job",
      name: "Surviving shared job",
      enabled: true,
      schedule: { kind: "cron", expression: "0 11 * * *" },
      skillId: "old-shared-skill",
    });

    const deleted = await store.deleteOldOneShots(Date.now() - 14 * 24 * 60 * 60 * 1000);

    assert.equal(deleted, 1);
    assert.equal((await store.getDefinition("surviving-shared-job"))?.skillId, "old-shared-skill");
    assert.deepEqual(await readdir(skillService.getSkillsDirectory()), ["old-shared-skill"]);
    await assert.rejects(() => readdir(join(configDirectory, "archive", "skills")), /ENOENT/);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});
