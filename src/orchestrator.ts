import { randomUUID } from "node:crypto";
import type { ChannelAdapter } from "./channel/channel-adapter.js";
import type { MainAgentController } from "./agent/main-agent-controller.js";
import type { PrivilegeBroker } from "./privilege/privilege-broker.js";
import { isSupportedPrivilegeRequest } from "./privilege/privilege-broker.js";
import type { SandboxHandle, SandboxRunner } from "./sandbox/sandbox-runner.js";
import type { SessionStore } from "./session/in-memory-session-store.js";
import { logger } from "./logger.js";
import { messages } from "./messages.js";
import type {
  MainAgentDecision,
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
};

export class SandyOrchestrator {
  private readonly handles = new Map<string, ActiveHandleRecord>();
  private readonly channelFormatting: ReturnType<ChannelAdapter["getFormatting"]>;

  constructor(private readonly deps: SandyOrchestratorDependencies) {
    this.channelFormatting = deps.channel.getFormatting();
  }

  async handleChatEvent(event: NormalizedChatEvent): Promise<void> {
    const session = this.deps.sessionStore.getOrCreate(event.chatId);
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
        case "progress":
          if (event.message.trim()) {
            await this.deps.channel.sendTaskUpdate(chatId, event.message);
          }
          break;
        case "assistant_output":
          session.activeTask.quarantinedOutputs.push(event.text);
          await this.deps.channel.sendTaskUpdate(chatId, event.text);
          break;
        case "tool_call":
          await this.routeWorkerToolCall(chatId, session, event.call);
          break;
        case "final_result":
          session.activeTask.quarantinedOutputs.push(event.text);
          await this.deps.channel.sendText(chatId, messages.taskComplete(event.text));
          await this.finishActiveTask(session, "completed");
          break;
        case "task_done":
          if (session.activeTask.status !== "completed") {
            await this.deps.channel.sendText(chatId, messages.taskCompleted(taskId));
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
          await this.finishActiveTask(session, "failed", { discardQuarantine: true });
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
      case "enable_mcp":
      case "enable_onecli":
        await this.presentPrivilegeRequestToUser(chatId, session, {
          requestId: randomUUID(),
          payload: call,
        });
        return;
    }

    assertNever(call); // would fail at compile-time
  }

  private async routeIdleChatEvent(session: SessionState, event: SupportedChatEvent): Promise<void> {
    switch (event.kind) {
      case "cancel_request":
        await this.deps.channel.sendText(event.chatId, messages.noActiveTaskToCancel());
        return;
      case "approval_response":
        if (session.pendingShareDeletion) {
          if (event.requestId && event.requestId !== session.pendingShareDeletion.requestId) {
            await this.deps.channel.sendText(event.chatId, messages.staleShareDeletionRequest());
            return;
          }
          await this.resolvePendingShareDeletion(session, event.decision);
          return;
        }
        await this.deps.channel.sendText(event.chatId, messages.noPendingPrivilegeRequest());
        return;
      case "danger_report":
        if (session.pendingQuarantinedOutputs.length === 0) {
          await this.deps.channel.sendText(event.chatId, messages.noActiveOutputToReport());
          return;
        }
        session.pendingQuarantinedOutputs = [];
        await this.deps.channel.sendText(event.chatId, messages.discardedPendingOutput());
        return;
      case "user_text":
        if (session.pendingShareDeletion) {
          await this.deps.channel.sendText(event.chatId, messages.shareDeletionStillPending());
          return;
        }
        {
          const newVisibleEntries = [
            ...this.releasePendingOutputs(session),
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
            activeTask: null,
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
      case "danger_report":
        if (activeTask.pendingPrivilegeRequest) {
          await this.cancelActiveTask(session, "Cancelled after the user reported a dangerous privilege request.");
          await this.deps.channel.sendText(event.chatId, messages.taskTerminatedAfterDangerousPrivilegeRequest(activeTask.taskName));
          return;
        }
        if (activeTask.quarantinedOutputs.length === 0) {
          await this.deps.channel.sendText(event.chatId, messages.noPendingOutputToReport());
          return;
        }
        await this.cancelActiveTask(session, "Cancelled after the user reported dangerous output.");
        await this.deps.channel.sendText(event.chatId, messages.taskTerminatedAndDiscarded(activeTask.taskName));
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
        this.releaseActiveTaskQuarantine(session);
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
        logger.info("task.launching", {
          chatId: event.chatId,
          taskId,
          taskName: decision.taskName,
        });
        session.activeTask = {
          taskId,
          taskName: decision.taskName,
          taskBrief: buildTaskBriefWithAttachments(decision.taskBrief, stagedAttachments),
          status: "running",
          startedAt: now,
          lastActivityAt: now,
          pendingPrivilegeRequest: null,
          quarantinedOutputs: [],
          approvedResourceIdentifiers: [],
          workerConnected: false,
        };

        const handle = await this.deps.sandboxRunner.launchTask(
          {
            chatId: event.chatId,
            taskId,
            taskName: decision.taskName,
            taskBrief: buildTaskBriefWithAttachments(decision.taskBrief, stagedAttachments),
            channelFormatting: this.channelFormatting,
          },
          async (subAgentEvent) => this.routeSubAgentEvent(event.chatId, taskId, subAgentEvent),
        );

        this.handles.set(taskId, { handle });
        logger.info("task.started", {
          chatId: event.chatId,
          taskId,
          taskName: decision.taskName,
        });

        await this.deps.channel.sendText(event.chatId, messages.taskStarted(decision.taskName));
        return;
      }
      default:
        assertNever(decision);
    }
  }

  private releaseActiveTaskQuarantine(session: SessionState): void {
    if (!session.activeTask || session.activeTask.quarantinedOutputs.length === 0) {
      return;
    }

    logger.info("task.quarantine_released", {
      chatId: session.chatId,
      taskId: session.activeTask.taskId,
      count: session.activeTask.quarantinedOutputs.length,
    });
    session.activeTask.quarantinedOutputs = [];
  }

  private releasePendingOutputs(session: SessionState): TranscriptEntry[] {
    if (session.pendingQuarantinedOutputs.length === 0) {
      return [];
    }

    logger.info("task.pending_quarantine_released", {
      chatId: session.chatId,
      count: session.pendingQuarantinedOutputs.length,
    });
    const timestamp = new Date().toISOString();
    const releasedEntries = session.pendingQuarantinedOutputs.map((text) => ({
      role: "assistant" as const,
      kind: "released_sub_agent_output",
      timestamp,
      text,
    }));
    session.pendingQuarantinedOutputs = [];
    return releasedEntries;
  }

  private async resolvePendingPrivilegeRequest(
    session: SessionState,
    request: PrivilegeRequest,
    decision: "approve" | "deny",
  ): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    let result: PrivilegeResolutionResult;
    if (decision === "deny") {
      result = {
        requestId: request.requestId,
        outcome: "denied",
        message: `The user denied privilege request ${request.requestId}.`,
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

    await this.requireHandle(activeTask.taskId).resolvePrivilege(result);
    await this.sendPrivilegeResolutionMessage(session.chatId, activeTask.taskId, result);

    activeTask.pendingPrivilegeRequest = null;
    activeTask.status = "running";
  }

  private async presentPrivilegeRequestToUser(chatId: string, session: SessionState, request: PrivilegeRequest): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    logger.info("task.privilege_requested", {
      chatId,
      taskId: activeTask.taskId,
      requestId: request.requestId,
      requestType: request.payload.type,
    });

    if (!isSupportedPrivilegeRequest(request.payload)) {
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
    return {
      requestId: request.requestId,
      outcome: "rejected",
      message: `Privilege request type "${request.payload.type}" is not supported by this runtime.`,
    };
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
        await this.deps.channel.sendText(chatId, messages.privilegeApproved(result.requestId, result.message));
        return;
      case "denied":
        await this.deps.channel.sendText(chatId, messages.privilegeDenied(result.requestId));
        return;
      case "rejected":
        await this.deps.channel.sendText(chatId, messages.privilegeRejected(result.requestId, result.message));
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
    await this.finishActiveTask(session, "failed", { discardQuarantine: true });
  }

  private async finishActiveTask(
    session: SessionState,
    status: ActiveTaskStatus,
    options?: { discardQuarantine?: boolean },
  ): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    activeTask.status = status;
    await this.closeActiveTask(session, options);
  }

  private async closeActiveTask(session: SessionState, options?: { discardQuarantine?: boolean }): Promise<void> {
    const task = session.activeTask;
    if (!task) {
      return;
    }
    const handle = this.handles.get(task.taskId)?.handle;
    if (handle) {
      await handle.close();
    }
    if (!options?.discardQuarantine && task.quarantinedOutputs.length > 0) {
      session.pendingQuarantinedOutputs.push(...task.quarantinedOutputs);
    }
    logger.info("task.cleared", {
      chatId: session.chatId,
      taskId: task.taskId,
      status: task.status,
    });
    this.handles.delete(task.taskId);
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
    await this.closeActiveTask(session, { discardQuarantine: true });
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
}

function assertNever(value: never): never {
  throw new Error(`Unhandled main agent decision: ${JSON.stringify(value)}`);
}
