import type { ChannelAdapter } from "../channel/channel-adapter.js";
import { messages } from "../messages.js";
import type { SessionStore } from "../session/in-memory-session-store.js";
import type { ActiveTaskState, SessionState } from "../types.js";
import type { ChatId } from "../types.js";
import { BlockedJobReminderScheduler } from "./blocked-job-reminder-scheduler.js";
import type { BlockedJobReminderContext, TimerControls } from "./blocked-job-reminder-scheduler.js";

type WaitingJobInteraction = {
  taskId: string;
  jobName: string;
  includesTaskContext: boolean;
  run: (channel: ChannelAdapter) => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type PendingShareDeletionPrompt = {
  requestId: string;
  taskId: string;
  taskName: string;
  summary: string;
};

type TaskCoordinatorDependencies = {
  readonly sessionStore: SessionStore;
  readonly channel: ChannelAdapter;
  readonly timerControls?: TimerControls;
  readonly onJobTaskBecameInteractive: (taskId: string) => Promise<void>;
};

/**
 * A FIFO queue of `T` kept independently per chat. Empty chat keys are removed
 * automatically so callers never observe lingering empty arrays.
 */
class PerChatQueue<T> {
  private readonly byChat = new Map<ChatId, T[]>();

  enqueue(chatId: ChatId, entry: T): void {
    const queue = this.byChat.get(chatId) ?? [];
    queue.push(entry);
    this.byChat.set(chatId, queue);
  }

  peek(chatId: ChatId): T | undefined {
    return this.byChat.get(chatId)?.[0];
  }

  shift(chatId: ChatId): T | null {
    const queue = this.byChat.get(chatId);
    const next = queue?.shift() ?? null;
    if (queue && queue.length === 0) {
      this.byChat.delete(chatId);
    }
    return next;
  }

  /** Drops every entry matching `predicate`, invoking `onRemoved` for each. */
  removeWhere(chatId: ChatId, predicate: (entry: T) => boolean, onRemoved: (entry: T) => void): void {
    const queue = this.byChat.get(chatId);
    if (!queue) {
      return;
    }

    const remaining: T[] = [];
    for (const entry of queue) {
      if (predicate(entry)) {
        onRemoved(entry);
      } else {
        remaining.push(entry);
      }
    }

    if (remaining.length === 0) {
      this.byChat.delete(chatId);
    } else {
      this.byChat.set(chatId, remaining);
    }
  }
}

/**
 * Coordinates the single user-visible slot each chat exposes.
 *
 * At any moment a chat can present exactly one user-facing blocker: either an
 * visible task (`session.visibleTask`) or a share-deletion prompt
 * (`session.pendingShareDeletion`). User-launched tasks own that slot directly.
 * Job-launched tasks run silently in the background and must acquire the slot
 * before they can talk to the user.
 *
 * Two per-chat FIFO queues hold work that is waiting for the slot:
 * - `waitingJobInteractions`: job operations that need the user.
 * - `pendingShareDeletionPrompts`: share-deletion prompts to show.
 *
 * When the slot frees (`onVisibleSlotAvailable`), pending share-deletion
 * prompts take priority over waiting job interactions.
 */
export class TaskCoordinator {
  private readonly waitingJobInteractions = new PerChatQueue<WaitingJobInteraction>();
  private readonly pendingShareDeletionPrompts = new PerChatQueue<PendingShareDeletionPrompt>();
  private readonly reminders: BlockedJobReminderScheduler;

  constructor(private readonly deps: TaskCoordinatorDependencies) {
    this.reminders = new BlockedJobReminderScheduler(
      deps.channel,
      (chatId) => this.getBlockedJobReminderContext(chatId),
      deps.timerControls,
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  stop(): void {
    this.reminders.stop();
  }

  addBackgroundJobTask(session: SessionState, task: ActiveTaskState): void {
    session.backgroundJobTasks.push(task);
    this.reminders.sync(session.chatId);
  }

  findTask(session: SessionState, taskId: string): ActiveTaskState | null {
    return session.findTask(taskId)?.task ?? null;
  }
  onUserInteraction(chatId: ChatId): void {
    this.reminders.resetAfterUserInteraction(chatId);
  }

  scheduleShareDeletionPrompt(chatId: ChatId, prompt: PendingShareDeletionPrompt): void {
    this.pendingShareDeletionPrompts.enqueue(chatId, prompt);
    this.reminders.sync(chatId);
  }

  /**
   * Runs a user-visible operation on behalf of `taskId`. User-launched tasks
   * and the task that already holds the slot run immediately. A background job
   * task claims the slot when it is free; otherwise the operation is queued and
   * this promise settles once it eventually runs.
   */
  async runJobUserVisibleOperation(
    chatId: ChatId,
    taskId: string,
    jobName: string,
    includesTaskContext: boolean,
    operation: (channel: ChannelAdapter) => Promise<void>,
  ): Promise<void> {
    const session = this.deps.sessionStore.getOrCreate(chatId);
    const taskRecord = session.findTask(taskId);
    if (!taskRecord) {
      throw new Error(`Task ${taskId} is no longer active.`);
    }

    const task = taskRecord.task;
    if (task.origin.kind === "launchedByUser") {
      // User-launched tasks are already the visible task for their chat, so they never wait here.
      await operation(this.deps.channel);
      return;
    }

    if (session.visibleTask?.taskId === taskId) {
      if (await this.transitionJobTaskToInteractive(task) && !includesTaskContext) {
        await this.deps.channel.sendTaskUpdate(chatId, messages.scheduledJobBecameInteractive(task.taskName));
      }
      await operation(this.deps.channel);
      return;
    }

    if (this.isVisibleSlotAvailable(session)) {
      await this.claimVisibleSlotForJobTask(session, taskId, includesTaskContext);
      await operation(this.deps.channel);
      await this.drainPendingOperationsForActiveTask(session, taskId);
      return;
    }

    task.interactionState = "waitingToInteract";
    await new Promise<void>((resolve, reject) => {
      this.waitingJobInteractions.enqueue(chatId, {
        taskId,
        jobName,
        includesTaskContext,
        run: operation,
        resolve,
        reject,
      });
      this.reminders.sync(chatId);
    });
  }

  /**
   * Called when the visible slot may have just freed. Shows the next deferred
   * share-deletion prompt if one is queued, otherwise promotes the next waiting
   * job task into the slot.
   */
  async onVisibleSlotAvailable(chatId: ChatId): Promise<void> {
    const session = this.deps.sessionStore.getOrCreate(chatId);
    if (!this.isVisibleSlotAvailable(session)) {
      this.reminders.sync(chatId);
      return;
    }

    if (await this.showNextDeferredShareDeletionPrompt(session)) {
      return;
    }

    await this.promoteNextWaitingJobTask(session);
  }

  removeTask(chatId: ChatId, taskId: string): void {
    this.waitingJobInteractions.removeWhere(
      chatId,
      (entry) => entry.taskId === taskId,
      (entry) => entry.reject(new Error(`Task ${taskId} ended while waiting to interact.`)),
    );
    this.reminders.sync(chatId);
  }

  // ---------------------------------------------------------------------------
  // Visible-slot scheduler
  // ---------------------------------------------------------------------------

  private isVisibleSlotAvailable(session: SessionState): boolean {
    return !session.visibleTask && !session.pendingShareDeletion;
  }

  /** Moves a background job task into the visible slot and marks it interacting. */
  private async claimVisibleSlotForJobTask(session: SessionState, taskId: string, includesTaskContext: boolean): Promise<void> {
    if (session.visibleTask?.taskId !== taskId) {
      session.promoteBackgroundJobTask(taskId);
    }
    const task = session.visibleTask;
    if (task && await this.transitionJobTaskToInteractive(task) && !includesTaskContext) {
      await this.deps.channel.sendTaskUpdate(session.chatId, messages.scheduledJobBecameInteractive(task.taskName));
    }
    this.reminders.sync(session.chatId);
  }

  private async transitionJobTaskToInteractive(task: ActiveTaskState): Promise<boolean> {
    if (task.origin.kind !== "launchedByJob" || task.interactionState === "interacting") {
      return false;
    }
    task.interactionState = "interacting";
    await this.deps.onJobTaskBecameInteractive(task.taskId);
    return true;
  }

  private async showNextDeferredShareDeletionPrompt(session: SessionState): Promise<boolean> {
    const next = this.pendingShareDeletionPrompts.shift(session.chatId);
    if (!next) {
      return false;
    }

    session.pendingShareDeletion = {
      requestId: next.requestId,
      taskId: next.taskId,
      taskName: next.taskName,
      summary: next.summary,
    };
    await this.deps.channel.sendShareDeletionRequest(session.chatId, next.requestId, next.taskName, next.summary);
    this.reminders.sync(session.chatId);
    return true;
  }

  private async promoteNextWaitingJobTask(session: SessionState): Promise<void> {
    while (this.isVisibleSlotAvailable(session)) {
      const next = this.waitingJobInteractions.shift(session.chatId);
      if (!next) {
        this.reminders.sync(session.chatId);
        return;
      }

      if (!session.findTask(next.taskId)) {
        next.reject(new Error(`Task ${next.taskId} is no longer active.`));
        continue;
      }

      await this.claimVisibleSlotForJobTask(session, next.taskId, next.includesTaskContext);
      if (await this.executeWaitingInteraction(next)) {
        await this.drainPendingOperationsForActiveTask(session, next.taskId);
      }
      return;
    }

    this.reminders.sync(session.chatId);
  }

  /**
   * Once `taskId` holds the slot, runs its remaining consecutive queued
   * operations until the queue head belongs to a different task (or one fails).
   */
  private async drainPendingOperationsForActiveTask(session: SessionState, taskId: string): Promise<void> {
    while (session.visibleTask?.taskId === taskId) {
      if (this.waitingJobInteractions.peek(session.chatId)?.taskId !== taskId) {
        break;
      }

      const next = this.waitingJobInteractions.shift(session.chatId);
      if (!next) {
        break;
      }

      if (!await this.executeWaitingInteraction(next)) {
        break;
      }
    }

    this.reminders.sync(session.chatId);
  }

  /** Runs a single queued interaction and settles its waiting promise. */
  private async executeWaitingInteraction(interaction: WaitingJobInteraction): Promise<boolean> {
    try {
      await interaction.run(this.deps.channel);
      interaction.resolve();
      return true;
    } catch (error) {
      interaction.reject(error);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Blocked-job reminders
  // ---------------------------------------------------------------------------

  private getBlockedJobReminderContext(chatId: ChatId): BlockedJobReminderContext | null {
    const session = this.deps.sessionStore.getOrCreate(chatId);
    const blocker = session.visibleTask;
    if (!blocker || blocker.origin.kind !== "launchedByUser") {
      return null;
    }

    const waitingTaskName = this.waitingJobInteractions.peek(chatId)?.jobName
      ?? this.pendingShareDeletionPrompts.peek(chatId)?.taskName;
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
