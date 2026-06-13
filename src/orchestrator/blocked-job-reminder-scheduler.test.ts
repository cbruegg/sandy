import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ChatId } from "../types.js";
import { messages } from "../messages.js";
import { BlockedJobReminderScheduler, type BlockedJobReminderContext } from "./blocked-job-reminder-scheduler.js";
import { RecordingChannel } from "./test-helpers.js";

class PausingChannel extends RecordingChannel {
  private sendTextResolve: (() => void) | null = null;
  private sendTextPromise: Promise<void> | null = null;

  pauseSendText(): void {
    this.sendTextPromise = new Promise((resolve) => {
      this.sendTextResolve = resolve;
    });
  }

  resumeSendText(): void {
    this.sendTextResolve?.();
    this.sendTextResolve = null;
    this.sendTextPromise = null;
  }

  override sendText(chatId: ChatId, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
    return this.sendTextPromise ?? Promise.resolve();
  }
}

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

function makeContext(): BlockedJobReminderContext {
  return {
    chatId: "chat-reminder",
    blockerTaskId: "blocker-task",
    blockerTaskName: "Blocker task",
    blockerStartedAt: new Date(0).toISOString(),
    waitingJobName: "Daily cleanup",
  };
}

test("BlockedJobReminderScheduler sends reminders on schedule", async () => {
  const timers = new FakeTimers();
  const channel = new RecordingChannel();
  const scheduler = new BlockedJobReminderScheduler(
    channel,
    () => makeContext(),
    {
      now: () => timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
  );

  scheduler.sync("chat-reminder");

  await timers.advanceBy(5 * 60 * 1000 - 1);
  assert.equal(channel.sentTexts.length, 0);

  await timers.advanceBy(1);
  assert.equal(channel.sentTexts[0]?.text, messages.scheduledJobBlocked("Daily cleanup", "Blocker task"));

  await timers.advanceBy(10 * 60 * 1000);
  assert.equal(channel.sentTexts[1]?.text, messages.scheduledJobBlocked("Daily cleanup", "Blocker task"));
});

test("BlockedJobReminderScheduler.stop clears all scheduled reminders", async () => {
  const timers = new FakeTimers();
  const channel = new RecordingChannel();
  const scheduler = new BlockedJobReminderScheduler(
    channel,
    () => makeContext(),
    {
      now: () => timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
  );

  scheduler.sync("chat-reminder");
  await timers.advanceBy(5 * 60 * 1000);
  assert.equal(channel.sentTexts.length, 1);

  scheduler.sync("chat-reminder");
  scheduler.stop();

  await timers.advanceBy(60 * 60 * 1000);
  assert.equal(channel.sentTexts.length, 1);
});

test("BlockedJobReminderScheduler.stop prevents rescheduling while a reminder is in flight", async () => {
  const timers = new FakeTimers();
  const channel = new PausingChannel();
  const scheduler = new BlockedJobReminderScheduler(
    channel,
    () => makeContext(),
    {
      now: () => timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
  );

  channel.pauseSendText();
  scheduler.sync("chat-reminder");
  await timers.advanceBy(5 * 60 * 1000);
  assert.equal(channel.sentTexts.length, 1);

  scheduler.stop();
  channel.resumeSendText();
  await Promise.resolve();

  await timers.advanceBy(60 * 60 * 1000);
  assert.equal(channel.sentTexts.length, 1);
});
