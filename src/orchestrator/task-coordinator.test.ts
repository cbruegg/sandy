import { test } from "bun:test";
import assert from "node:assert/strict";
import { messages } from "../messages.js";
import { InMemorySessionStore } from "../session/in-memory-session-store.js";
import type { ActiveTaskState } from "../types.js";
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

function createTask(taskId: string, taskName: string, origin: ActiveTaskState["origin"]): ActiveTaskState {
  return {
    taskId,
    taskName,
    status: "running",
    startedAt: new Date(0).toISOString(),
    lastActivityAt: new Date(0).toISOString(),
    pendingPrivilegeRequest: null,
    taskPolicy: { autoApproveMcpServers: [], autoApproveHttpTokens: [] },
    approvedMcpTools: [],
    approvedMcpResourceReads: [],
    approvedHttpTokenSessionGrants: [],
    approvedHttpTokenOnceGrants: [],
    approvedHostDirectories: [],
    workerConnected: true,
    taskSummary: null,
    origin,
    interactionState: origin?.kind === "launchedByJob" ? "silent" : "interacting",
  };
}

test("TaskCoordinator reminds and resets reminder timing on user-task activity", async () => {
  const timers = new FakeTimers();
  const store = new InMemorySessionStore();
  const channel = new RecordingChannel();
  const coordinator = new TaskCoordinator(store, channel, {
    now: () => timers.now,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  const session = store.getOrCreate("chat-reminder");
  const userTask = createTask("user-task", "User task", { kind: "launchedByUser" });
  const jobTask = createTask("job-task", "Scheduled job: Daily cleanup", { kind: "launchedByJob", jobId: "daily-cleanup" });
  session.activeTask = userTask;
  session.backgroundJobTasks.push(jobTask);

  let released = false;
  const blocked = coordinator.runJobUserVisibleOperation("chat-reminder", "job-task", "Daily cleanup", async () => {
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

  coordinator.recordTaskActivity(session, "user-task");
  await timers.advanceBy(5 * 60 * 1000 - 1);
  assert.equal(channel.sentTexts.length, 2);

  await timers.advanceBy(1);
  assert.equal(channel.sentTexts[2]?.text, messages.scheduledJobBlocked("Daily cleanup", "User task"));

  session.activeTask = null;
  await coordinator.onTaskVisibilityChanged("chat-reminder");
  await blocked;

  assert.equal(released, true);
  assert.equal(store.getOrCreate("chat-reminder").activeTask?.taskId, "job-task");
});
