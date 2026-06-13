import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import {
  buildTaskBriefWithAttachments,
  buildTaskInputPayload,
  describeUserMessageForMainAgent,
} from "./worker-input.js";
import { stageSharedAttachments } from "./task-share.js";
import { ActiveTaskRuntimeRegistry } from "./active-task-runtime-registry.js";

import type {
  ActiveTaskStatus,
  OrchestratorCoreDependencies,
  UserMessageEvent
} from "./shared.js";
import {
  createActiveTaskState,
} from "../types.js";
import type {
  ActiveTaskState,
  ChannelFormatting,
  MainAgentDecision,
  MainAgentTaskPolicy,
  MainAgentTaskPolicyInput,
  NormalizedChatEvent,
  SessionState,
  SharedAttachment,
  SubAgentEvent,
  TaskOrigin,
  TranscriptEntry,
} from "../types.js";
import type { ChatId } from "../types.js";
import type { JobDefinition } from "../jobs/job-validation.js";
import { buildJobTaskBrief } from "../jobs/job-task-brief.js";
import type { SandboxHandle, TaskStartInput } from "../sandbox/sandbox-runner.js";
import type { TaskFailureHandler } from "./shared.js";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import { failedPrivilegeResult, isMcpPrivilegeRequest, isNativeToolPrivilegeRequest } from "./privilege-results.js";

export interface OrchestratorTaskLifecycle {
  resolvePendingShareDeletion(session: SessionState, decision: "approve" | "deny"): Promise<void>;
  releasePendingTaskSummaries(session: SessionState): TranscriptEntry[];
  executeMainAgentDecision(session: SessionState, event: UserMessageEvent, decision: MainAgentDecision): Promise<void>;
  cancelActiveTask(session: SessionState, reason: string): Promise<void>;
  markActiveTaskFinished(taskId: string): Promise<void>;
  requireActiveTaskHandle(taskId: string): SandboxHandle;
  stageAttachments(
    chatId: ChatId,
    messageId: string,
    attachments: UserMessageEvent["attachments"],
    taskSharePath: string,
  ): Promise<SharedAttachment[]>;
}

export class OrchestratorTaskLifecycleImpl implements TaskFailureHandler, OrchestratorTaskLifecycle {
  constructor(
    private readonly deps: OrchestratorCoreDependencies,
    private readonly activeTasks: ActiveTaskRuntimeRegistry,
    private readonly channelFormatting: ChannelFormatting,
    private readonly channel: ChannelAdapter,
  ) {}

  async routeSubAgentEvent(chatId: ChatId, taskId: string, event: SubAgentEvent): Promise<void> {
    const session = this.deps.sessionStore.getOrCreate(chatId);
    const taskRecord = session.findTask(taskId);
    if (!taskRecord) {
      logger.warn("task.event_ignored", {
        chatId,
        taskId,
        eventType: event.type,
      });
      return;
    }

    const task = taskRecord.task;
    logger.info("task.event_received", {
      chatId,
      taskId,
      eventType: event.type,
    });

    try {
      switch (event.type) {
        case "worker_connected":
          task.workerConnected = true;
          break;
        case "worker_disconnected":
          await this.failTaskAfterWorkerDisconnect(session, taskId, event.message);
          break;
        case "progress": {
          if (this.isSilentJobTask(session, taskId)) {
            logger.debug("task.progress_ignored_silent_job", {
              chatId,
              taskId,
            });
            break;
          }
          const message = event.message.trim();
          if (!message) {
            break;
          }
          await this.deps.taskCoordinator.runJobUserVisibleOperation(chatId, taskId, task.taskName, false, async (channel) => {
            this.markTaskInteracting(session, taskId);
            await channel.sendTaskUpdate(chatId, message);
          });
          break;
        }
        case "assistant_output":
          if (this.isSilentJobTask(session, taskId)) {
            logger.debug("task.assistant_output_ignored_silent_job", {
              chatId,
              taskId,
            });
            break;
          }
          await this.deps.taskCoordinator.runJobUserVisibleOperation(chatId, taskId, task.taskName, false, async (channel) => {
            this.markTaskInteracting(session, taskId);
            await channel.sendTaskUpdate(chatId, event.text);
          });
          break;
        case "task_summary":
          this.recordTaskSummary(session, taskId, event.summary);
          break;
        case "task_done":
          // Workers usually emit task_summary first, then task_done to publish that stored summary for review.
          if (task.status !== "completed") {
            // A launchedByJob task that never interacted with the user may finish silently without the usual review step.
            if (!this.isSilentJobTask(session, taskId)) await this.sendTaskSummaryForReview(chatId, session, taskId);
            await this.finishTask(session, taskId, "completed");
          }
          break;
        case "final_result":
          this.recordTaskSummary(session, taskId, [
            `Summary: ${event.text}`,
            "Artifacts: none",
            "Open questions: none",
          ].join("\n"));
          // A launchedByJob task that never interacted with the user may finish silently without the usual review step.
          if (!this.isSilentJobTask(session, taskId)) await this.sendTaskSummaryForReview(chatId, session, taskId);
          await this.finishTask(session, taskId, "completed");
          break;
        case "task_error":
          logger.error("task.failed", null, undefined, {
            chatId,
            taskId,
            message: event.message,
          });
          await this.deps.taskCoordinator.runJobUserVisibleOperation(chatId, taskId, task.taskName, true, async (channel) => {
            await channel.sendText(chatId, messages.taskFailed(event.message));
          });
          await this.finishTask(session, taskId, "failed");
          break;
        case "worker_log":
          break;
        case "chatgpt_auth_refresh_request":
          await this.handleAuthRefresh(taskId, event.previousAccountId);
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown sub-agent event handling failure.";
      logger.error("task.event_handler_failed", error, "Unknown sub-agent event handling failure.", {
        chatId,
        taskId,
        eventType: event.type,
      });
      await this.failActiveTaskFromEventHandling(session, taskId, message);
    }

  }

  async executeMainAgentDecision(
    session: SessionState,
    event: UserMessageEvent,
    decision: MainAgentDecision,
  ): Promise<void> {
    switch (decision.action) {
      case "reply":
        logger.info("task.reply_direct", {
          chatId: event.chatId,
        });
        await this.channel.sendText(event.chatId, decision.replyText);
        return;
      case "launch_task": {
        const taskId = randomUUID();
        const now = new Date().toISOString();
        let launchSucceeded = false;
        try {
          logger.info("task.launching", {
            chatId: event.chatId,
            taskId,
            taskName: decision.taskName,
          });
          const taskPolicy = normalizeTaskPolicy(decision.taskPolicy);
          session.visibleTask = createActiveTaskState(
            {
              taskId,
              taskName: decision.taskName,
              startedAt: now,
              taskPolicy,
              origin: { kind: "launchedByUser" },
              interactionState: "interacting",
            },
          );

          await this.launchTaskInSandbox(
            event.chatId,
            taskId,
            decision.taskName,
            decision.taskLanguage,
            async (taskSharePath) => {
              const stagedAttachments = await this.stageAttachments(event.chatId, event.messageId, event.attachments, taskSharePath);
              const brief = buildTaskBriefWithAttachments(decision.taskBrief, stagedAttachments);
              logger.debug("task.task_brief", {
                chatId: event.chatId,
                taskId,
                taskBrief: brief,
              });
              const initialInput = buildTaskInputPayload(stagedAttachments);
              return { taskBrief: brief, initialInput };
            },
          );
          launchSucceeded = true;
          logger.info("task.started", {
            chatId: event.chatId,
            taskId,
            taskName: decision.taskName,
          });
          await this.channel.sendText(event.chatId, messages.taskStarted(decision.taskName));
          return;
        } catch (error) {
          if (!launchSucceeded && session.visibleTask?.taskId === taskId) {
            session.visibleTask = null;
          }
          throw error;
        }
      }
      default:
        assertNever(decision);
    }
  }

  async launchJobTask(job: JobDefinition, chatId: ChatId, workspacePath: string | null): Promise<string> {
    const session = this.deps.sessionStore.getOrCreate(chatId);

    const taskId = randomUUID();
    const now = new Date().toISOString();
    const taskName = `Scheduled job: ${job.name}`;
    const taskPolicy = await this.deps.jobApprovalStore.getTaskPolicy(job.id);
    const taskState = createActiveTaskState(
      {
        taskId,
        taskName,
        startedAt: now,
        taskPolicy,
        origin: { kind: "launchedByJob", jobId: job.id },
        interactionState: "silent",
      },
      {
        approvedHostDirectories: workspacePath ? [{ path: workspacePath, level: "read_write" }] : [],
      },
    );
    this.deps.taskCoordinator.addBackgroundJobTask(session, taskState);

    try {
      await this.launchTaskInSandbox(
        chatId,
        taskId,
        taskName,
        "en",
        () => Promise.resolve({
          taskBrief: buildJobTaskBrief(job, workspacePath),
          initialInput: { text: `Execute skill ${job.skillId}.`, images: [] },
        }),
      );
      return taskId;
    } catch (error) {
      session.removeTask(taskId);
      this.deps.taskCoordinator.removeTask(chatId, taskId);
      throw error;
    }
  }

  private async launchTaskInSandbox(
    chatId: ChatId,
    taskId: string,
    taskName: string,
    taskLanguage: string,
    prepareStartInput: (taskSharePath: string) => Promise<TaskStartInput>,
  ): Promise<void> {
    const handle = await this.deps.sandboxRunner.launchTask(
      {
        chatId,
        taskId,
        taskName,
        taskLanguage,
        channelFormatting: this.channelFormatting,
        workerStartConfig: await this.deps.buildWorkerStartConfig(),
        prepareStartInput,
      },
      async (subAgentEvent) => this.routeSubAgentEvent(chatId, taskId, subAgentEvent),
    );
    this.activeTasks.registerHandle(taskId, handle);
  }

  requireActiveTaskHandle(taskId: string): SandboxHandle {
    return this.activeTasks.requireHandle(taskId);
  }

  async markActiveTaskFinished(taskId: string): Promise<void> {
    await this.activeTasks.requireHandle(taskId).markFinished();
  }

  releasePendingTaskSummaries(session: SessionState): TranscriptEntry[] {
    if (!session.pendingTaskSummary) {
      return [];
    }

    logger.info("task.pending_output_released", {
      chatId: session.chatId,
      taskName: session.pendingTaskSummary.taskName,
    });
    const timestamp = new Date().toISOString();
    const releasedEntries = [{
      role: "assistant" as const,
      kind: "released_task_summary",
      timestamp,
      text: session.pendingTaskSummary.summary,
    }];

    session.pendingTaskSummary = null;
    return releasedEntries;
  }

  recordTaskSummary(session: SessionState, taskId: string, summary: string): void {
    const task = this.deps.taskCoordinator.findTask(session, taskId);
    if (!task) {
      return;
    }

    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      return;
    }

    task.taskSummary = trimmedSummary;
  }

  async sendTaskSummaryForReview(chatId: ChatId, session: SessionState, taskId: string): Promise<void> {
    const activeTask = this.deps.taskCoordinator.findTask(session, taskId);
    if (!activeTask) {
      return;
    }

    const summary = activeTask.taskSummary ?? this.buildCompletedTaskFallbackSummary(activeTask);
    await this.deps.taskCoordinator.runJobUserVisibleOperation(chatId, taskId, activeTask.taskName, true, async (channel) => {
      session.pendingTaskSummary = {
        taskName: activeTask.taskName,
        summary,
      };
      await channel.sendReportableText(chatId, messages.taskSummaryReady(activeTask.taskName, summary));
    });
  }

  async cancelActiveTask(session: SessionState, reason: string): Promise<void> {
    const activeTask = session.visibleTask;
    if (!activeTask) {
      return;
    }

    logger.warn("task.cancelling", {
      chatId: session.chatId,
      taskId: activeTask.taskId,
      reason,
    });
    await this.activeTasks.requireHandle(activeTask.taskId).cancel(reason);
    await this.finishTask(session, activeTask.taskId, "cancelled", { discardSummary: true });
  }

  async finishTask(
    session: SessionState,
    taskId: string,
    status: ActiveTaskStatus,
    options?: { discardSummary?: boolean },
  ): Promise<void> {
    const task = this.deps.taskCoordinator.findTask(session, taskId);
    if (!task) {
      return;
    }

    task.status = status;
    await this.closeTask(session, taskId, options);
  }

  async failActiveTaskFromEventHandling(session: SessionState, taskId: string, message: string): Promise<void> {
    const task = this.deps.taskCoordinator.findTask(session, taskId);
    if (!task) {
      return;
    }

    task.status = "failed";
    try {
      await this.deps.taskCoordinator.runJobUserVisibleOperation(session.chatId, taskId, task.taskName, true, async (channel) => {
        await channel.sendText(session.chatId, messages.taskFailed(message));
      });
    } catch (notifyError) {
      logger.error("task.event_failure_notification_failed", notifyError, "Unknown notification failure.", {
        chatId: session.chatId,
        taskId,
      });
    }
    await this.closeTask(session, taskId);
  }

  async stageAttachments(
    chatId: ChatId,
    messageId: string,
    attachments: Extract<NormalizedChatEvent, { kind: "user_message" }>["attachments"],
    taskSharePath: string,
  ) {
    return stageSharedAttachments({
      channel: this.channel,
      chatId,
      messageId,
      attachments,
      taskSharePath,
    });
  }

  async resolvePendingShareDeletion(session: SessionState, decision: "approve" | "deny"): Promise<void> {
    const pending = session.pendingShareDeletion;
    if (!pending) {
      return;
    }

    if (decision === "approve") {
      await this.deps.sandboxRunner.deleteTaskShare(pending.taskId);
      await this.channel.sendText(session.chatId, messages.shareDeleted(pending.taskName));
    } else {
      await this.channel.sendText(session.chatId, messages.sharePreserved(pending.taskName));
    }

    session.pendingShareDeletion = null;
    await this.deps.taskCoordinator.onVisibleSlotAvailable(session.chatId);
  }

  private async closeTask(session: SessionState, taskId: string, options?: { discardSummary?: boolean }): Promise<void> {
    const task = this.deps.taskCoordinator.findTask(session, taskId);
    if (!task) {
      return;
    }
    const handle = this.activeTasks.getHandle(task.taskId);
    if (handle) {
      await handle.close();
    }
    if (options?.discardSummary) {
      session.pendingTaskSummary = null;
    }
    logger.info("task.cleared", {
      chatId: session.chatId,
      taskId: task.taskId,
      status: task.status,
    });
    this.failPendingPrivilegeRequestOnTaskClose(task);
    session.removeTask(task.taskId);
    this.deps.taskCoordinator.removeTask(session.chatId, task.taskId);
    this.activeTasks.deleteHandle(task.taskId);
    await this.promptForShareDeletionIfNeeded(session, task.taskId, task.taskName, task.origin);
    await this.deps.taskCoordinator.onVisibleSlotAvailable(session.chatId);
  }

  private isSilentJobTask(session: SessionState, taskId: string): boolean {
    const task = this.deps.taskCoordinator.findTask(session, taskId);
    return !!task && task.origin.kind === "launchedByJob" && task.interactionState === "silent";
  }

  private markTaskInteracting(session: SessionState, taskId: string): void {
    const task = this.deps.taskCoordinator.findTask(session, taskId);
    if (task && task.origin.kind === "launchedByJob") {
      task.interactionState = "interacting";
    }
  }

  private async failTaskAfterWorkerDisconnect(session: SessionState, taskId: string, message: string): Promise<void> {
    const task = this.deps.taskCoordinator.findTask(session, taskId);
    if (!task) {
      return;
    }

    task.workerConnected = false;
    task.status = "failed";
    await this.deps.taskCoordinator.runJobUserVisibleOperation(session.chatId, taskId, task.taskName, true, async (channel) => {
      await channel.sendText(session.chatId, message);
    });
    await this.closeTask(session, taskId);
  }

  private buildCompletedTaskFallbackSummary(task: ActiveTaskState): string {
    return [
      `The task ended without a worker-provided handoff summary. Task name: ${task.taskName}.`,
      "Open questions: Review the visible task updates above if more detail is needed.",
    ].join("\n");
  }

  private failPendingPrivilegeRequestOnTaskClose(task: ActiveTaskState): void {
    if (!task.pendingPrivilegeRequest) {
      return;
    }

    const failedResult = {
      ...failedPrivilegeResult(
        task.pendingPrivilegeRequest.requestId,
        messages.taskEndedBeforePrivilegeRequestResolved(task.taskId, task.pendingPrivilegeRequest.requestId),
      ),
    };
    if (isMcpPrivilegeRequest(task.pendingPrivilegeRequest)) {
      this.activeTasks.resolvePendingMcpPrivilege(task.pendingPrivilegeRequest.requestId, failedResult);
    }
    if (isNativeToolPrivilegeRequest(task.pendingPrivilegeRequest)) {
      this.activeTasks.resolvePendingNativeTool(task.pendingPrivilegeRequest.requestId, failedResult);
    }
  }

  private async handleAuthRefresh(taskId: string, previousAccountId: string | null): Promise<void> {
    const tokens = await this.deps.refreshChatGPTTokens?.(taskId, previousAccountId) ?? null;
    await this.activeTasks.getHandle(taskId)?.resolveAuthRefresh?.(tokens);
  }

  private async promptForShareDeletionIfNeeded(session: SessionState, taskId: string, taskName: string, origin: TaskOrigin): Promise<void> {
    const inspection = await this.deps.sandboxRunner.inspectTaskShare(taskId);
    if (inspection.isEmpty) {
      await this.deps.sandboxRunner.deleteTaskShare(taskId);
      return;
    }

    const requestId = randomUUID();
    const summary = inspection.summary ?? "";

    if (origin.kind === "launchedByJob" && session.visibleTask?.origin.kind === "launchedByUser") {
      this.deps.taskCoordinator.scheduleShareDeletionPrompt(session.chatId, {
        requestId,
        taskId,
        taskName,
        summary,
      });
      return;
    }

    session.pendingShareDeletion = {
      requestId,
      taskId,
      taskName,
      summary,
    };
    await this.channel.sendShareDeletionRequest(session.chatId, requestId, taskName, summary);
  }

}

function normalizeTaskPolicy(policy: MainAgentTaskPolicyInput | undefined): MainAgentTaskPolicy {
  return {
    autoApproveMcpServers: [...new Set(policy?.autoApproveMcpServers ?? [])],
    autoApproveHttpTokens: [...new Set(policy?.autoApproveHttpTokens ?? [])],
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled main agent decision: ${JSON.stringify(value)}`);
}

export { describeUserMessageForMainAgent };
