import type { ChannelAdapter } from "../channel/channel-adapter.js";
import type { SessionStore } from "../session/in-memory-session-store.js";
import type { ActiveTaskState, SessionState } from "../types.js";
import { BlockedJobReminderScheduler } from "./blocked-job-reminder-scheduler.js";
import type { BlockedJobReminderContext, TimerControls } from "./blocked-job-reminder-scheduler.js";

type WaitingJobInteraction = {
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

export class TaskCoordinator {
  private readonly waitingJobInteractions = new Map<string, WaitingJobInteraction[]>();
  private readonly pendingShareDeletionPrompts = new Map<string, PendingShareDeletionPrompt[]>();
  private readonly reminders: BlockedJobReminderScheduler;

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly channel: ChannelAdapter,
    timerControls?: TimerControls,
  ) {
    this.reminders = new BlockedJobReminderScheduler(
      channel,
      (chatId) => this.getBlockedJobReminderContext(chatId),
      timerControls,
    );
  }

  addBackgroundJobTask(session: SessionState, task: ActiveTaskState): void {
    session.backgroundJobTasks.push(task);
    this.reminders.sync(session.chatId);
  }

  findTask(session: SessionState, taskId: string): ActiveTaskState | null {
    return session.findTask(taskId)?.task ?? null;
  }

  findSessionByTaskId(taskId: string): SessionState | undefined {
    return this.sessionStore.getByTaskId(taskId);
  }

  onUserInteraction(chatId: string): void {
    this.reminders.resetAfterUserInteraction(chatId);
  }

  scheduleShareDeletionPrompt(chatId: string, prompt: PendingShareDeletionPrompt): void {
    const queue = this.pendingShareDeletionPrompts.get(chatId) ?? [];
    queue.push(prompt);
    this.pendingShareDeletionPrompts.set(chatId, queue);
    this.reminders.sync(chatId);
  }

  async runJobUserVisibleOperation(
    chatId: string,
    taskId: string,
    jobName: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const session = this.sessionStore.getOrCreate(chatId);
    const taskRecord = session.findTask(taskId);
    if (!taskRecord) {
      throw new Error(`Task ${taskId} is no longer active.`);
    }

    const task = taskRecord.task;
    if (task.origin.kind === "launchedByUser") {
      // User-launched tasks are already the visible task for their chat, so they never wait here.
      await operation();
      return;
    }

    if (session.activeTask?.taskId === taskId) {
      task.interactionState = "interacting";
      await operation();
      return;
    }

    if (this.isVisibleSlotAvailable(session)) {
      const promotedTask = session.promoteBackgroundJobTask(taskId);
      promotedTask.interactionState = "interacting";
      this.reminders.sync(chatId);
      await operation();
      await this.runQueuedOperationsForVisibleJob(session, taskId);
      return;
    }

    task.interactionState = "waitingToInteract";
    await new Promise<void>((resolve, reject) => {
      const queue = this.waitingJobInteractions.get(chatId) ?? [];
      queue.push({ taskId, jobName, run: operation, resolve, reject });
      this.waitingJobInteractions.set(chatId, queue);
      this.reminders.sync(chatId);
    });
  }

  /**
   * A chat can show one user-visible blocker at a time: an active task or a share-deletion prompt.
   * When that slot becomes free, start the next deferred job prompt/interaction that needs the user.
   */
  async onVisibleSlotAvailable(chatId: string): Promise<void> {
    const session = this.sessionStore.getOrCreate(chatId);
    if (!this.isVisibleSlotAvailable(session)) {
      this.reminders.sync(chatId);
      return;
    }

    if (await this.showNextDeferredShareDeletionPrompt(session)) {
      return;
    }

    await this.startNextDeferredJobInteraction(session);
  }

  removeTask(chatId: string, taskId: string): void {
    this.rejectWaitingInteractionsForTask(chatId, taskId);
    this.reminders.sync(chatId);
  }

  private isVisibleSlotAvailable(session: SessionState): boolean {
    return !session.activeTask && !session.pendingShareDeletion;
  }

  private async showNextDeferredShareDeletionPrompt(session: SessionState): Promise<boolean> {
    const next = this.shiftNextShareDeletionPrompt(session.chatId);
    if (!next) {
      return false;
    }

    session.pendingShareDeletion = {
      requestId: next.requestId,
      taskId: next.taskId,
      taskName: next.taskName,
      summary: next.summary,
    };
    await this.channel.sendShareDeletionRequest(session.chatId, next.requestId, next.taskName, next.summary);
    this.reminders.sync(session.chatId);
    return true;
  }

  private async startNextDeferredJobInteraction(session: SessionState): Promise<void> {
    while (this.isVisibleSlotAvailable(session)) {
      const next = this.shiftNextWaitingInteraction(session.chatId);
      if (!next) {
        this.reminders.sync(session.chatId);
        return;
      }

      const taskRecord = session.findTask(next.taskId);
      if (!taskRecord) {
        next.reject(new Error(`Task ${next.taskId} is no longer active.`));
        continue;
      }

      const task = taskRecord.location === "background"
        ? session.promoteBackgroundJobTask(next.taskId)
        : taskRecord.task;
      task.interactionState = "interacting";
      this.reminders.sync(session.chatId);

      if (await this.runDeferredJobInteraction(next)) {
        await this.runQueuedOperationsForVisibleJob(session, next.taskId);
      }
      return;
    }

    this.reminders.sync(session.chatId);
  }

  private async runQueuedOperationsForVisibleJob(session: SessionState, taskId: string): Promise<void> {
    while (session.activeTask?.taskId === taskId) {
      const next = this.waitingJobInteractions.get(session.chatId)?.[0];
      if (next?.taskId !== taskId) {
        break;
      }

      const deferredInteraction = this.shiftNextWaitingInteraction(session.chatId);
      if (!deferredInteraction) {
        break;
      }

      if (!await this.runDeferredJobInteraction(deferredInteraction)) {
        break;
      }
    }

    this.reminders.sync(session.chatId);
  }

  private async runDeferredJobInteraction(interaction: WaitingJobInteraction): Promise<boolean> {
    try {
      await interaction.run();
      interaction.resolve();
      return true;
    } catch (error) {
      interaction.reject(error);
      return false;
    }
  }

  private shiftNextWaitingInteraction(chatId: string): WaitingJobInteraction | null {
    const queue = this.waitingJobInteractions.get(chatId);
    const next = queue?.shift() ?? null;
    if (queue && queue.length === 0) {
      this.waitingJobInteractions.delete(chatId);
    }
    return next;
  }

  private shiftNextShareDeletionPrompt(chatId: string): PendingShareDeletionPrompt | null {
    const queue = this.pendingShareDeletionPrompts.get(chatId);
    const next = queue?.shift() ?? null;
    if (queue && queue.length === 0) {
      this.pendingShareDeletionPrompts.delete(chatId);
    }
    return next;
  }

  private rejectWaitingInteractionsForTask(chatId: string, taskId: string): void {
    const queue = this.waitingJobInteractions.get(chatId);
    if (!queue) {
      return;
    }

    const remaining: WaitingJobInteraction[] = [];
    for (const entry of queue) {
      if (entry.taskId === taskId) {
        entry.reject(new Error(`Task ${taskId} ended while waiting to interact.`));
      } else {
        remaining.push(entry);
      }
    }

    if (remaining.length === 0) {
      this.waitingJobInteractions.delete(chatId);
    } else {
      this.waitingJobInteractions.set(chatId, remaining);
    }
  }

  private getBlockedJobReminderContext(chatId: string): BlockedJobReminderContext | null {
    const session = this.sessionStore.getOrCreate(chatId);
    const blocker = session.activeTask;
    if (!blocker || blocker.origin.kind !== "launchedByUser") {
      return null;
    }

    const waitingTaskName = this.waitingJobInteractions.get(chatId)?.[0]?.jobName
      ?? this.pendingShareDeletionPrompts.get(chatId)?.[0]?.taskName;
    if (!waitingTaskName) {
      return null;
    }

    return {
      chatId,
      blockerTaskId: blocker.taskId,
      blockerTaskName: blocker.taskName,
      blockerStartedAt: blocker.startedAt,
      waitingTaskName: normalizeJobName(waitingTaskName),
    };
  }
}

function normalizeJobName(jobName: string): string {
  return jobName.startsWith("Scheduled job: ") ? jobName.slice("Scheduled job: ".length) : jobName;
}
