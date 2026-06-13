import { logger } from "../logger.js";
import { messages } from "../messages.js";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import type { ChatId } from "../types.js";

export type TimerControls = {
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

export type BlockedJobReminderContext = {
  chatId: ChatId;
  blockerTaskId: string;
  blockerTaskName: string;
  blockerStartedAt: string;
  waitingTaskName: string;
};

type ScheduledReminder = {
  timeout: ReturnType<typeof setTimeout>;
  nextDelayMs: number;
};

const initialReminderDelayMs = 5 * 60 * 1000;
const maximumReminderDelayMs = 60 * 60 * 1000;

export class BlockedJobReminderScheduler {
  private readonly scheduledReminders = new Map<ChatId, ScheduledReminder>();
  private readonly now: () => number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private stopped = false;

  constructor(
    private readonly channel: ChannelAdapter,
    private readonly getContext: (chatId: ChatId) => BlockedJobReminderContext | null,
    timerControls?: TimerControls,
  ) {
    this.now = timerControls?.now ?? (() => Date.now());
    this.setTimeoutImpl = timerControls?.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = timerControls?.clearTimeoutImpl ?? clearTimeout;
  }

  sync(chatId: ChatId): void {
    if (this.stopped) {
      return;
    }
    const nextDelayMs = this.scheduledReminders.get(chatId)?.nextDelayMs ?? initialReminderDelayMs;
    this.scheduleOrClear(chatId, nextDelayMs);
  }

  resetAfterUserInteraction(chatId: ChatId): void {
    if (this.stopped) {
      return;
    }
    this.scheduleOrClear(chatId, initialReminderDelayMs);
  }

  stop(): void {
    this.stopped = true;
    for (const scheduled of this.scheduledReminders.values()) {
      this.clearTimeoutImpl(scheduled.timeout);
    }
    this.scheduledReminders.clear();
  }

  private scheduleOrClear(chatId: ChatId, nextDelayMs: number): void {
    this.clearExistingTimeout(chatId);

    const context = this.getContext(chatId);
    if (!context) {
      return;
    }

    const baselineTimestamp = this.channel.getLastUserInteractionTimestamp(chatId) ?? context.blockerStartedAt;
    const elapsedMs = Math.max(0, this.now() - Date.parse(baselineTimestamp));
    const timeoutDelayMs = Math.max(0, nextDelayMs - elapsedMs);
    const timeout = this.setTimeoutImpl(() => {
      void this.sendReminder(chatId);
    }, timeoutDelayMs);
    this.scheduledReminders.set(chatId, { timeout, nextDelayMs });
  }

  private clearExistingTimeout(chatId: ChatId): void {
    const scheduled = this.scheduledReminders.get(chatId);
    if (!scheduled) {
      return;
    }

    this.clearTimeoutImpl(scheduled.timeout);
    this.scheduledReminders.delete(chatId);
  }

  private async sendReminder(chatId: ChatId): Promise<void> {
    const context = this.getContext(chatId);
    if (!context) {
      this.clearExistingTimeout(chatId);
      return;
    }

    logger.info("task.waiting_job_reminder", {
      chatId,
      blockerTaskId: context.blockerTaskId,
      blockerTaskName: context.blockerTaskName,
      waitingTaskName: context.waitingTaskName,
    });
    await this.channel.sendText(chatId, messages.scheduledJobBlocked(context.waitingTaskName, context.blockerTaskName));

    if (this.stopped) {
      return;
    }

    const nextDelayMs = Math.min(
      (this.scheduledReminders.get(chatId)?.nextDelayMs ?? initialReminderDelayMs) * 2,
      maximumReminderDelayMs,
    );
    this.clearExistingTimeout(chatId);
    const timeout = this.setTimeoutImpl(() => {
      void this.sendReminder(chatId);
    }, nextDelayMs);
    this.scheduledReminders.set(chatId, { timeout, nextDelayMs });
  }
}
