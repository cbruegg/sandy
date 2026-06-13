import { test } from "bun:test";
import assert from "node:assert/strict";
import { messages } from "../messages.js";
import { InMemorySessionStore } from "../session/in-memory-session-store.js";
import { createActiveTaskState } from "../types.js";
import { RecordingChannel } from "./test-helpers.js";
import { TaskCoordinator } from "./task-coordinator.js";

class FakeTimers {
  public now = 0;
  private nextId = 1;
  private readonly entries = new Map<number, { at: number; callback: () => void }>();

  readonly setTimeoutImpl = ((callback: () => void, delay?: number) => {
    const id = this.nextId += 1;
    this.entries.set(id, { at: this.now + (delay ?? 0), callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  readonly clearTimeoutImpl = ((handle: ReturnType<typeof setTimeout>) => {
    this.entries.delete(handle as unknown as number);
  }) as typeof clearTimeout;

  async advanceBy(ms: number): Promise<void> {
    const target = this.now + ms;
    while (true) {
      const next = Array.from(this.entries.entries())
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next || next[1].at > target) {
        break;
      }
      this.entries.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
      await Promise.resolve();
    }
    this.now = target;
  }
}

function createTask(taskId: string, taskName: string, origin: Parameters<typeof createActiveTaskState>[0]["origin"]) {
  return createActiveTaskState(
    {
      taskId,
      taskName,
      startedAt: new Date(0).toISOString(),
      taskPolicy: { autoApproveMcpServers: [], autoApproveHttpTokens: [] },
      origin,
      interactionState: origin.kind === "launchedByJob" ? "silent" : "interacting",
    },
    { workerConnected: true },
  );
}

test("TaskCoordinator reminds and resets reminder timing on user-task activity", async () => {
  const timers = new FakeTimers();
  const store = new InMemorySessionStore();
  const channel = new RecordingChannel();
  const coordinator = new TaskCoordinator({
    sessionStore: store,
    channel,
    timerControls: {
      now: () => timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
    onJobTaskBecameInteractive: async () => {},
  });

  const session = store.getOrCreate("chat-reminder");
  const userTask = createTask("user-task", "User task", { kind: "launchedByUser" });
  const jobTask = createTask("job-task", "Scheduled job: Daily cleanup", { kind: "launchedByJob", jobId: "daily-cleanup" });
  session.visibleTask = userTask;
  session.backgroundJobTasks.push(jobTask);

  let released = false;
  const blocked = coordinator.runJobUserVisibleOperation("chat-reminder", "job-task", "Daily cleanup", async (_channel) => {
    released = true;
  });
  await Promise.resolve();

  assert.equal(released, false);
  assert.equal(session.backgroundJobTasks[0]?.interactionState, "waitingToInteract");

  await timers.advanceBy(5 * 60 * 1000 - 1);
  assert.equal(channel.sentTexts.length, 0);

  await timers.advanceBy(1);
  assert.equal(channel.sentTexts[0]?.text, messages.scheduledJobBlocked("Daily cleanup", "User task"));

  await timers.advanceBy(10 * 60 * 1000);
  assert.equal(channel.sentTexts[1]?.text, messages.scheduledJobBlocked("Daily cleanup", "User task"));

  channel.recordUserInteraction("chat-reminder", new Date(timers.now).toISOString());
  coordinator.onUserInteraction("chat-reminder");
  await timers.advanceBy(5 * 60 * 1000 - 1);
  assert.equal(channel.sentTexts.length, 2);

  await timers.advanceBy(1);
  assert.equal(channel.sentTexts[2]?.text, messages.scheduledJobBlocked("Daily cleanup", "User task"));

  session.visibleTask = null;
  await coordinator.onVisibleSlotAvailable("chat-reminder");
  await blocked;

  assert.equal(released, true);
  assert.equal(store.getOrCreate("chat-reminder").visibleTask?.taskId, "job-task");
});

test("TaskCoordinator runs deferred interactions for the promoted job in order", async () => {
  const store = new InMemorySessionStore();
  const channel = new RecordingChannel();
  const coordinator = new TaskCoordinator({
    sessionStore: store,
    channel,
    onJobTaskBecameInteractive: async () => {},
  });

  const session = store.getOrCreate("chat-job-queue");
  const userTask = createTask("user-task", "User task", { kind: "launchedByUser" });
  const jobTask = createTask("job-task", "Scheduled job: Daily cleanup", { kind: "launchedByJob", jobId: "daily-cleanup" });
  session.visibleTask = userTask;
  session.backgroundJobTasks.push(jobTask);

  const visibleOperations: string[] = [];
  const firstBlockedOperation = coordinator.runJobUserVisibleOperation("chat-job-queue", "job-task", "Daily cleanup", async (_channel) => {
    visibleOperations.push("first");
  });
  const secondBlockedOperation = coordinator.runJobUserVisibleOperation("chat-job-queue", "job-task", "Daily cleanup", async (_channel) => {
    visibleOperations.push("second");
  });
  await Promise.resolve();

  assert.deepEqual(visibleOperations, []);

  session.visibleTask = null;
  await coordinator.onVisibleSlotAvailable("chat-job-queue");
  await firstBlockedOperation;
  await secondBlockedOperation;

  assert.deepEqual(visibleOperations, ["first", "second"]);
  assert.equal(store.getOrCreate("chat-job-queue").visibleTask?.taskId, "job-task");
});

test("TaskCoordinator notifies exactly once when a job task becomes interactive", async () => {
  const store = new InMemorySessionStore();
  const channel = new RecordingChannel();
  const notifiedTaskIds: string[] = [];
  const coordinator = new TaskCoordinator({
    sessionStore: store,
    channel,
    onJobTaskBecameInteractive: async (taskId) => {
      notifiedTaskIds.push(taskId);
    },
  });

  const session = store.getOrCreate("chat-job-notice");
  const jobTask = createTask("job-task", "Scheduled job: Daily cleanup", { kind: "launchedByJob", jobId: "daily-cleanup" });
  session.backgroundJobTasks.push(jobTask);

  await coordinator.runJobUserVisibleOperation("chat-job-notice", "job-task", "Daily cleanup", async (_channel) => {});
  await coordinator.runJobUserVisibleOperation("chat-job-notice", "job-task", "Daily cleanup", async (_channel) => {});

  assert.deepEqual(notifiedTaskIds, ["job-task"]);
  assert.equal(store.getOrCreate("chat-job-notice").visibleTask?.interactionState, "interacting");
});

test("TaskCoordinator defers share deletion prompt while a user task is active", async () => {
  const timers = new FakeTimers();
  const store = new InMemorySessionStore();
  const channel = new RecordingChannel();
  const coordinator = new TaskCoordinator({
    sessionStore: store,
    channel,
    timerControls: {
      now: () => timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
    onJobTaskBecameInteractive: async () => {},
  });

  const session = store.getOrCreate("chat-defer-share");
  const userTask = createTask("user-task", "User task", { kind: "launchedByUser" });
  session.visibleTask = userTask;

  coordinator.scheduleShareDeletionPrompt("chat-defer-share", {
    requestId: "del-req-1",
    taskId: "job-task",
    taskName: "Scheduled job: Daily cleanup",
    summary: "report.txt",
  });

    const pendingBefore = session.pendingShareDeletion;
    assert.equal(pendingBefore, null);
    assert.equal(channel.shareDeletionRequests.length, 0);

    await timers.advanceBy(5 * 60 * 1000);
    assert.equal(channel.sentTexts[0]?.text, messages.scheduledJobBlocked("Daily cleanup", "User task"));

    session.visibleTask = null;
    await coordinator.onVisibleSlotAvailable("chat-defer-share");

    assert.equal(session.pendingShareDeletion!.requestId, "del-req-1");
    assert.equal(channel.shareDeletionRequests.length, 1);
    assert.equal(channel.shareDeletionRequests[0]?.taskName, "Scheduled job: Daily cleanup");
});

test("TaskCoordinator queues multiple deferred share deletion prompts behind an active user task", async () => {
  const store = new InMemorySessionStore();
  const channel = new RecordingChannel();
  const coordinator = new TaskCoordinator({
    sessionStore: store,
    channel,
    onJobTaskBecameInteractive: async () => {},
  });

  const session = store.getOrCreate("chat-queue-shares");
  const userTask = createTask("user-task", "User task", { kind: "launchedByUser" });
  session.visibleTask = userTask;

  coordinator.scheduleShareDeletionPrompt("chat-queue-shares", {
    requestId: "del-req-1",
    taskId: "job-task-1",
    taskName: "Scheduled job: Daily cleanup",
    summary: "report.txt",
  });
  coordinator.scheduleShareDeletionPrompt("chat-queue-shares", {
    requestId: "del-req-2",
    taskId: "job-task-2",
    taskName: "Scheduled job: Weekly report",
    summary: "data.csv",
  });

  assert.equal(channel.shareDeletionRequests.length, 0);

  session.visibleTask = null;
  await coordinator.onVisibleSlotAvailable("chat-queue-shares");

    assert.equal(session.pendingShareDeletion!.requestId, "del-req-1");
    assert.equal(channel.shareDeletionRequests.length, 1);
    assert.equal(channel.shareDeletionRequests[0]?.taskName, "Scheduled job: Daily cleanup");

    session.pendingShareDeletion = null;
    await coordinator.onVisibleSlotAvailable("chat-queue-shares");

    assert.equal(session.pendingShareDeletion!.requestId, "del-req-2");
    assert.equal(channel.shareDeletionRequests.length, 2);
    assert.equal(channel.shareDeletionRequests[1]?.taskName, "Scheduled job: Weekly report");
});

test("TaskCoordinator does not send blocked-job reminders after stop", async () => {
  const timers = new FakeTimers();
  const store = new InMemorySessionStore();
  const channel = new RecordingChannel();
  const coordinator = new TaskCoordinator({
    sessionStore: store,
    channel,
    timerControls: {
      now: () => timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
    onJobTaskBecameInteractive: async () => {},
  });

  const session = store.getOrCreate("chat-stop");
  const userTask = createTask("user-task", "User task", { kind: "launchedByUser" });
  const jobTask = createTask("job-task", "Scheduled job: Daily cleanup", { kind: "launchedByJob", jobId: "daily-cleanup" });
  session.visibleTask = userTask;
  session.backgroundJobTasks.push(jobTask);

  const blocked = coordinator.runJobUserVisibleOperation("chat-stop", "job-task", "Daily cleanup", async (_channel) => {});
  await Promise.resolve();

  coordinator.stop();

  await timers.advanceBy(5 * 60 * 1000);
  assert.equal(channel.sentTexts.length, 0);

  session.visibleTask = null;
  await coordinator.onVisibleSlotAvailable("chat-stop");
  await blocked;
});
