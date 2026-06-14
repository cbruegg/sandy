import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillService } from "../skills.js";
import { JobStore } from "../jobs/job-store.js";
import { InMemorySessionStore } from "../session/in-memory-session-store.js";
import { SkillArchiveCoordinator } from "./skill-archive-coordinator.js";
import { RecordingChannel } from "./test-helpers.js";
import { TaskCoordinator } from "./task-coordinator.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sandy-archive-test-"));
}

test("SkillArchiveCoordinator does not offer archive when skill is still used by another job", async () => {
  const configDir = makeTempDir();
  const skillService = new SkillService(configDir);
  const jobStore = new JobStore(configDir);
  const sessionStore = new InMemorySessionStore();
  const channel = new RecordingChannel();

  // Create the skill
  await skillService.createSkill({ skillId: "test-skill", name: "Test", description: "Desc", body: "body" });

  // Create two jobs that use the skill
  await jobStore.upsertDefinition({
    id: "job-1",
    name: "Job 1",
    enabled: true,
    schedule: { kind: "one_shot", runAt: new Date().toISOString() },
    skillId: "test-skill",
  });
  await jobStore.upsertDefinition({
    id: "job-2",
    name: "Job 2",
    enabled: false,
    schedule: { kind: "cron", expression: "0 9 * * *" },
    skillId: "test-skill",
  });

  const taskCoordinator = new TaskCoordinator({
    sessionStore,
    channel,
    onJobTaskBecameInteractive: async () => {},
  });

  const coordinator = new SkillArchiveCoordinator(skillService, jobStore, sessionStore, channel, taskCoordinator);

  const chatId = "test-chat";

  // Offer archive after deleting job-1 (job-2 still uses skill)
  await jobStore.deleteDefinition("job-1");
  await coordinator.offerArchiveForJobSkill(chatId, "test-skill");

  // No privilege request should have been sent
  assert.equal(channel.privilegeRequests.length, 0);
});

test("SkillArchiveCoordinator offers archive when skill is orphaned", async () => {
  const configDir = makeTempDir();
  const skillService = new SkillService(configDir);
  const jobStore = new JobStore(configDir);
  const sessionStore = new InMemorySessionStore();
  const channel = new RecordingChannel();

  // Create the skill
  await skillService.createSkill({ skillId: "test-skill", name: "Test", description: "Desc", body: "body" });

  // Create one job that uses the skill
  await jobStore.upsertDefinition({
    id: "job-1",
    name: "Job 1",
    enabled: true,
    schedule: { kind: "one_shot", runAt: new Date().toISOString() },
    skillId: "test-skill",
  });

  const taskCoordinator = new TaskCoordinator({
    sessionStore,
    channel,
    onJobTaskBecameInteractive: async () => {},
  });

  const coordinator = new SkillArchiveCoordinator(skillService, jobStore, sessionStore, channel, taskCoordinator);

  const chatId = "test-chat";

  // Delete the job, then offer archive
  await jobStore.deleteDefinition("job-1");
  await coordinator.offerArchiveForJobSkill(chatId, "test-skill");

  // A privilege request should have been sent
  assert.equal(channel.privilegeRequests.length, 1);
  assert.equal(channel.privilegeRequests[0]!.request.kind, "skill_archive");
  assert.equal((channel.privilegeRequests[0]!.request as { skillId: string }).skillId, "test-skill");

  // Session should have a pending archive request
  const session = sessionStore.getOrCreate(chatId);
  assert.notEqual(session.pendingSkillArchiveRequest, null);
  assert.equal(session.pendingSkillArchiveRequest!.skillId, "test-skill");
});

test("SkillArchiveCoordinator approves archive and moves skill", async () => {
  const configDir = makeTempDir();
  const skillService = new SkillService(configDir);
  const jobStore = new JobStore(configDir);
  const sessionStore = new InMemorySessionStore();
  const channel = new RecordingChannel();

  // Create the skill
  await skillService.createSkill({ skillId: "test-skill", name: "Test", description: "Desc", body: "body" });

  const taskCoordinator = new TaskCoordinator({
    sessionStore,
    channel,
    onJobTaskBecameInteractive: async () => {},
  });

  const coordinator = new SkillArchiveCoordinator(skillService, jobStore, sessionStore, channel, taskCoordinator);

  const chatId = "test-chat";

  // Offer archive (skill is orphaned since no jobs reference it)
  await coordinator.offerArchiveForJobSkill(chatId, "test-skill");

  assert.equal(channel.privilegeRequests.length, 1);

  const session = sessionStore.getOrCreate(chatId);
  assert.notEqual(session.pendingSkillArchiveRequest, null);

  // Approve
  await coordinator.resolvePendingRequest(session, "approve");

  // Skill should be archived
  const skills = skillService.getSkills();
  assert.equal(skills.length, 0, "Skill should no longer be in the live skills directory");

  // Confirmation text sent
  const confirmationTexts = channel.sentTexts.filter((t) => t.text.includes("Archived skill"));
  assert.equal(confirmationTexts.length, 1);

  // Pending request should be cleared
  assert.equal(session.pendingSkillArchiveRequest, null);
});

test("SkillArchiveCoordinator denies archive and keeps skill", async () => {
  const configDir = makeTempDir();
  const skillService = new SkillService(configDir);
  const jobStore = new JobStore(configDir);
  const sessionStore = new InMemorySessionStore();
  const channel = new RecordingChannel();

  // Create the skill
  await skillService.createSkill({ skillId: "test-skill", name: "Test", description: "Desc", body: "body" });

  const taskCoordinator = new TaskCoordinator({
    sessionStore,
    channel,
    onJobTaskBecameInteractive: async () => {},
  });

  const coordinator = new SkillArchiveCoordinator(skillService, jobStore, sessionStore, channel, taskCoordinator);

  const chatId = "test-chat";

  // Offer archive
  await coordinator.offerArchiveForJobSkill(chatId, "test-skill");

  const session = sessionStore.getOrCreate(chatId);

  // Deny
  await coordinator.resolvePendingRequest(session, "deny");

  // Skill should still exist
  const skills = skillService.getSkills();
  assert.equal(skills.length, 1);
  assert.equal(skills[0]!.name, "Test");

  // Denial text sent
  const denialTexts = channel.sentTexts.filter((t) => t.text.includes("Kept skill"));
  assert.equal(denialTexts.length, 1);

  // Pending request cleared
  assert.equal(session.pendingSkillArchiveRequest, null);
});

test("SkillArchiveCoordinator does not offer archive when skill directory does not exist", async () => {
  const configDir = makeTempDir();
  const skillService = new SkillService(configDir);
  const jobStore = new JobStore(configDir);
  const sessionStore = new InMemorySessionStore();
  const channel = new RecordingChannel();

  const taskCoordinator = new TaskCoordinator({
    sessionStore,
    channel,
    onJobTaskBecameInteractive: async () => {},
  });

  const coordinator = new SkillArchiveCoordinator(skillService, jobStore, sessionStore, channel, taskCoordinator);

  const chatId = "test-chat";

  // Offer archive for a skill that was never created
  await coordinator.offerArchiveForJobSkill(chatId, "nonexistent-skill");

  // No privilege request sent
  assert.equal(channel.privilegeRequests.length, 0);
});

test("SkillArchiveCoordinator defers archive prompt when visible slot is busy", async () => {
  const configDir = makeTempDir();
  const skillService = new SkillService(configDir);
  const jobStore = new JobStore(configDir);
  const sessionStore = new InMemorySessionStore();
  const channel = new RecordingChannel();

  await skillService.createSkill({ skillId: "test-skill", name: "Test", description: "Desc", body: "body" });

  const taskCoordinator = new TaskCoordinator({
    sessionStore,
    channel,
    onJobTaskBecameInteractive: async () => {},
  });

  const coordinator = new SkillArchiveCoordinator(skillService, jobStore, sessionStore, channel, taskCoordinator);

  const chatId = "test-chat";

  // Simulate a busy slot by setting a pending share deletion
  const session = sessionStore.getOrCreate(chatId);
  session.pendingShareDeletion = {
    requestId: "share-req-1",
    taskId: "task-1",
    taskName: "Some task",
    summary: "summary",
  };

  await coordinator.offerArchiveForJobSkill(chatId, "test-skill");

  // No privilege request sent because slot is busy
  assert.equal(channel.privilegeRequests.length, 0);
  // No pending archive request set directly (it is queued)
  assert.equal(session.pendingSkillArchiveRequest, null);
});
