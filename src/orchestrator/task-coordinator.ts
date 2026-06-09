import { logger } from "../logger.js";
import { messages } from "../messages.js";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import type { SessionStore } from "../session/in-memory-session-store.js";
import type { ActiveTaskState, SessionState } from "../types.js";
import { findSessionTask, promoteBackgroundJobTask } from "./session-task-state.js";

type WaitingInteraction = {
  taskId: string;
  jobName: string;
  run: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type PendingShareDeletionPrompt = {
  requestId: string;
  taskId: string;
  taskName: string;
  summary: string;
};

type ReminderRuntime = {
  timeout: ReturnType<typeof setTimeout> | null;
  nextDelayMs: number;
};

type TimerControls = {
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

const initialReminderDelayMs = 5 * 60 * 1000;
const maximumReminderDelayMs = 60 * 60 * 1000;

export class TaskCoordinator {
  private readonly waitingInteractions = new Map<string, WaitingInteraction[]>();
  private readonly pendingShareDeletionPrompts = new Map<string, PendingShareDeletionPrompt[]>();
  private readonly reminderRuntimes = new Map<string, ReminderRuntime>();
  private readonly now: () => number;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly channel: ChannelAdapter,
    timerControls?: TimerControls,
  ) {
    this.now = timerControls?.now ?? (() => Date.now());
    this.setTimeoutImpl = timerControls?.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = timerControls?.clearTimeoutImpl ?? clearTimeout;
  }

  addBackgroundJobTask(session: SessionState, task: ActiveTaskState): void {
    session.backgroundJobTasks.push(task);
    this.updateReminderState(session);
  }

  findTask(session: SessionState, taskId: string): ActiveTaskState | null {
    return findSessionTask(session, taskId)?.task ?? null;
  }

  findSessionByTaskId(taskId: string): SessionState | undefined {
    return this.sessionStore.getByTaskId(taskId);
  }

  recordTaskActivity(session: SessionState, taskId: string): void {
    const task = this.findTask(session, taskId);
    if (!task) {
      return;
    }

    task.lastActivityAt = new Date(this.now()).toISOString();
    if (session.activeTask?.taskId === taskId && session.activeTask.origin?.kind === "launchedByUser") {
      this.resetReminderBackoff(session);
    }
  }

  scheduleShareDeletionPrompt(chatId: string, prompt: PendingShareDeletionPrompt): void {
    const queue = this.pendingShareDeletionPrompts.get(chatId) ?? [];
    queue.push(prompt);
    this.pendingShareDeletionPrompts.set(chatId, queue);
    const session = this.sessionStore.getOrCreate(chatId);
    this.updateReminderState(session);
  }

  async runJobUserVisibleOperation(
    chatId: string,
    taskId: string,
    jobName: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const session = this.sessionStore.getOrCreate(chatId);
    const taskRecord = findSessionTask(session, taskId);
    if (!taskRecord) {
      throw new Error(`Task ${taskId} is no longer active.`);
    }

    const task = taskRecord.task;
    if (task.origin?.kind !== "launchedByJob") {
      await operation();
      return;
    }

    if (session.activeTask?.taskId === taskId) {
      task.interactionState = "interacting";
      await operation();
      return;
    }

    if (!session.activeTask && !session.pendingShareDeletion) {
      const promotedTask = promoteBackgroundJobTask(session, taskId);
      promotedTask.interactionState = "interacting";
      promotedTask.lastActivityAt = new Date(this.now()).toISOString();
      this.updateReminderState(session);
      await operation();
      await this.flushWaitingInteractionsForActiveTask(session, taskId);
      return;
    }

    task.interactionState = "waitingToInteract";
    await new Promise<void>((resolve, reject) => {
      const queue = this.waitingInteractions.get(chatId) ?? [];
      queue.push({ taskId, jobName, run: operation, resolve, reject });
      this.waitingInteractions.set(chatId, queue);
      this.updateReminderState(session);
    });
  }

  async onTaskVisibilityChanged(chatId: string): Promise<void> {
    const session = this.sessionStore.getOrCreate(chatId);
    await this.flushNextWaitingInteraction(session);
  }

  removeTask(chatId: string, taskId: string): void {
    const queue = this.waitingInteractions.get(chatId);
    if (queue) {
      const remaining: WaitingInteraction[] = [];
      for (const entry of queue) {
        if (entry.taskId === taskId) {
          entry.reject(new Error(`Task ${taskId} ended while waiting to interact.`));
          continue;
        }
        remaining.push(entry);
      }
      if (remaining.length === 0) {
        this.waitingInteractions.delete(chatId);
      } else {
        this.waitingInteractions.set(chatId, remaining);
      }
    }

    this.updateReminderState(this.sessionStore.getOrCreate(chatId));
  }

  private async flushNextWaitingInteraction(session: SessionState): Promise<void> {
    if (session.activeTask || session.pendingShareDeletion) {
      this.updateReminderState(session);
      return;
    }

    const shareDeletionQueue = this.pendingShareDeletionPrompts.get(session.chatId);
    if (shareDeletionQueue && shareDeletionQueue.length > 0) {
      const next = shareDeletionQueue.shift();
      if (next) {
        if (shareDeletionQueue.length === 0) {
          this.pendingShareDeletionPrompts.delete(session.chatId);
        }
        session.pendingShareDeletion = {
          requestId: next.requestId,
          taskId: next.taskId,
          taskName: next.taskName,
          summary: next.summary,
        };
        await this.channel.sendShareDeletionRequest(session.chatId, next.requestId, next.taskName, next.summary);
        this.updateReminderState(session);
        return;
      }
    }

    const queue = this.waitingInteractions.get(session.chatId);
    if (!queue || queue.length === 0) {
      this.updateReminderState(session);
      return;
    }

    while (queue.length > 0) {
      const next = queue[0];
      if (!next) {
        break;
      }

      const taskRecord = next ? findSessionTask(session, next.taskId) : null;
      if (!taskRecord) {
        queue.shift();
        next.reject(new Error(`Task ${next.taskId} is no longer active.`));
        continue;
      }

      const task = taskRecord.location === "background"
        ? promoteBackgroundJobTask(session, next.taskId)
        : taskRecord.task;
      task.interactionState = "interacting";
      task.lastActivityAt = new Date(this.now()).toISOString();
      queue.shift();
      if (queue.length === 0) {
        this.waitingInteractions.delete(session.chatId);
      }
      this.updateReminderState(session);

      try {
        await next.run();
        next.resolve();
        await this.flushWaitingInteractionsForActiveTask(session, next.taskId);
      } catch (error) {
        next.reject(error);
      }
      return;
    }

    if (queue.length === 0) {
      this.waitingInteractions.delete(session.chatId);
    }
    this.updateReminderState(session);
  }

  private async flushWaitingInteractionsForActiveTask(session: SessionState, taskId: string): Promise<void> {
    const queue = this.waitingInteractions.get(session.chatId);
    if (!queue || queue.length === 0) {
      return;
    }

    while (queue[0]?.taskId === taskId && session.activeTask?.taskId === taskId) {
      const next = queue.shift();
      if (!next) {
        break;
      }
      try {
        await next.run();
        next.resolve();
      } catch (error) {
        next.reject(error);
        throw error;
      }
    }

    if (queue.length === 0) {
      this.waitingInteractions.delete(session.chatId);
    }
  }

  private resetReminderBackoff(session: SessionState): void {
    const runtime = this.getReminderRuntime(session.chatId);
    runtime.nextDelayMs = initialReminderDelayMs;
    this.scheduleReminder(session, runtime, initialReminderDelayMs);
  }

  private updateReminderState(session: SessionState): void {
    const blocker = session.activeTask;
    const queue = this.waitingInteractions.get(session.chatId) ?? [];
    const shareDeletionQueue = this.pendingShareDeletionPrompts.get(session.chatId) ?? [];
    if ((queue.length === 0 && shareDeletionQueue.length === 0) || blocker?.origin?.kind !== "launchedByUser") {
      this.clearReminder(session.chatId);
      return;
    }

    const runtime = this.getReminderRuntime(session.chatId);
    this.scheduleReminder(session, runtime, runtime.nextDelayMs);
  }

  private scheduleReminder(session: SessionState, runtime: ReminderRuntime, delayMs: number): void {
    if (runtime.timeout) {
      this.clearTimeoutImpl(runtime.timeout);
    }

    const blocker = session.activeTask;
    if (!blocker || blocker.origin?.kind !== "launchedByUser") {
      runtime.timeout = null;
      return;
    }

    const elapsedMs = Math.max(0, this.now() - Date.parse(blocker.lastActivityAt));
    const timeoutDelayMs = Math.max(0, delayMs - elapsedMs);
    runtime.timeout = this.setTimeoutImpl(() => {
      void this.sendReminder(session.chatId);
    }, timeoutDelayMs);
  }

  private async sendReminder(chatId: string): Promise<void> {
    const session = this.sessionStore.getOrCreate(chatId);
    const blocker = session.activeTask;
    const queue = this.waitingInteractions.get(chatId) ?? [];
    const shareDeletionQueue = this.pendingShareDeletionPrompts.get(chatId) ?? [];
    if ((queue.length === 0 && shareDeletionQueue.length === 0) || !blocker || blocker.origin?.kind !== "launchedByUser") {
      this.clearReminder(chatId);
      return;
    }

    const nextWaiting = queue[0];
    const nextShareDeletion = shareDeletionQueue[0];
    if (!nextWaiting && !nextShareDeletion) {
      this.clearReminder(chatId);
      return;
    }

    const waitingName = nextWaiting
      ? normalizeJobName(nextWaiting.jobName)
      : normalizeJobName(nextShareDeletion!.taskName);

    logger.info("task.waiting_job_reminder", {
      chatId,
      blockerTaskId: blocker.taskId,
      blockerTaskName: blocker.taskName,
      waitingTaskName: waitingName,
    });
    await this.channel.sendText(chatId, messages.scheduledJobBlocked(waitingName, blocker.taskName));

    const runtime = this.getReminderRuntime(chatId);
    runtime.nextDelayMs = Math.min(runtime.nextDelayMs * 2, maximumReminderDelayMs);
    this.scheduleReminder(session, runtime, runtime.nextDelayMs);
  }

  private getReminderRuntime(chatId: string): ReminderRuntime {
    const existing = this.reminderRuntimes.get(chatId);
    if (existing) {
      return existing;
    }

    const runtime: ReminderRuntime = {
      timeout: null,
      nextDelayMs: initialReminderDelayMs,
    };
    this.reminderRuntimes.set(chatId, runtime);
    return runtime;
  }

  private clearReminder(chatId: string): void {
    const runtime = this.reminderRuntimes.get(chatId);
    if (!runtime) {
      return;
    }
    if (runtime.timeout) {
      this.clearTimeoutImpl(runtime.timeout);
    }
    runtime.timeout = null;
    runtime.nextDelayMs = initialReminderDelayMs;
  }
}

function normalizeJobName(jobName: string): string {
  return jobName.startsWith("Scheduled job: ") ? jobName.slice("Scheduled job: ".length) : jobName;
}
