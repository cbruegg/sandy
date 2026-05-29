import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import {
  buildTaskBriefWithAttachments,
  buildTaskInputPayload,
  describeUserMessageForMainAgent,
} from "./worker-input.js";
import { stageSharedAttachments } from "./task-share.js";
import { OrchestratorRuntimeState } from "./runtime-state.js";
import type { ActiveTaskStatus, SandyOrchestratorDependencies, UserMessageEvent } from "./shared.js";
import type {
  ChannelFormatting,
  MainAgentDecision,
  MainAgentTaskPolicy,
  MainAgentTaskPolicyInput,
  NormalizedChatEvent,
  SessionState,
  SubAgentEvent,
  TranscriptEntry,
} from "../types.js";

export class OrchestratorTaskLifecycle {
  constructor(
    private readonly deps: SandyOrchestratorDependencies,
    private readonly runtimeState: OrchestratorRuntimeState,
    private readonly channelFormatting: ChannelFormatting,
  ) {}

  async routeSubAgentEvent(chatId: string, taskId: string, event: SubAgentEvent): Promise<void> {
    const session = this.deps.sessionStore.getOrCreate(chatId);
    if (!session.activeTask || session.activeTask.taskId !== taskId) {
      logger.warn("task.event_ignored", {
        chatId,
        taskId,
        eventType: event.type,
      });
      return;
    }

    session.activeTask.lastActivityAt = new Date().toISOString();
    logger.info("task.event_received", {
      chatId,
      taskId,
      eventType: event.type,
    });

    try {
      switch (event.type) {
        case "worker_connected":
          session.activeTask.workerConnected = true;
          break;
        case "worker_disconnected":
          await this.failTaskAfterWorkerDisconnect(session, event.message);
          break;
        case "progress": {
          const message = event.message.trim();
          if (!message) {
            break;
          }
          await this.deps.channel.sendTaskUpdate(chatId, message);
          break;
        }
        case "assistant_output":
          await this.deps.channel.sendTaskUpdate(chatId, event.text);
          break;
        case "task_summary":
          this.recordTaskSummary(session, event.summary);
          break;
        case "task_done":
          // Workers usually emit task_summary first, then task_done to publish that stored summary for review.
          if (session.activeTask.status !== "completed") {
            await this.sendTaskSummaryForReview(chatId, session);
            await this.finishActiveTask(session, "completed");
          }
          break;
        case "final_result":
          this.recordTaskSummary(session, [
            `Summary: ${event.text}`,
            "Artifacts: none",
            "Open questions: none",
          ].join("\n"));
          await this.sendTaskSummaryForReview(chatId, session);
          await this.finishActiveTask(session, "completed");
          break;
        case "task_error":
          logger.error("task.failed", null, undefined, {
            chatId,
            taskId,
            message: event.message,
          });
          await this.deps.channel.sendText(chatId, messages.taskFailed(event.message));
          await this.finishActiveTask(session, "failed");
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
        const stagedAttachments = await this.stageAttachments(event.chatId, event.messageId, event.attachments, taskId);
        const taskBrief = buildTaskBriefWithAttachments(decision.taskBrief, stagedAttachments);
        const initialInput = buildTaskInputPayload(stagedAttachments);

        logger.info("task.launching", {
          chatId: event.chatId,
          taskId,
          taskName: decision.taskName,
        });
        const taskPolicy = normalizeTaskPolicy(decision.taskPolicy);
        session.activeTask = {
          taskId,
          taskName: decision.taskName,
          taskBrief,
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
        };

        const handle = await this.deps.sandboxRunner.launchTask(
          {
            chatId: event.chatId,
            taskId,
            taskName: decision.taskName,
            taskBrief,
            taskLanguage: decision.taskLanguage,
            channelFormatting: this.channelFormatting,
            initialInput,
            workerStartConfig: await this.deps.buildWorkerStartConfig(),
          },
          async (subAgentEvent) => this.routeSubAgentEvent(event.chatId, taskId, subAgentEvent),
        );

        this.runtimeState.registerHandle(taskId, handle);
        logger.info("task.started", {
          chatId: event.chatId,
          taskId,
          taskName: decision.taskName,
        });
        logger.debug("task.task_brief", {
          chatId: event.chatId,
          taskId,
          taskBrief,
        });

        await this.deps.channel.sendText(event.chatId, messages.taskStarted(decision.taskName));
        return;
      }
      default:
        assertNever(decision);
    }
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

  recordTaskSummary(session: SessionState, summary: string): void {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      return;
    }

    activeTask.taskSummary = trimmedSummary;
  }

  async sendTaskSummaryForReview(chatId: string, session: SessionState): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    const summary = activeTask.taskSummary ?? this.buildCompletedTaskFallbackSummary(activeTask);
    session.pendingTaskSummary = {
      taskName: activeTask.taskName,
      summary,
    };
    await this.deps.channel.sendReportableText(chatId, messages.taskSummaryReady(activeTask.taskName, summary));
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
    await this.runtimeState.requireHandle(activeTask.taskId).cancel(reason);
    await this.finishActiveTask(session, "cancelled", { discardSummary: true });
  }

  async finishActiveTask(
    session: SessionState,
    status: ActiveTaskStatus,
    options?: { discardSummary?: boolean },
  ): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    activeTask.status = status;
    await this.closeActiveTask(session, options);
  }

  async failActiveTaskFromEventHandling(session: SessionState, taskId: string, message: string): Promise<void> {
    if (!session.activeTask || session.activeTask.taskId !== taskId) {
      return;
    }

    session.activeTask.status = "failed";
    try {
      await this.deps.channel.sendText(session.chatId, messages.taskFailed(message));
    } catch (notifyError) {
      logger.error("task.event_failure_notification_failed", notifyError, "Unknown notification failure.", {
        chatId: session.chatId,
        taskId,
      });
    }
    await this.closeActiveTask(session);
  }

  async stageAttachments(
    chatId: string,
    messageId: string,
    attachments: Extract<NormalizedChatEvent, { kind: "user_message" }>["attachments"],
    taskId: string,
  ) {
    return stageSharedAttachments({
      channel: this.deps.channel,
      sandboxRunner: this.deps.sandboxRunner,
      chatId,
      messageId,
      attachments,
      taskId,
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
  }

  private async closeActiveTask(session: SessionState, options?: { discardSummary?: boolean }): Promise<void> {
    const task = session.activeTask;
    if (!task) {
      return;
    }
    const handle = this.runtimeState.getHandle(task.taskId);
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
    this.runtimeState.deleteHandle(task.taskId);
    session.activeTask = null;
    await this.promptForShareDeletionIfNeeded(session, task.taskId, task.taskName);
  }

  private async failTaskAfterWorkerDisconnect(session: SessionState, message: string): Promise<void> {
    if (!session.activeTask) {
      return;
    }

    session.activeTask.workerConnected = false;
    session.activeTask.status = "failed";
    await this.deps.channel.sendText(session.chatId, message);
    await this.closeActiveTask(session);
  }

  private buildCompletedTaskFallbackSummary(task: NonNullable<SessionState["activeTask"]>): string {
    return [
      `The task ended without a worker-provided handoff summary. Task name: ${task.taskName}. Brief: ${task.taskBrief}`,
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
      this.runtimeState.resolvePendingMcpPrivilege(task.pendingPrivilegeRequest.requestId, failedResult);
    }
    if (
      task.pendingPrivilegeRequest.kind === "host_operation"
      || task.pendingPrivilegeRequest.kind === "http_token_use"
      || task.pendingPrivilegeRequest.kind === "host_directory_access"
    ) {
      this.runtimeState.resolvePendingNativeTool(task.pendingPrivilegeRequest.requestId, failedResult);
    }
  }

  private async handleAuthRefresh(taskId: string, previousAccountId: string | null): Promise<void> {
    const tokens = await this.deps.refreshChatGPTTokens?.(taskId, previousAccountId) ?? null;
    await this.runtimeState.getHandle(taskId)?.resolveAuthRefresh?.(tokens);
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

function assertNever(value: never): never {
  throw new Error(`Unhandled main agent decision: ${JSON.stringify(value)}`);
}

export { describeUserMessageForMainAgent };
