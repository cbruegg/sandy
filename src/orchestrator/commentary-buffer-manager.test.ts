import { test } from "bun:test";
import assert from "node:assert/strict";
import { InMemorySessionStore } from "../session/in-memory-session-store.js";
import { ActiveTaskState } from "../types.js";
import type { TaskOrigin } from "../types.js";
import { RecordingChannel } from "./test-helpers.js";
import { CommentaryBufferManager } from "./commentary-buffer-manager.js";
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

function createTask(taskId: string, taskName: string, origin: TaskOrigin) {
  return new ActiveTaskState({
    taskId,
    taskName,
    startedAt: new Date(0).toISOString(),
    taskPolicy: { autoApproveMcpServers: [], autoApproveHttpTokens: [] },
    origin,
    interactionState: origin.kind === "launchedByJob" ? "silent" : "interacting",
    workerConnected: true,
  });
}

test("commentary timer reset only affects tasks in the same chat", async () => {
  const timers = new FakeTimers();
  const flushes: Array<{ taskId: string; chatId: string; text: string }> = [];
  const commentaryBuffer = new CommentaryBufferManager(
    async (taskId, chatId, text) => {
      flushes.push({ taskId, chatId, text });
    },
    {
      now: () => timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
  );

  commentaryBuffer.bufferCommentary("task-a", "chat-a", "Commentary A");
  commentaryBuffer.bufferCommentary("task-b", "chat-b", "Commentary B");

  await timers.advanceBy(30_000);
  commentaryBuffer.onUserInteraction("chat-b");

  await timers.advanceBy(30_000);
  assert.deepEqual(flushes, [{ taskId: "task-a", chatId: "chat-a", text: "Commentary A" }]);

  await timers.advanceBy(30_000);
  assert.deepEqual(flushes, [
    { taskId: "task-a", chatId: "chat-a", text: "Commentary A" },
    { taskId: "task-b", chatId: "chat-b", text: "Commentary B" },
  ]);
});

test("commentary timeout flush waits for the visible slot", async () => {
  const timers = new FakeTimers();
  const store = new InMemorySessionStore();
  const channel = new RecordingChannel();
  const coordinator = new TaskCoordinator({
    sessionStore: store,
    channel,
    onJobTaskBecameInteractive: async () => {},
  });
  const commentaryBuffer = new CommentaryBufferManager(
    async (taskId, chatId, text) => {
      const task = store.getOrCreate(chatId).findTask(taskId)?.task;
      if (!task) {
        return;
      }
      await coordinator.runJobUserVisibleOperation(chatId, taskId, task.taskName, async (taskChannel) => {
        await taskChannel.sendTaskUpdate(chatId, text);
      });
    },
    {
      now: () => timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
  );

  const session = store.getOrCreate("chat-slot");
  session.visibleTask = createTask("user-task", "User task", { kind: "launchedByUser" });
  session.backgroundJobTasks.push(
    createTask("job-task", "Scheduled job: Daily cleanup", {
      kind: "launchedByJob",
      jobId: "daily-cleanup",
      jobName: "Daily cleanup",
    }),
  );

  commentaryBuffer.bufferCommentary("job-task", "chat-slot", "Buffered commentary");

  await timers.advanceBy(60_001);
  assert.equal(channel.taskUpdates.length, 0);

  session.visibleTask = null;
  await coordinator.onVisibleSlotAvailable("chat-slot");

  assert.equal(channel.taskUpdates.length, 2);
  assert.equal(channel.taskUpdates[0]?.text, 'Scheduled job "Daily cleanup" is now interactive. The next update or request comes from this task.');
  assert.equal(channel.taskUpdates[1]?.text, "Buffered commentary");
});
