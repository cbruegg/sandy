import type { ChannelAdapter } from "../channel/channel-adapter.js";
import { messages } from "../messages.js";
import type { SessionStore } from "../session/in-memory-session-store.js";
import type { ActiveTaskState, SessionState } from "../types.js";
import type { ChatId } from "../types.js";
import { BlockedJobReminderScheduler } from "./blocked-job-reminder-scheduler.js";
import type { BlockedJobReminderContext, TimerControls } from "./blocked-job-reminder-scheduler.js";

type DeferredJobOperation = {
  kind: "job_operation";
  taskId: string;
  jobName: string;
  run: (channel: ChannelAdapter) => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type DeferredShareDeletionPrompt = {
  kind: "share_deletion_prompt";
  requestId: string;
  taskId: string;
  taskName: string;
  summary: string;
};

type DeferredTaskSummaryReview = {
  kind: "task_summary_review";
  taskId: string;
  taskName: string;
  summary: string;
};

type DeferredVisibleItem =
  | DeferredJobOperation
  | DeferredShareDeletionPrompt
  | DeferredTaskSummaryReview;

export type EnqueuedShareDeletionPrompt = {
  requestId: string;
  taskId: string;
  taskName: string;
  summary: string;
};

export type EnqueuedTaskSummaryReview = {
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
 * At any moment a chat can present exactly one user-facing blocker: either a
 * visible task (`session.visibleTask`) or a share-deletion prompt
 * (`session.pendingShareDeletion`). User-launched tasks own that slot directly.
 * Job-launched tasks run silently in the background and must acquire the slot
 * before they can talk to the user.
 *
 * All deferred user-visible work is held in one per-chat FIFO queue of
 * `DeferredVisibleItem`. When the slot frees (`onVisibleSlotAvailable`), items
 * are drained in strict enqueue order.
 */
export class TaskCoordinator {
  private readonly deferredVisibleItems = new PerChatQueue<DeferredVisibleItem>();
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

  async enqueueShareDeletionPrompt(chatId: ChatId, prompt: EnqueuedShareDeletionPrompt): Promise<void> {
    const session = this.deps.sessionStore.getOrCreate(chatId);
    const item: DeferredShareDeletionPrompt = { kind: "share_deletion_prompt", ...prompt };

    if (this.isVisibleSlotAvailable(session) && this.deferredVisibleItems.peek(chatId) === undefined) {
      await this.showShareDeletionPrompt(session, item);
    } else {
      this.deferredVisibleItems.enqueue(chatId, item);
    }

    this.reminders.sync(chatId);
  }

  async enqueueTaskSummaryReview(chatId: ChatId, review: EnqueuedTaskSummaryReview): Promise<void> {
    const session = this.deps.sessionStore.getOrCreate(chatId);
    const item: DeferredTaskSummaryReview = { kind: "task_summary_review", ...review };

    if (this.isVisibleSlotAvailable(session) || session.visibleTask?.taskId === review.taskId) {
      await this.showTaskSummaryReview(session, item);
    } else {
      this.deferredVisibleItems.enqueue(chatId, item);
    }

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
      await this.transitionJobTaskToInteractive(task);
      await operation(this.deps.channel);
      return;
    }

    if (this.isVisibleSlotAvailable(session)) {
      await this.claimVisibleSlotForJobTask(session, taskId);
      await operation(this.deps.channel);
      await this.drainConsecutiveJobOperations(session, taskId);
      return;
    }

    task.interactionState = "waitingToInteract";
    await new Promise<void>((resolve, reject) => {
      this.deferredVisibleItems.enqueue(chatId, { kind: "job_operation", taskId, jobName, run: operation, resolve, reject });
      this.reminders.sync(chatId);
    });
  }

  /**
   * Called when the visible slot may have just freed. Drains the unified FIFO
   * queue, showing each deferred item in order until a slot-owning item is
   * reached.
   */
  async onVisibleSlotAvailable(chatId: ChatId): Promise<void> {
    const session = this.deps.sessionStore.getOrCreate(chatId);

    while (this.isVisibleSlotAvailable(session)) {
      const next = this.deferredVisibleItems.shift(session.chatId);
      if (!next) {
        break;
      }

      const shouldContinue = await this.executeDeferredItem(session, next);
      if (!shouldContinue) {
        break;
      }
    }

    this.reminders.sync(chatId);
  }

  removeTask(chatId: ChatId, taskId: string): void {
    this.deferredVisibleItems.removeWhere(
      chatId,
      (entry) => entry.kind === "job_operation" && entry.taskId === taskId,
      (entry) => {
        (entry as DeferredJobOperation).reject(new Error(`Task ${taskId} ended while waiting to interact.`));
      },
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
  private async claimVisibleSlotForJobTask(session: SessionState, taskId: string): Promise<void> {
    if (session.visibleTask?.taskId !== taskId) {
      session.promoteBackgroundJobTask(taskId);
    }
    const task = session.visibleTask;
    if (task) {
      await this.transitionJobTaskToInteractive(task);
    }
    this.reminders.sync(session.chatId);
  }

  private async transitionJobTaskToInteractive(task: ActiveTaskState): Promise<void> {
    if (task.origin.kind !== "launchedByJob" || task.interactionState === "interacting") {
      return;
    }
    task.interactionState = "interacting";
    await this.deps.onJobTaskBecameInteractive(task.taskId);
  }

  private async showShareDeletionPrompt(session: SessionState, prompt: DeferredShareDeletionPrompt): Promise<void> {
    session.pendingShareDeletion = {
      requestId: prompt.requestId,
      taskId: prompt.taskId,
      taskName: prompt.taskName,
      summary: prompt.summary,
    };
    await this.deps.channel.sendShareDeletionRequest(session.chatId, prompt.requestId, prompt.taskName, prompt.summary);
    this.reminders.sync(session.chatId);
  }

  private async showTaskSummaryReview(session: SessionState, review: DeferredTaskSummaryReview): Promise<void> {
    session.pendingTaskSummary = {
      taskName: review.taskName,
      summary: review.summary,
    };
    await this.deps.channel.sendReportableText(session.chatId, messages.taskSummaryReady(review.taskName, review.summary));
  }

  private async executeDeferredItem(session: SessionState, item: DeferredVisibleItem): Promise<boolean> {
    switch (item.kind) {
      case "share_deletion_prompt":
        await this.showShareDeletionPrompt(session, item);
        return false;
      case "task_summary_review":
        await this.showTaskSummaryReview(session, item);
        return true;
      case "job_operation": {
        if (!session.findTask(item.taskId)) {
          item.reject(new Error(`Task ${item.taskId} is no longer active.`));
          return true;
        }

        await this.claimVisibleSlotForJobTask(session, item.taskId);
        if (await this.executeJobOperation(item)) {
          await this.drainConsecutiveJobOperations(session, item.taskId);
        }
        return false;
      }
    }
  }

  /**
   * Once `taskId` holds the slot, runs its remaining consecutive queued
   * operations until the queue head belongs to a different item (or one fails).
   */
  private async drainConsecutiveJobOperations(session: SessionState, taskId: string): Promise<void> {
    while (session.visibleTask?.taskId === taskId) {
      const next = this.deferredVisibleItems.peek(session.chatId);
      if (!next || next.kind !== "job_operation" || next.taskId !== taskId) {
        break;
      }

      this.deferredVisibleItems.shift(session.chatId);
      if (!await this.executeJobOperation(next)) {
        break;
      }
    }

    this.reminders.sync(session.chatId);
  }

  /** Runs a single queued interaction and settles its waiting promise. */
  private async executeJobOperation(interaction: DeferredJobOperation): Promise<boolean> {
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

    const next = this.deferredVisibleItems.peek(chatId);
    if (!next) {
      return null;
    }

    const waitingTaskName = next.kind === "job_operation" ? next.jobName : next.taskName;
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
