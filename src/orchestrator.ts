import { randomUUID } from "node:crypto";
import type { ChannelAdapter } from "./channel/channel-adapter.js";
import type { MainAgentController } from "./agent/main-agent-controller.js";
import type { PrivilegeBroker } from "./privilege/privilege-broker.js";
import { isSupportedPrivilegeRequest } from "./privilege/privilege-broker.js";
import type { PersistentApprovalStore } from "./privilege/persistent-approval-store.js";
import type { SandboxHandle, SandboxRunner } from "./sandbox/sandbox-runner.js";
import type { SessionStore } from "./session/in-memory-session-store.js";
import type { TaskRegistry } from "./task-registry.js";
import { logger } from "./logger.js";
import { messages } from "./messages.js";
import type {
  MainAgentDecision,
  MainAgentTaskPolicy,
  MainAgentTaskPolicyInput,
  NormalizedChatEvent,
  PrivilegeRequest,
  PrivilegeResolutionResult,
  SessionState,
  SubAgentEvent,
  TranscriptEntry,
} from "./types.js";
import { resolveTaskShareHostPath } from "./shared-workspace.js";
import {
  buildTaskBriefWithAttachments,
  buildWorkerFollowUpInput,
  describeUserMessageForMainAgent,
} from "./orchestrator-worker-input.js";
import { stageSharedAttachments } from "./orchestrator-task-share.js";

type ActiveHandleRecord = {
  handle: SandboxHandle;
};

type SupportedChatEvent = Exclude<NormalizedChatEvent, { kind: "unsupported_input" }>;
type UserTextEvent = Extract<NormalizedChatEvent, { kind: "user_text" }>;
type ActiveTaskStatus = NonNullable<SessionState["activeTask"]>["status"];

type SandyOrchestratorDependencies = {
  channel: ChannelAdapter;
  mainAgent: MainAgentController;
  sandboxRunner: SandboxRunner;
  sessionStore: SessionStore;
  privilegeBroker: PrivilegeBroker;
  taskRegistry: TaskRegistry;
  persistentApprovalStore?: PersistentApprovalStore;
};

export class SandyOrchestrator {
  private readonly handles = new Map<string, ActiveHandleRecord>();
  private readonly pendingMcpPrivilegeResolvers = new Map<string, (result: PrivilegeResolutionResult) => void>();
  private readonly channelFormatting: ReturnType<ChannelAdapter["getFormatting"]>;
  private readonly persistentApprovalStore: PersistentApprovalStore;

  constructor(private readonly deps: SandyOrchestratorDependencies) {
    this.channelFormatting = deps.channel.getFormatting();
    this.persistentApprovalStore = deps.persistentApprovalStore ?? {
      isAlwaysAllowed: () => false,
      allowTool: async () => {},
      isResourceReadAlwaysAllowed: () => false,
      allowResourceRead: async () => {},
      isHttpTokenAlwaysAllowed: () => false,
      allowHttpToken: async () => {},
    };
  }

  async handleChatEvent(event: NormalizedChatEvent): Promise<void> {
    const session = this.deps.sessionStore.getOrCreate(event.chatId);
    try {
      logger.info("chat.event_handled", {
        chatId: event.chatId,
        kind: event.kind,
        hasActiveTask: session.activeTask !== null,
      });
      if (event.kind === "user_text") {
        logger.debugContent("chat.user_message", {
          chatId: event.chatId,
          messageId: event.messageId,
          text: event.text,
          attachments: event.attachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            kind: attachment.kind,
            fileName: attachment.fileName ?? null,
            mimeType: attachment.mimeType ?? null,
          })),
        });
      }

      if (event.kind === "unsupported_input") {
        logger.warn("chat.unsupported_input", {
          chatId: event.chatId,
          inputType: event.inputType,
        });
        await this.deps.channel.sendText(event.chatId, messages.unsupportedInput(event.inputType));
        return;
      }

      if (!session.activeTask) {
        await this.routeIdleChatEvent(session, event);
        return;
      }

      await this.routeActiveTaskChatEvent(session, event);
      this.deps.sessionStore.save(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown chat event handling failure.";
      logger.error("chat.event_handler_failed", {
        chatId: event.chatId,
        kind: event.kind,
        hasActiveTask: session.activeTask !== null,
        message,
      });

      try {
        await this.deps.channel.sendText(event.chatId, messages.handlerFailed(message));
      } catch (notifyError) {
        logger.error("chat.event_failure_notification_failed", {
          chatId: event.chatId,
          kind: event.kind,
          message: notifyError instanceof Error ? notifyError.message : "Unknown notification failure.",
        });
      }
    }
  }

  private async routeSubAgentEvent(chatId: string, taskId: string, event: SubAgentEvent): Promise<void> {
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
           if (!message) break;
           await this.deps.channel.sendTaskUpdate(chatId, message);
           break;
         }
        case "assistant_output":
          await this.deps.channel.sendTaskUpdate(chatId, event.text);
          break;
        case "task_summary":
          this.recordTaskSummary(session, event.summary);
          break;
        case "tool_call":
          await this.routeWorkerToolCall(chatId, session, event.call);
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
        case "task_done":
          if (session.activeTask.status !== "completed") {
            await this.sendTaskSummaryForReview(chatId, session);
            await this.finishActiveTask(session, "completed");
          }
          break;
        case "task_error":
          logger.error("task.failed", {
            chatId,
            taskId,
            message: event.message,
          });
          await this.deps.channel.sendText(chatId, messages.taskFailed(event.message));
          await this.finishActiveTask(session, "failed");
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown sub-agent event handling failure.";
      logger.error("task.event_handler_failed", {
        chatId,
        taskId,
        eventType: event.type,
        message,
      });
      await this.failActiveTaskFromEventHandling(session, taskId, message);
    }

    this.deps.sessionStore.save(session);
  }

  private async routeWorkerToolCall(
    chatId: string,
    session: SessionState,
    call: Extract<SubAgentEvent, { type: "tool_call" }>["call"],
  ): Promise<void> {
    switch (call.type) {
      case "send_file_to_channel":
        await this.sendSharedFileToUser(chatId, session, call.path, call.caption);
        return;
      case "copy_into_share":
      case "copy_out_of_share":
      case "mount_ro":
      case "mount_rw":
        await this.presentPrivilegeRequestToUser(chatId, session, {
          kind: "host_operation",
          requestId: randomUUID(),
          payload: call,
        });
        return;
      case "request_http_token": {
        await this.presentPrivilegeRequestToUser(chatId, session, {
          kind: "http_token_use",
          requestId: randomUUID(),
          tokenId: call.tokenId,
          host: call.host,
          reason: call.reason,
          confirmsAutoApprovalForTask: this.shouldConfirmHttpTokenAutoApprovalForTask(session, call.tokenId, call.host),
        });
        return;
      }
    }

    assertNever(call); // would fail at compile-time
  }

  private async routeIdleChatEvent(session: SessionState, event: SupportedChatEvent): Promise<void> {
    switch (event.kind) {
      case "cancel_request":
        await this.deps.channel.sendText(event.chatId, messages.noActiveTaskToCancel());
        return;
      case "mark_finished_request":
        await this.deps.channel.sendText(event.chatId, messages.noActiveTaskToFinish());
        return;
      case "approval_response":
        if (session.pendingShareDeletion) {
          if (event.requestId && event.requestId !== session.pendingShareDeletion.requestId) {
            await this.deps.channel.sendText(event.chatId, messages.staleShareDeletionRequest());
            return;
          }
          await this.resolvePendingShareDeletion(session, mapApprovalDecisionToBoolean(event.decision));
          return;
        }
        await this.deps.channel.sendText(event.chatId, messages.noPendingPrivilegeRequest());
        return;
      case "danger_report":
        if (!session.pendingTaskSummary) {
          await this.deps.channel.sendText(event.chatId, messages.noActiveOutputToReport());
          return;
        }
        session.pendingTaskSummary = null;
        await this.deps.channel.sendText(event.chatId, messages.discardedPendingOutput());
        return;
      case "user_text":
        if (session.pendingShareDeletion) {
          await this.deps.channel.sendText(event.chatId, messages.shareDeletionStillPending());
          return;
        }
        {
          const newVisibleEntries = [
            ...this.releasePendingTaskSummaries(session),
            {
              role: "user" as const,
              kind: "user_text",
              timestamp: event.timestamp,
              text: describeUserMessageForMainAgent(event.text, event.attachments),
            },
          ];

          const decision = await this.deps.mainAgent.decide({
            chatId: event.chatId,
            newVisibleEntries,
            activeTask: session.activeTask,
            channelFormatting: this.channelFormatting,
          });

          await this.executeMainAgentDecision(session, event, decision);
          this.deps.sessionStore.save(session);
          return;
        }
    }
  }

  private async routeActiveTaskChatEvent(
    session: SessionState,
    event: SupportedChatEvent,
  ): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    switch (event.kind) {
      case "cancel_request":
        await this.cancelActiveTask(session, "Cancelled at the user's request.");
        await this.deps.channel.sendText(event.chatId, messages.taskCancelled(activeTask.taskName));
        return;
      case "mark_finished_request":
        if (activeTask.pendingPrivilegeRequest) {
          await this.deps.channel.sendText(event.chatId, messages.privilegeRequestStillPending());
          return;
        }
        await this.requireHandle(activeTask.taskId).markFinished();
        return;
      case "danger_report":
        logger.error("chat.unexpected_danger_report", {
          chatId: event.chatId,
          message: "Received danger_report during active task - this should only come from summary reports",
        });
        await this.deps.channel.sendText(event.chatId, messages.noPendingOutputToReport());
        return;
      case "approval_response":
        if (!activeTask.pendingPrivilegeRequest) {
          await this.deps.channel.sendText(event.chatId, messages.noPendingPrivilegeRequest());
          return;
        }
        if (event.requestId && event.requestId !== activeTask.pendingPrivilegeRequest.requestId) {
          await this.deps.channel.sendText(event.chatId, messages.stalePrivilegeRequest());
          return;
        }
        await this.resolvePendingPrivilegeRequest(session, activeTask.pendingPrivilegeRequest, event.decision);
        return;
      case "user_text":
        if (activeTask.pendingPrivilegeRequest) {
          await this.deps.channel.sendText(event.chatId, messages.privilegeRequestStillPending());
          return;
        }
        await this.requireHandle(activeTask.taskId).sendUserMessage(
          buildWorkerFollowUpInput(event.text, await this.stageAttachments(event.chatId, event.messageId, event.attachments, activeTask.taskId)),
        );
        return;
    }
  }

  private async executeMainAgentDecision(
    session: SessionState,
    event: UserTextEvent,
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
        logger.info("task.launching", {
          chatId: event.chatId,
          taskId,
          taskName: decision.taskName,
        });
        const taskPolicy = normalizeTaskPolicy(decision.taskPolicy);
        session.activeTask = {
          taskId,
          taskName: decision.taskName,
          taskBrief: taskBrief,
          status: "running",
          startedAt: now,
          lastActivityAt: now,
          pendingPrivilegeRequest: null,
          taskPolicy,
          approvedMcpTools: [],
          approvedMcpResourceReads: [],
          approvedHttpTokenSessionGrants: [],
          approvedHttpTokenOnceGrants: [],
          workerConnected: false,
          taskSummary: null,
        };

        const handle = await this.deps.sandboxRunner.launchTask(
          {
            chatId: event.chatId,
            taskId,
            taskName: decision.taskName,
            taskBrief: taskBrief,
            taskLanguage: decision.taskLanguage,
            channelFormatting: this.channelFormatting,
          },
          async (subAgentEvent) => this.routeSubAgentEvent(event.chatId, taskId, subAgentEvent),
        );

        this.handles.set(taskId, { handle });
        this.deps.taskRegistry.register(taskId, event.chatId);
        logger.info("task.started", {
          chatId: event.chatId,
          taskId,
          taskName: decision.taskName,
        });
        logger.debug("task.task_brief", {
          chatId: event.chatId,
          taskId,
          taskBrief: taskBrief,
        });

        await this.deps.channel.sendText(event.chatId, messages.taskStarted(decision.taskName));
        return;
      }
      default:
        assertNever(decision);
    }
  }

  /**
   * Releases buffered task summaries into the next main-agent turn.
   */
  private releasePendingTaskSummaries(session: SessionState): TranscriptEntry[] {
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

  private recordTaskSummary(session: SessionState, summary: string): void {
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

  private async sendTaskSummaryForReview(chatId: string, session: SessionState): Promise<void> {
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

  private async resolvePendingPrivilegeRequest(
    session: SessionState,
    request: PrivilegeRequest,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    let result: PrivilegeResolutionResult;
    if (request.kind === "mcp_tool_call") {
      result = await this.resolvePendingMcpPrivilegeRequest(session, request, decision);
    } else if (request.kind === "mcp_resource_read") {
      result = await this.resolvePendingMcpResourceReadRequest(session, request, decision);
    } else if (request.kind === "http_token_use") {
      result = await this.resolvePendingHttpTokenRequest(session, request, decision);
    } else if (decision === "deny") {
      result = {
        requestId: request.requestId,
        outcome: "denied",
        message: messages.userDeniedPrivilegeRequest(request.requestId),
      };
    } else if (!isSupportedPrivilegeRequest(request.payload)) {
      result = this.buildUnsupportedPrivilegeResult(request);
    } else {
      const operation = await this.deps.privilegeBroker.apply(request.payload, {
        taskId: activeTask.taskId,
        taskSharePath: this.deps.sandboxRunner.getTaskSharePath(activeTask.taskId),
      });
      result = {
        requestId: request.requestId,
        ...operation,
      };
    }

    if (request.kind === "host_operation") {
      await this.requireHandle(activeTask.taskId).resolvePrivilege(result);
    } else if (request.kind === "http_token_use") {
      await this.requireHandle(activeTask.taskId).resolvePrivilege(result);
    } else if (request.kind === "mcp_tool_call" || request.kind === "mcp_resource_read") {
      this.pendingMcpPrivilegeResolvers.get(request.requestId)?.(result);
      this.pendingMcpPrivilegeResolvers.delete(request.requestId);
    }
    await this.sendPrivilegeResolutionMessage(session.chatId, activeTask.taskId, result);

    activeTask.pendingPrivilegeRequest = null;
    activeTask.status = "running";
  }

  private async presentPrivilegeRequestToUser(chatId: string, session: SessionState, request: PrivilegeRequest): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    const requestType = resolveRequestTypeLabel(request);

    logger.info("task.privilege_requested", {
      chatId,
      taskId: activeTask.taskId,
      requestId: request.requestId,
      requestType,
    });

    if (request.kind === "host_operation" && !isSupportedPrivilegeRequest(request.payload)) {
      const result = this.buildUnsupportedPrivilegeResult(request);
      await this.requireHandle(activeTask.taskId).resolvePrivilege(result);
      await this.sendPrivilegeResolutionMessage(chatId, activeTask.taskId, result);
      return;
    }

    activeTask.pendingPrivilegeRequest = request;
    activeTask.status = "awaiting_privilege_decision";
    await this.deps.channel.sendPrivilegeRequest(chatId, request);
  }

  private async sendSharedFileToUser(
    chatId: string,
    session: SessionState,
    sharePath: string,
    caption?: string,
  ): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    await this.deps.channel.sendFile(
      chatId,
      resolveTaskShareHostPath(this.deps.sandboxRunner.getTaskSharePath(activeTask.taskId), sharePath, "send_file_to_channel path"),
      caption,
    );
  }

  private buildUnsupportedPrivilegeResult(request: PrivilegeRequest): PrivilegeResolutionResult {
    switch (request.kind) {
      case "host_operation":
        return {
          requestId: request.requestId,
          outcome: "failed",
          message: messages.unsupportedPrivilegeRequestType(request.payload.type),
        };
      case "mcp_tool_call":
        return {
          requestId: request.requestId,
          outcome: "failed",
          message: messages.unsupportedMcpPrivilegeRequest(request.serverId, request.toolName),
        };
      case "mcp_resource_read":
        return {
          requestId: request.requestId,
          outcome: "failed",
          message: messages.unsupportedMcpResourceReadPrivilegeRequest(request.serverId, request.uri),
        };
      case "http_token_use":
        return {
          requestId: request.requestId,
          outcome: "failed",
          message: messages.httpTokenNotConfigured(request.tokenId),
        };
    }
  }

  private async sendPrivilegeResolutionMessage(
    chatId: string,
    taskId: string,
    result: PrivilegeResolutionResult,
  ): Promise<void> {
    logger.info("task.privilege_resolved", {
      chatId,
      taskId,
      requestId: result.requestId,
      outcome: result.outcome,
    });

    switch (result.outcome) {
      case "approved":
        // No confirmation message needed; the user already knows they approved it.
        return;
      case "denied":
        await this.deps.channel.sendText(chatId, messages.privilegeDenied(result.requestId));
        return;
      case "failed":
        await this.deps.channel.sendText(chatId, messages.privilegeFailed(result.requestId, result.message));
        return;
      default:
        assertNever(result.outcome);
    }
  }

  private async cancelActiveTask(session: SessionState, reason: string): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    logger.warn("task.cancelling", {
      chatId: session.chatId,
      taskId: activeTask.taskId,
      reason,
    });
    await this.requireHandle(activeTask.taskId).cancel(reason);
    await this.finishActiveTask(session, "cancelled", { discardSummary: true });
  }

  private async finishActiveTask(
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

  private async closeActiveTask(session: SessionState, options?: { discardSummary?: boolean }): Promise<void> {
    const task = session.activeTask;
    if (!task) {
      return;
    }
    const handle = this.handles.get(task.taskId)?.handle;
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
    if (task.pendingPrivilegeRequest?.kind === "mcp_tool_call") {
      this.pendingMcpPrivilegeResolvers.get(task.pendingPrivilegeRequest.requestId)?.({
        requestId: task.pendingPrivilegeRequest.requestId,
        outcome: "failed",
        message: messages.taskEndedBeforePrivilegeRequestResolved(
          task.taskId,
          task.pendingPrivilegeRequest.requestId,
        ),
      });
      this.pendingMcpPrivilegeResolvers.delete(task.pendingPrivilegeRequest.requestId);
    }
    this.handles.delete(task.taskId);
    this.deps.taskRegistry.unregister(task.taskId);
    session.activeTask = null;
    await this.promptForShareDeletionIfNeeded(session, task.taskId, task.taskName);
  }

  private async failActiveTaskFromEventHandling(session: SessionState, taskId: string, message: string): Promise<void> {
    if (!session.activeTask || session.activeTask.taskId !== taskId) {
      return;
    }

    session.activeTask.status = "failed";
    try {
      await this.deps.channel.sendText(session.chatId, messages.taskFailed(message));
    } catch (notifyError) {
      logger.error("task.event_failure_notification_failed", {
        chatId: session.chatId,
        taskId,
        message: notifyError instanceof Error ? notifyError.message : "Unknown notification failure.",
      });
    }
    await this.closeActiveTask(session);
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
      "Artifacts: unknown",
      "Open questions: Review the visible task updates above if more detail is needed.",
    ].join("\n");
  }

  private requireHandle(taskId: string): SandboxHandle {
    const record = this.handles.get(taskId);
    if (!record) {
      throw new Error(`No sandbox handle is registered for task ${taskId}.`);
    }
    return record.handle;
  }

  private async stageAttachments(
    chatId: string,
    messageId: string,
    attachments: Extract<NormalizedChatEvent, { kind: "user_text" }>["attachments"],
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

  private async resolvePendingShareDeletion(session: SessionState, decision: "approve" | "deny"): Promise<void> {
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

  async authorizeMcpToolCall(input: {
    taskId: string;
    serverId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<PrivilegeResolutionResult> {
    return this.authorizeMcpRequest(input.taskId, {
      serverId: input.serverId,
      isTaskGrantAllowed: (task) => this.isTaskToolGrantAllowed(task, input.serverId, input.toolName),
      isPersistentAllowed: () => this.persistentApprovalStore.isAlwaysAllowed(input.serverId, input.toolName),
      sessionMessage: messages.mcpToolAllowedForWorkerSession(input.serverId, input.toolName),
      persistentMessage: messages.mcpToolAllowedFromPersistentConfig(input.serverId, input.toolName),
      buildRequest: (requestId) => ({
        kind: "mcp_tool_call" as const,
        requestId,
        serverId: input.serverId,
        toolName: input.toolName,
        arguments: input.arguments,
      }),
    });
  }

  async authorizeMcpResourceRead(input: {
    taskId: string;
    serverId: string;
    uri: string;
  }): Promise<PrivilegeResolutionResult> {
    return this.authorizeMcpRequest(input.taskId, {
      serverId: input.serverId,
      isTaskGrantAllowed: (task) => this.isTaskResourceReadGrantAllowed(task, input.serverId, input.uri),
      isPersistentAllowed: () => this.persistentApprovalStore.isResourceReadAlwaysAllowed(input.serverId, input.uri),
      sessionMessage: messages.mcpResourceReadAllowedForWorkerSession(input.serverId, input.uri),
      persistentMessage: messages.mcpResourceReadAllowedFromPersistentConfig(input.serverId, input.uri),
      buildRequest: (requestId) => ({
        kind: "mcp_resource_read" as const,
        requestId,
        serverId: input.serverId,
        uri: input.uri,
      }),
    });
  }

  private async authorizeMcpRequest(
    taskId: string,
    options: {
      serverId: string;
      isTaskGrantAllowed: (task: NonNullable<SessionState["activeTask"]>) => boolean;
      isPersistentAllowed: () => boolean;
      sessionMessage: string;
      persistentMessage: string;
      buildRequest: (requestId: string) => Extract<PrivilegeRequest, { kind: "mcp_tool_call" | "mcp_resource_read" }>;
    },
  ): Promise<PrivilegeResolutionResult> {
    const chatId = this.deps.taskRegistry.getChatId(taskId);
    if (!chatId) {
      return {
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.taskNotActive(taskId),
      };
    }

    const session = this.deps.sessionStore.getOrCreate(chatId);
    const activeTask = session.activeTask;
    if (!activeTask || activeTask.taskId !== taskId) {
      return {
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.taskNotActive(taskId),
      };
    }

    if (options.isTaskGrantAllowed(activeTask)) {
      return {
        requestId: randomUUID(),
        outcome: "approved",
        message: options.sessionMessage,
        scope: "worker_session",
      };
    }

    const hasConfiguredAutoApproval = options.isPersistentAllowed();
    if (isMcpAutoApprovalAllowed(activeTask, options.serverId) && hasConfiguredAutoApproval) {
      return {
        requestId: randomUUID(),
        outcome: "approved",
        message: options.persistentMessage,
        scope: "always",
      };
    }

    if (activeTask.pendingPrivilegeRequest) {
      return {
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.anotherPrivilegeRequestPendingForTask(),
      };
    }

    const request = {
      ...options.buildRequest(randomUUID()),
      confirmsAutoApprovalForTask: hasConfiguredAutoApproval,
    };
    activeTask.pendingPrivilegeRequest = request;
    activeTask.status = "awaiting_privilege_decision";
    this.deps.sessionStore.save(session);
    await this.deps.channel.sendPrivilegeRequest(chatId, request);

    return new Promise<PrivilegeResolutionResult>((resolve) => {
      this.pendingMcpPrivilegeResolvers.set(request.requestId, resolve);
    });
  }

  private async resolvePendingMcpPrivilegeRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "mcp_tool_call" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    return this.resolvePendingMcpRequest(session, request, decision, {
      deniedMessage: messages.userDeniedMcpToolCall(request.serverId, request.toolName),
      onceMessage: messages.mcpToolAllowedOnce(request.serverId, request.toolName),
      sessionMessage: messages.mcpToolAllowedForWorkerSession(request.serverId, request.toolName),
      alwaysMessage: messages.mcpToolAllowedAndPersisted(request.serverId, request.toolName),
      persistentMessage: messages.mcpToolAllowedFromPersistentConfig(request.serverId, request.toolName),
      grantAutoApprovalForTask: (task) => grantMcpAutoApprovalForTask(task, request.serverId),
      grantAccess: (task) => this.grantTaskToolAccess(task, request.serverId, request.toolName),
      persist: () => this.persistentApprovalStore.allowTool(request.serverId, request.toolName),
    });
  }

  private async resolvePendingMcpResourceReadRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "mcp_resource_read" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    return this.resolvePendingMcpRequest(session, request, decision, {
      deniedMessage: messages.userDeniedMcpResourceRead(request.serverId, request.uri),
      onceMessage: messages.mcpResourceReadAllowedOnce(request.serverId, request.uri),
      sessionMessage: messages.mcpResourceReadAllowedForWorkerSession(request.serverId, request.uri),
      alwaysMessage: messages.mcpResourceReadAllowedAndPersisted(request.serverId, request.uri),
      persistentMessage: messages.mcpResourceReadAllowedFromPersistentConfig(request.serverId, request.uri),
      grantAutoApprovalForTask: (task) => grantMcpAutoApprovalForTask(task, request.serverId),
      grantAccess: (task) => this.grantTaskResourceReadAccess(task, request.serverId, request.uri),
      persist: () => this.persistentApprovalStore.allowResourceRead(request.serverId, request.uri),
    });
  }

  private async resolvePendingMcpRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "mcp_tool_call" | "mcp_resource_read" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
    options: {
      deniedMessage: string;
      onceMessage: string;
      sessionMessage: string;
      alwaysMessage: string;
      persistentMessage: string;
      grantAutoApprovalForTask: (task: NonNullable<SessionState["activeTask"]>) => void;
      grantAccess: (task: NonNullable<SessionState["activeTask"]>) => void;
      persist: () => Promise<void>;
    },
  ): Promise<PrivilegeResolutionResult> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.taskNoLongerActive(session.chatId),
      };
    }

    switch (decision) {
      case "deny":
        return {
          requestId: request.requestId,
          outcome: "denied",
          message: options.deniedMessage,
        };
      case "approve":
      case "approve_once":
        if (request.confirmsAutoApprovalForTask) {
          options.grantAutoApprovalForTask(activeTask);
          return {
            requestId: request.requestId,
            outcome: "approved",
            message: options.persistentMessage,
            scope: "always",
          };
        }
        return {
          requestId: request.requestId,
          outcome: "approved",
          message: options.onceMessage,
          scope: "once",
        };
      case "approve_worker_session":
        if (request.confirmsAutoApprovalForTask) {
          options.grantAutoApprovalForTask(activeTask);
          return {
            requestId: request.requestId,
            outcome: "approved",
            message: options.persistentMessage,
            scope: "always",
          };
        }
        options.grantAccess(activeTask);
        return {
          requestId: request.requestId,
          outcome: "approved",
          message: options.sessionMessage,
          scope: "worker_session",
        };
      case "approve_always":
        await options.persist();
        options.grantAutoApprovalForTask(activeTask);
        return {
          requestId: request.requestId,
          outcome: "approved",
          message: options.alwaysMessage,
          scope: "always",
        };
      default:
        assertNever(decision);
    }
  }

  private isTaskToolGrantAllowed(
    task: NonNullable<SessionState["activeTask"]>,
    serverId: string,
    toolName: string,
  ): boolean {
    return task.approvedMcpTools.some((entry) => entry.serverId === serverId && entry.toolName === toolName);
  }

  private grantTaskToolAccess(
    task: NonNullable<SessionState["activeTask"]>,
    serverId: string,
    toolName: string,
  ): void {
    if (this.isTaskToolGrantAllowed(task, serverId, toolName)) {
      return;
    }
    task.approvedMcpTools.push({ serverId, toolName });
  }

  private isTaskResourceReadGrantAllowed(
    task: NonNullable<SessionState["activeTask"]>,
    serverId: string,
    uri: string,
  ): boolean {
    return task.approvedMcpResourceReads.some((entry) => entry.serverId === serverId && entry.uri === uri);
  }

  private grantTaskResourceReadAccess(
    task: NonNullable<SessionState["activeTask"]>,
    serverId: string,
    uri: string,
  ): void {
    if (this.isTaskResourceReadGrantAllowed(task, serverId, uri)) {
      return;
    }
    task.approvedMcpResourceReads.push({ serverId, uri });
  }

  private async resolvePendingHttpTokenRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "http_token_use" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.taskNoLongerActive(session.chatId),
      };
    }

    switch (decision) {
      case "deny":
        return {
          requestId: request.requestId,
          outcome: "denied",
          message: messages.httpTokenDenied(request.tokenId, request.host),
        };
      case "approve":
      case "approve_once":
        if (request.confirmsAutoApprovalForTask) {
          grantHttpTokenAutoApprovalForTask(activeTask, request.tokenId);
          return {
            requestId: request.requestId,
            outcome: "approved",
            message: messages.httpTokenAllowedFromPersistentConfig(request.tokenId, request.host),
            scope: "always",
          };
        }
        this.grantHttpTokenOnce(activeTask, request.tokenId, request.host);
        return {
          requestId: request.requestId,
          outcome: "approved",
          message: messages.httpTokenAllowedOnce(request.tokenId, request.host),
          scope: "once",
        };
      case "approve_worker_session":
        if (request.confirmsAutoApprovalForTask) {
          grantHttpTokenAutoApprovalForTask(activeTask, request.tokenId);
          return {
            requestId: request.requestId,
            outcome: "approved",
            message: messages.httpTokenAllowedFromPersistentConfig(request.tokenId, request.host),
            scope: "always",
          };
        }
        this.grantHttpTokenSessionAccess(activeTask, request.tokenId, request.host);
        return {
          requestId: request.requestId,
          outcome: "approved",
          message: messages.httpTokenAllowedForWorkerSession(request.tokenId, request.host),
          scope: "worker_session",
        };
      case "approve_always":
        await this.persistentApprovalStore.allowHttpToken(request.tokenId, request.host);
        grantHttpTokenAutoApprovalForTask(activeTask, request.tokenId);
        return {
          requestId: request.requestId,
          outcome: "approved",
          message: messages.httpTokenAllowedAndPersisted(request.tokenId, request.host),
          scope: "always",
        };
      default:
        assertNever(decision);
    }
  }

  private shouldConfirmHttpTokenAutoApprovalForTask(
    session: SessionState,
    tokenId: string,
    host: string,
  ): boolean {
    const activeTask = session.activeTask;
    return activeTask !== null
      && !isHttpTokenAutoApprovalAllowed(activeTask, tokenId)
      && this.persistentApprovalStore.isHttpTokenAlwaysAllowed(tokenId, host);
  }

  private grantHttpTokenOnce(
    task: NonNullable<SessionState["activeTask"]>,
    tokenId: string,
    host: string,
  ): void {
    task.approvedHttpTokenOnceGrants.push({ tokenId, host, consumed: false });
  }

  private grantHttpTokenSessionAccess(
    task: NonNullable<SessionState["activeTask"]>,
    tokenId: string,
    host: string,
  ): void {
    if (task.approvedHttpTokenSessionGrants.some((entry) => entry.tokenId === tokenId && entry.host === host)) {
      return;
    }
    task.approvedHttpTokenSessionGrants.push({ tokenId, host });
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

function isMcpAutoApprovalAllowed(task: NonNullable<SessionState["activeTask"]>, serverId: string): boolean {
  return task.taskPolicy.autoApproveMcpServers.includes(serverId);
}

function grantMcpAutoApprovalForTask(task: NonNullable<SessionState["activeTask"]>, serverId: string): void {
  if (isMcpAutoApprovalAllowed(task, serverId)) {
    return;
  }
  task.taskPolicy.autoApproveMcpServers.push(serverId);
}

function isHttpTokenAutoApprovalAllowed(task: NonNullable<SessionState["activeTask"]>, tokenId: string): boolean {
  return task.taskPolicy.autoApproveHttpTokens.includes(tokenId);
}

function grantHttpTokenAutoApprovalForTask(task: NonNullable<SessionState["activeTask"]>, tokenId: string): void {
  if (isHttpTokenAutoApprovalAllowed(task, tokenId)) {
    return;
  }
  task.taskPolicy.autoApproveHttpTokens.push(tokenId);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled main agent decision: ${JSON.stringify(value)}`);
}

function resolveRequestTypeLabel(request: PrivilegeRequest): string {
  switch (request.kind) {
    case "host_operation":
      return request.payload.type;
    case "mcp_tool_call":
      return request.toolName;
    case "mcp_resource_read":
      return `resource:${request.serverId}:${request.uri}`;
    case "http_token_use":
      return `http:${request.tokenId}@${request.host}`;
    default:
      return "unknown";
  }
}

function mapApprovalDecisionToBoolean(
  decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
): "approve" | "deny" {
  return decision === "deny" ? "deny" : "approve";
}
