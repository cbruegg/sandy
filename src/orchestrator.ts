import { randomUUID } from "node:crypto";
import type { ChannelAdapter } from "./channel/channel-adapter.js";
import type { MainAgentController } from "./agent/main-agent-controller.js";
import type { SandboxHandle, SandboxRunner } from "./sandbox/sandbox-runner.js";
import type { SessionStore } from "./session/in-memory-session-store.js";
import { logger } from "./logger.js";
import type {
  MainAgentDecision,
  NormalizedChatEvent,
  PrivilegeRequest,
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
};

export class SandyOrchestrator {
  private readonly handles = new Map<string, ActiveHandleRecord>();

  constructor(private readonly deps: SandyOrchestratorDependencies) {}

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
      await this.deps.channel.sendText(
        event.chatId,
        `This v1 build only supports text messages. Received unsupported ${event.inputType} input.`,
      );
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
        this.clearTask(session);
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
        session.activeTask.pendingPrivilegeRequest = event.request;
        session.activeTask.status = "awaiting_privilege_decision";
        logger.info("task.privilege_requested", {
          chatId,
          taskId,
          requestId: event.request.requestId,
          requestType: event.request.type,
        });
        await this.deps.channel.sendPrivilegeRequest(chatId, event.request);
        break;
      case "final_result":
        this.appendTranscript(session, {
          role: "assistant",
          kind: "task_final_result",
          timestamp: new Date().toISOString(),
          text: event.text,
        });
        await this.deps.channel.sendText(chatId, `Task complete:\n${event.text}`);
        session.activeTask.status = "completed";
        this.clearTask(session);
        break;
      case "task_done":
        if (session.activeTask.status !== "completed") {
          session.activeTask.status = "completed";
          await this.deps.channel.sendText(chatId, `Task "${taskId}" completed.`);
          this.clearTask(session);
        }
        break;
      case "task_error":
        session.activeTask.status = "failed";
        logger.error("task.failed", {
          chatId,
          taskId,
          message: event.message,
        });
        await this.deps.channel.sendText(chatId, `Task failed: ${event.message}`);
        this.clearTask(session);
        break;
    }

    this.deps.sessionStore.save(session);
  }

  private async handleIdleEvent(session: SessionState, event: Exclude<NormalizedChatEvent, { kind: "unsupported_input" }>): Promise<void> {
    switch (event.kind) {
      case "cancel_request":
        await this.deps.channel.sendText(event.chatId, "There is no active task to cancel.");
        return;
      case "approval_response":
        await this.deps.channel.sendText(event.chatId, "There is no pending privilege request.");
        return;
      case "danger_report":
        if (session.pendingQuarantinedOutputs.length === 0) {
          await this.deps.channel.sendText(event.chatId, "There is no active sub-agent output to report.");
          return;
        }
        session.pendingQuarantinedOutputs = [];
        await this.deps.channel.sendText(event.chatId, "Discarded the pending sub-agent output.");
        return;
      case "user_text":
        this.releasePendingOutputs(session);
        this.appendTranscript(session, {
          role: "user",
          kind: "user_text",
          timestamp: event.timestamp,
          text: event.text,
        });

        const decision = await this.deps.mainAgent.decide({
          chatId: event.chatId,
          transcript: session.transcript,
          activeTask: null,
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
        await this.deps.channel.sendText(event.chatId, `Cancelled task "${activeTask.taskName}".`);
        return;
      case "danger_report":
        if (activeTask.quarantinedOutputs.length === 0) {
          await this.deps.channel.sendText(event.chatId, "There is no pending sub-agent output to report.");
          return;
        }
        await this.cancelActiveTask(session, "Cancelled after the user reported dangerous output.");
        await this.deps.channel.sendText(
          event.chatId,
          `Terminated task "${activeTask.taskName}" and discarded the pending sub-agent output.`,
        );
        return;
      case "approval_response":
        if (!activeTask.pendingPrivilegeRequest) {
          await this.deps.channel.sendText(event.chatId, "There is no pending privilege request.");
          return;
        }
        if (event.requestId && event.requestId !== activeTask.pendingPrivilegeRequest.requestId) {
          await this.deps.channel.sendText(event.chatId, "That privilege request is no longer pending.");
          return;
        }
        await this.resolvePrivilegeRequest(session, activeTask.pendingPrivilegeRequest, event.decision);
        return;
      case "user_text":
        if (activeTask.pendingPrivilegeRequest) {
          await this.deps.channel.sendText(
            event.chatId,
            "A privilege request is pending. Reply with approve or deny before sending more task input.",
          );
          return;
        }
        this.releaseQuarantinedOutputs(session);
        this.appendTranscript(session, {
          role: "user",
          kind: "user_text",
          timestamp: event.timestamp,
          text: event.text,
        });
        await this.getHandle(activeTask.taskId).sendUserMessage(event.text);
        return;
    }
  }

  private async applyMainAgentDecision(
    session: SessionState,
    chatId: string,
    decision: MainAgentDecision,
  ): Promise<void> {
    if (decision.action === "reply") {
      logger.info("task.reply_direct", {
        chatId,
      });
      this.appendTranscript(session, {
        role: "assistant",
        kind: "main_agent_reply",
        timestamp: new Date().toISOString(),
        text: decision.replyText,
      });
      await this.deps.channel.sendText(chatId, decision.replyText);
      return;
    }

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

    this.appendTranscript(session, {
      role: "system",
      kind: "task_started",
      timestamp: now,
      metadata: {
        taskId,
        taskName: decision.taskName,
      },
    });

    const handle = await this.deps.sandboxRunner.launchTask(
      {
        chatId,
        taskId,
        taskName: decision.taskName,
        taskBrief: decision.taskBrief,
        transcript: session.transcript,
      },
      async (event) => this.handleSubAgentEvent(chatId, taskId, event),
    );

    this.handles.set(taskId, { handle });
    logger.info("task.started", {
      chatId,
      taskId,
      taskName: decision.taskName,
    });

    await this.deps.channel.sendText(
      chatId,
      `Started task "${decision.taskName}". You will receive progress updates here.`,
    );
  }

  private releaseQuarantinedOutputs(session: SessionState): void {
    if (!session.activeTask || session.activeTask.quarantinedOutputs.length === 0) {
      return;
    }

    logger.info("task.quarantine_released", {
      chatId: session.chatId,
      taskId: session.activeTask.taskId,
      count: session.activeTask.quarantinedOutputs.length,
    });
    const timestamp = new Date().toISOString();
    for (const text of session.activeTask.quarantinedOutputs) {
      this.appendTranscript(session, {
        role: "assistant",
        kind: "released_sub_agent_output",
        timestamp,
        text,
      });
    }
    session.activeTask.quarantinedOutputs = [];
  }

  private releasePendingOutputs(session: SessionState): void {
    if (session.pendingQuarantinedOutputs.length === 0) {
      return;
    }

    logger.info("task.pending_quarantine_released", {
      chatId: session.chatId,
      count: session.pendingQuarantinedOutputs.length,
    });
    const timestamp = new Date().toISOString();
    for (const text of session.pendingQuarantinedOutputs) {
      this.appendTranscript(session, {
        role: "assistant",
        kind: "released_sub_agent_output",
        timestamp,
        text,
      });
    }
    session.pendingQuarantinedOutputs = [];
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

    await this.getHandle(activeTask.taskId).resolvePrivilege(request.requestId, decision);

    if (decision === "approve") {
      if (request.type === "enable_mcp" || request.type === "enable_onecli") {
        activeTask.approvedResourceIdentifiers.push(request.identifier);
      }
      logger.info("task.privilege_resolved", {
        chatId: session.chatId,
        taskId: activeTask.taskId,
        requestId: request.requestId,
        decision,
      });
      await this.deps.channel.sendText(session.chatId, `Approved privilege request ${request.requestId}.`);
    } else {
      logger.info("task.privilege_resolved", {
        chatId: session.chatId,
        taskId: activeTask.taskId,
        requestId: request.requestId,
        decision,
      });
      await this.deps.channel.sendText(session.chatId, `Denied privilege request ${request.requestId}.`);
    }

    activeTask.pendingPrivilegeRequest = null;
    activeTask.status = "running";
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
    this.appendTranscript(session, {
      role: "system",
      kind: "task_cancelled",
      timestamp: new Date().toISOString(),
      metadata: {
        taskId: activeTask.taskId,
        reason,
      },
    });
    this.clearTask(session);
  }

  private clearTask(session: SessionState): void {
    if (!session.activeTask) {
      return;
    }
    if (session.activeTask.quarantinedOutputs.length > 0) {
      session.pendingQuarantinedOutputs.push(...session.activeTask.quarantinedOutputs);
    }
    logger.info("task.cleared", {
      chatId: session.chatId,
      taskId: session.activeTask.taskId,
      status: session.activeTask.status,
    });
    this.handles.delete(session.activeTask.taskId);
    session.activeTask = null;
  }

  private getHandle(taskId: string): SandboxHandle {
    const record = this.handles.get(taskId);
    if (!record) {
      throw new Error(`No sandbox handle is registered for task ${taskId}.`);
    }
    return record.handle;
  }

  private appendTranscript(session: SessionState, entry: TranscriptEntry): void {
    session.transcript.push(entry);
  }
}

export function describeActiveTaskForMainAgent(session: SessionState) {
  return session.activeTask ? toTaskMetadata(session.activeTask) : null;
}
