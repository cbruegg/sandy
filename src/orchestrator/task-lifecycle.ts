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
import { findSessionTask, removeSessionTask } from "./session-task-state.js";
import type {
  ActiveTaskStatus,
  OrchestratorCoreDependencies,
  UserMessageEvent
} from "./shared.js";
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
  TranscriptEntry,
} from "../types.js";
import type { JobDefinition } from "../jobs/job-types.js";
import type { SandboxHandle } from "../sandbox/sandbox-runner.js";
import type {TaskFailureHandler} from "./privileges.ts";

export interface OrchestratorTaskLifecycle {
  resolvePendingShareDeletion(session: SessionState, decision: "approve" | "deny"): Promise<void>;
  releasePendingTaskSummaries(session: SessionState): TranscriptEntry[];
  executeMainAgentDecision(session: SessionState, event: UserMessageEvent, decision: MainAgentDecision): Promise<void>;
  cancelActiveTask(session: SessionState, reason: string): Promise<void>;
  markActiveTaskFinished(taskId: string): Promise<void>;
  requireActiveTaskHandle(taskId: string): SandboxHandle;
  stageAttachments(
    chatId: string,
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
  ) {}

  async routeSubAgentEvent(chatId: string, taskId: string, event: SubAgentEvent): Promise<void> {
    const session = this.deps.sessionStore.getOrCreate(chatId);
    const taskRecord = findSessionTask(session, taskId);
    if (!taskRecord) {
      logger.warn("task.event_ignored", {
        chatId,
        taskId,
        eventType: event.type,
      });
      return;
    }

    const task = taskRecord.task;
    this.deps.taskCoordinator.recordTaskActivity(session, taskId);
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
          const message = event.message.trim();
          if (!message) {
            break;
          }
          await this.runTaskVisibleOperation(chatId, taskId, task.taskName, async () => {
            this.markTaskInteracting(session, taskId);
            await this.deps.channel.sendTaskUpdate(chatId, message);
          });
          break;
        }
        case "assistant_output":
          await this.runTaskVisibleOperation(chatId, taskId, task.taskName, async () => {
            this.markTaskInteracting(session, taskId);
            await this.deps.channel.sendTaskUpdate(chatId, event.text);
          });
          break;
        case "task_summary":
          this.recordTaskSummary(session, taskId, event.summary);
          break;
        case "task_done":
          // Workers usually emit task_summary first, then task_done to publish that stored summary for review.
          if (task.status !== "completed") {
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
          if (!this.isSilentJobTask(session, taskId)) await this.sendTaskSummaryForReview(chatId, session, taskId);
          await this.finishTask(session, taskId, "completed");
          break;
        case "task_error":
          logger.error("task.failed", null, undefined, {
            chatId,
            taskId,
            message: event.message,
          });
          await this.runTaskVisibleOperation(chatId, taskId, task.taskName, async () => {
            await this.deps.channel.sendText(chatId, messages.taskFailed(event.message));
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
        await this.deps.channel.sendText(event.chatId, decision.replyText);
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
          session.activeTask = {
            taskId,
            taskName: decision.taskName,
            status: "running",
            startedAt: now,
            lastActivityAt: now,
            pendingPrivilegeRequest: null,
            taskPolicy,
            approvedMcpTools: [],
            approvedMcpResourceReads: [],
            approvedHttpTokenSessionGrants: [],
            approvedHttpTokenOnceGrants: [],
            approvedHostDirectories: [],
            workerConnected: false,
            taskSummary: null,
            origin: { kind: "launchedByUser", chatId: event.chatId },
            interactionState: "interacting",
          };

          const handle = await this.deps.sandboxRunner.launchTask(
            {
              chatId: event.chatId,
              taskId,
              taskName: decision.taskName,
              taskLanguage: decision.taskLanguage,
              channelFormatting: this.channelFormatting,
              workerStartConfig: await this.deps.buildWorkerStartConfig(),
              prepareStartInput: async (taskSharePath) => {
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
            },
            async (subAgentEvent) => this.routeSubAgentEvent(event.chatId, taskId, subAgentEvent),
          );

          this.activeTasks.registerHandle(taskId, handle);
          launchSucceeded = true;
          logger.info("task.started", {
            chatId: event.chatId,
            taskId,
            taskName: decision.taskName,
          });
          await this.deps.channel.sendText(event.chatId, messages.taskStarted(decision.taskName));
          return;
        } catch (error) {
          if (!launchSucceeded && session.activeTask?.taskId === taskId) {
            session.activeTask = null;
          }
          throw error;
        }
      }
      default:
        assertNever(decision);
    }
  }

  async launchJobTask(job: JobDefinition, chatId: string, workspacePath: string | null): Promise<string> {
    const session = this.deps.sessionStore.getOrCreate(chatId);

    const taskId = randomUUID();
    const now = new Date().toISOString();
    const taskName = `Scheduled job: ${job.name}`;
    const taskPolicy = await this.deps.jobApprovalStore.getTaskPolicy(job.id);
    const taskState: ActiveTaskState = {
      taskId,
      taskName,
      status: "running",
      startedAt: now,
      lastActivityAt: now,
      pendingPrivilegeRequest: null,
      taskPolicy,
      approvedMcpTools: [],
      approvedMcpResourceReads: [],
      approvedHttpTokenSessionGrants: [],
      approvedHttpTokenOnceGrants: [],
      approvedHostDirectories: workspacePath ? [{ path: workspacePath, level: "read_write" }] : [],
      workerConnected: false,
      taskSummary: null,
      origin: { kind: "launchedByJob", jobId: job.id },
      interactionState: "silent",
    };
    this.deps.taskCoordinator.addBackgroundJobTask(session, taskState);

    try {
      const handle = await this.deps.sandboxRunner.launchTask(
        {
          chatId,
          taskId,
          taskName,
          taskLanguage: "en",
          channelFormatting: this.channelFormatting,
          workerStartConfig: await this.deps.buildWorkerStartConfig(),
          prepareStartInput: () => Promise.resolve({
            taskBrief: buildJobTaskBrief(job, workspacePath),
            initialInput: { text: job.prompt ?? "Run the scheduled job now.", images: [] },
          }),
        },
        async (subAgentEvent) => this.routeSubAgentEvent(chatId, taskId, subAgentEvent),
      );
      this.activeTasks.registerHandle(taskId, handle);
      return taskId;
    } catch (error) {
      removeSessionTask(session, taskId);
      this.deps.taskCoordinator.removeTask(chatId, taskId);
      throw error;
    }
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

  async sendTaskSummaryForReview(chatId: string, session: SessionState, taskId: string): Promise<void> {
    const activeTask = this.deps.taskCoordinator.findTask(session, taskId);
    if (!activeTask) {
      return;
    }

    const summary = activeTask.taskSummary ?? this.buildCompletedTaskFallbackSummary(activeTask);
    await this.runTaskVisibleOperation(chatId, taskId, activeTask.taskName, async () => {
      session.pendingTaskSummary = {
        taskName: activeTask.taskName,
        summary,
      };
      await this.deps.channel.sendReportableText(chatId, messages.taskSummaryReady(activeTask.taskName, summary));
    });
  }

  async cancelActiveTask(session: SessionState, reason: string): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    logger.warn("task.cancelling", {
      chatId: session.chatId,
      taskId: activeTask.taskId,
      reason,
    });
    this.deps.taskCoordinator.recordTaskActivity(session, activeTask.taskId);
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
      await this.runTaskVisibleOperation(session.chatId, taskId, task.taskName, async () => {
        await this.deps.channel.sendText(session.chatId, messages.taskFailed(message));
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
    chatId: string,
    messageId: string,
    attachments: Extract<NormalizedChatEvent, { kind: "user_message" }>["attachments"],
    taskSharePath: string,
  ) {
    return stageSharedAttachments({
      channel: this.deps.channel,
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
      await this.deps.channel.sendText(session.chatId, messages.shareDeleted(pending.taskName));
    } else {
      await this.deps.channel.sendText(session.chatId, messages.sharePreserved(pending.taskName));
    }

    session.pendingShareDeletion = null;
    await this.deps.taskCoordinator.onTaskVisibilityChanged(session.chatId);
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
    removeSessionTask(session, task.taskId);
    this.deps.taskCoordinator.removeTask(session.chatId, task.taskId);
    this.activeTasks.deleteHandle(task.taskId);
    if (task.origin?.kind !== "launchedByJob" || task.interactionState !== "silent") {
      await this.promptForShareDeletionIfNeeded(session, task.taskId, task.taskName);
    }
    await this.deps.taskCoordinator.onTaskVisibilityChanged(session.chatId);
  }

  private isSilentJobTask(session: SessionState, taskId: string): boolean {
    const task = this.deps.taskCoordinator.findTask(session, taskId);
    return !!task && task.origin?.kind === "launchedByJob" && task.interactionState === "silent";
  }

  private markTaskInteracting(session: SessionState, taskId: string): void {
    const task = this.deps.taskCoordinator.findTask(session, taskId);
    if (task && task.origin?.kind === "launchedByJob") {
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
    await this.runTaskVisibleOperation(session.chatId, taskId, task.taskName, async () => {
      await this.deps.channel.sendText(session.chatId, message);
    });
    await this.closeTask(session, taskId);
  }

  private buildCompletedTaskFallbackSummary(task: NonNullable<SessionState["activeTask"]>): string {
    return [
      `The task ended without a worker-provided handoff summary. Task name: ${task.taskName}.`,
      "Open questions: Review the visible task updates above if more detail is needed.",
    ].join("\n");
  }

  private failPendingPrivilegeRequestOnTaskClose(task: NonNullable<SessionState["activeTask"]>): void {
    if (!task.pendingPrivilegeRequest) {
      return;
    }

    const failedResult = {
      requestId: task.pendingPrivilegeRequest.requestId,
      outcome: "failed" as const,
      message: messages.taskEndedBeforePrivilegeRequestResolved(
        task.taskId,
        task.pendingPrivilegeRequest.requestId,
      ),
    };
    if (task.pendingPrivilegeRequest.kind === "mcp_tool_call" || task.pendingPrivilegeRequest.kind === "mcp_resource_read") {
      this.activeTasks.resolvePendingMcpPrivilege(task.pendingPrivilegeRequest.requestId, failedResult);
    }
    if (
      task.pendingPrivilegeRequest.kind === "host_operation"
      || task.pendingPrivilegeRequest.kind === "http_token_use"
      || task.pendingPrivilegeRequest.kind === "host_directory_access"
      || task.pendingPrivilegeRequest.kind === "skill_mutation"
      || task.pendingPrivilegeRequest.kind === "job_mutation"
    ) {
      this.activeTasks.resolvePendingNativeTool(task.pendingPrivilegeRequest.requestId, failedResult);
    }
  }

  private async handleAuthRefresh(taskId: string, previousAccountId: string | null): Promise<void> {
    const tokens = await this.deps.refreshChatGPTTokens?.(taskId, previousAccountId) ?? null;
    await this.activeTasks.getHandle(taskId)?.resolveAuthRefresh?.(tokens);
  }

  private async promptForShareDeletionIfNeeded(session: SessionState, taskId: string, taskName: string): Promise<void> {
    const inspection = await this.deps.sandboxRunner.inspectTaskShare(taskId);
    if (inspection.isEmpty) {
      await this.deps.sandboxRunner.deleteTaskShare(taskId);
      return;
    }

    const requestId = randomUUID();
    session.pendingShareDeletion = {
      requestId,
      taskId,
      taskName,
      summary: inspection.summary ?? "",
    };
    await this.deps.channel.sendShareDeletionRequest(session.chatId, requestId, taskName, inspection.summary ?? "");
  }

  private async runTaskVisibleOperation(
    chatId: string,
    taskId: string,
    taskName: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    await this.deps.taskCoordinator.runJobUserVisibleOperation(chatId, taskId, taskName, operation);
  }
}

function normalizeTaskPolicy(policy: MainAgentTaskPolicyInput | undefined): MainAgentTaskPolicy {
  return {
    autoApproveMcpServers: uniqueStrings(policy?.autoApproveMcpServers ?? []),
    autoApproveHttpTokens: uniqueStrings(policy?.autoApproveHttpTokens ?? []),
  };
}

function uniqueStrings(entries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function buildJobTaskBrief(job: JobDefinition, workspacePath: string | null): string {
  return [
    `Run scheduled Sandy job "${job.name}" (${job.id}).`,
    `Use Sandy skill: ${job.skillId}.`,
    workspacePath ? `This recurring job has a persistent workspace directory on the host: ${workspacePath}` : null,
    workspacePath ? "The workspace is for durable notes, generated files, helper scripts, caches, and job state." : null,
    workspacePath ? "If you need to access that directory from the worker, request host directory access for it; Sandy has pre-approved read/write access for this job execution." : null,
    job.prompt ? `Job prompt:\n${job.prompt}` : null,
    "If you can complete the job without user interaction, finish silently. If you send user-visible output or need approval, follow Sandy's normal review and safety flow.",
  ].filter((line): line is string => line !== null).join("\n\n");
}

function assertNever(value: never): never {
  throw new Error(`Unhandled main agent decision: ${JSON.stringify(value)}`);
}

export { describeUserMessageForMainAgent };
