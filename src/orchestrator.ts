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
import { toTaskMetadata } from "./types.js";

type ActiveHandleRecord = {
  handle: SandboxHandle;
};

export type SandyOrchestratorDependencies = {
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

    if (event.kind === "unsupported_input") {
      logger.warn("chat.unsupported_input", {
        chatId: event.chatId,
        inputType: event.inputType,
      });
      await this.deps.channel.sendText(event.chatId, messages.unsupportedInput(event.inputType));
      return;
    }

    if (!session.activeTask) {
      await this.handleIdleEvent(session, event);
      return;
    }

    await this.handleActiveTaskEvent(session, event);
    this.deps.sessionStore.save(session);
  }

  async handleSubAgentEvent(chatId: string, taskId: string, event: SubAgentEvent): Promise<void> {
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

    switch (event.type) {
      case "worker_connected":
        session.activeTask.workerConnected = true;
        break;
      case "worker_disconnected":
        session.activeTask.workerConnected = false;
        session.activeTask.status = "failed";
        await this.deps.channel.sendText(chatId, event.message);
        await this.clearTask(session);
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
      case "privilege_request":
        await this.handlePrivilegeRequest(chatId, session, event.request);
        break;
      case "final_result":
        session.activeTask.quarantinedOutputs.push(event.text);
        await this.deps.channel.sendText(chatId, messages.taskComplete(event.text));
        session.activeTask.status = "completed";
        await this.clearTask(session);
        break;
      case "task_done":
        if (session.activeTask.status !== "completed") {
          session.activeTask.status = "completed";
          await this.deps.channel.sendText(chatId, messages.taskCompleted(taskId));
          await this.clearTask(session);
        }
        break;
      case "task_error":
        session.activeTask.status = "failed";
        logger.error("task.failed", {
          chatId,
          taskId,
          message: event.message,
        });
        await this.deps.channel.sendText(chatId, messages.taskFailed(event.message));
        await this.clearTask(session);
        break;
    }

    this.deps.sessionStore.save(session);
  }

  private async handleIdleEvent(session: SessionState, event: Exclude<NormalizedChatEvent, { kind: "unsupported_input" }>): Promise<void> {
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
          await this.resolveShareDeletion(session, event.decision);
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
        const newVisibleEntries = [
          ...this.releasePendingOutputs(session),
          {
            role: "user" as const,
            kind: "user_text",
            timestamp: event.timestamp,
            text: event.text,
          },
        ];

        const decision = await this.deps.mainAgent.decide({
          chatId: event.chatId,
          newVisibleEntries,
          activeTask: null,
          channelFormatting: this.channelFormatting,
        });

        await this.applyMainAgentDecision(session, event.chatId, decision);
        this.deps.sessionStore.save(session);
        return;
    }
  }

  private async handleActiveTaskEvent(
    session: SessionState,
    event: Exclude<NormalizedChatEvent, { kind: "unsupported_input" }>,
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
        await this.resolvePrivilegeRequest(session, activeTask.pendingPrivilegeRequest, event.decision);
        return;
      case "user_text":
        if (activeTask.pendingPrivilegeRequest) {
          await this.deps.channel.sendText(event.chatId, messages.privilegeRequestStillPending());
          return;
        }
        this.discardAcceptedQuarantinedOutputs(session);
        await this.getHandle(activeTask.taskId).sendUserMessage(event.text);
        return;
    }
  }

  private async applyMainAgentDecision(
    session: SessionState,
    chatId: string,
    decision: MainAgentDecision,
  ): Promise<void> {
    switch (decision.action) {
      case "reply":
        logger.info("task.reply_direct", {
          chatId,
        });
        await this.deps.channel.sendText(chatId, decision.replyText);
        return;
      case "launch_task": {
        const taskId = randomUUID();
        const now = new Date().toISOString();
        logger.info("task.launching", {
          chatId,
          taskId,
          taskName: decision.taskName,
        });
        session.activeTask = {
          taskId,
          taskName: decision.taskName,
          taskBrief: decision.taskBrief,
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
            chatId,
            taskId,
            taskName: decision.taskName,
            taskBrief: decision.taskBrief,
            channelFormatting: this.channelFormatting,
          },
          async (event) => this.handleSubAgentEvent(chatId, taskId, event),
        );

        this.handles.set(taskId, { handle });
        logger.info("task.started", {
          chatId,
          taskId,
          taskName: decision.taskName,
        });

        await this.deps.channel.sendText(chatId, messages.taskStarted(decision.taskName));
        return;
      }
      default:
        assertNever(decision);
    }
  }

  private discardAcceptedQuarantinedOutputs(session: SessionState): void {
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

  private async resolvePrivilegeRequest(
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
    } else if (!isSupportedPrivilegeRequest(request)) {
      result = this.buildUnsupportedPrivilegeResult(request);
    } else {
      result = await this.deps.privilegeBroker.apply(request, {
        taskId: activeTask.taskId,
        taskSharePath: this.deps.sandboxRunner.getTaskSharePath(activeTask.taskId),
      });
    }

    await this.getHandle(activeTask.taskId).resolvePrivilege(result);
    await this.sendPrivilegeResolutionMessage(session.chatId, activeTask.taskId, result);

    activeTask.pendingPrivilegeRequest = null;
    activeTask.status = "running";
  }

  private async handlePrivilegeRequest(chatId: string, session: SessionState, request: PrivilegeRequest): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    logger.info("task.privilege_requested", {
      chatId,
      taskId: activeTask.taskId,
      requestId: request.requestId,
      requestType: request.type,
    });

    if (!isSupportedPrivilegeRequest(request)) {
      const result = this.buildUnsupportedPrivilegeResult(request);
      await this.getHandle(activeTask.taskId).resolvePrivilege(result);
      await this.sendPrivilegeResolutionMessage(chatId, activeTask.taskId, result);
      return;
    }

    activeTask.pendingPrivilegeRequest = request;
    activeTask.status = "awaiting_privilege_decision";
    await this.deps.channel.sendPrivilegeRequest(chatId, request);
  }

  private buildUnsupportedPrivilegeResult(request: PrivilegeRequest): PrivilegeResolutionResult {
    return {
      requestId: request.requestId,
      outcome: "rejected",
      message: `Privilege request type "${request.type}" is not supported by this runtime.`,
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
    await this.getHandle(activeTask.taskId).cancel(reason);
    await this.clearTask(session, { discardQuarantine: true });
  }

  private async clearTask(session: SessionState, options?: { discardQuarantine?: boolean }): Promise<void> {
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
    await this.prepareShareDeletion(session, task.taskId, task.taskName);
  }

  private getHandle(taskId: string): SandboxHandle {
    const record = this.handles.get(taskId);
    if (!record) {
      throw new Error(`No sandbox handle is registered for task ${taskId}.`);
    }
    return record.handle;
  }

  private async prepareShareDeletion(session: SessionState, taskId: string, taskName: string): Promise<void> {
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

  private async resolveShareDeletion(session: SessionState, decision: "approve" | "deny"): Promise<void> {
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

export function describeActiveTaskForMainAgent(session: SessionState) {
  return session.activeTask ? toTaskMetadata(session.activeTask) : null;
}
