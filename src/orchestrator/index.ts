import { logger } from "../logger.js";
import { messages } from "../messages.js";
import { OrchestratorPrivileges } from "./privileges.js";
import { OrchestratorRuntimeState } from "./runtime-state.js";
import type { SandyOrchestratorDependencies, SupportedChatEvent } from "./shared.js";
import { OrchestratorTaskLifecycle, describeUserMessageForMainAgent } from "./task-lifecycle.js";
import { buildWorkerFollowUpInput } from "./worker-input.js";
import type {
  ChannelFormatting,
  MainAgentDecision,
  NormalizedChatEvent,
  SessionState,
} from "../types.js";
import type { JobService } from "../jobs/job-service.js";

export class SandyOrchestrator {
  private readonly channelFormatting: ChannelFormatting;
  private readonly runtimeState = new OrchestratorRuntimeState();
  private readonly taskLifecycle: OrchestratorTaskLifecycle;
  private readonly privileges: OrchestratorPrivileges;
  private readonly jobService: JobService | null;

  constructor(private readonly deps: SandyOrchestratorDependencies) {
    this.channelFormatting = deps.channel.getFormatting();
    this.taskLifecycle = new OrchestratorTaskLifecycle(deps, this.runtimeState, this.channelFormatting);
    this.jobService = deps.createJobService?.(async (job, chatId, workspacePath) =>
      await this.taskLifecycle.launchJobTask(job, chatId, workspacePath)) ?? null;
    this.privileges = new OrchestratorPrivileges(
      deps,
      this.runtimeState,
      this.jobService,
      this.taskLifecycle.failActiveTaskFromEventHandling.bind(this.taskLifecycle),
    );
  }

  async handleChatEvent(event: NormalizedChatEvent): Promise<void> {
    const session = this.deps.sessionStore.getOrCreate(event.chatId);
    try {
      logger.info("chat.event_handled", {
        chatId: event.chatId,
        kind: event.kind,
        hasActiveTask: session.activeTask !== null,
      });
      await this.jobService?.persistDefaultChatId(event.chatId);
      if (event.kind === "user_message") {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown chat event handling failure.";
      logger.error("chat.event_handler_failed", error, "Unknown chat event handling failure.", {
        chatId: event.chatId,
        kind: event.kind,
        hasActiveTask: session.activeTask !== null,
      });

      try {
        await this.deps.channel.sendText(event.chatId, messages.handlerFailed(message));
      } catch (notifyError) {
        logger.error("chat.event_failure_notification_failed", notifyError, "Unknown notification failure.", {
          chatId: event.chatId,
          kind: event.kind,
        });
      }
    }
  }

  async executeNativeWorkerToolCall(input: {
    taskId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<{ isError: boolean; message: string }> {
    return await this.privileges.executeNativeWorkerToolCall(input);
  }

  async startJobs(): Promise<void> {
    await this.jobService?.start();
  }

  stopJobs(): void {
    this.jobService?.stop();
  }

  async authorizeMcpToolCall(input: {
    taskId: string;
    serverId: string;
    toolName: string;
    arguments: unknown;
  }) {
    return await this.privileges.authorizeMcpToolCall(input);
  }

  async authorizeMcpResourceRead(input: {
    taskId: string;
    serverId: string;
    uri: string;
  }) {
    return await this.privileges.authorizeMcpResourceRead(input);
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
          await this.taskLifecycle.resolvePendingShareDeletion(session, event.decision === "deny" ? "deny" : "approve");
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
      case "user_message": {
        if (session.pendingShareDeletion) {
          await this.deps.channel.sendText(event.chatId, messages.shareDeletionStillPending());
          return;
        }

        const releasedEntries = this.taskLifecycle.releasePendingTaskSummaries(session);

        const newVisibleEntries = [
          ...releasedEntries,
          {
            role: "user" as const,
            kind: "user_message",
            timestamp: event.timestamp,
            text: describeUserMessageForMainAgent(event.text, event.attachments),
          },
        ];

        const decision: MainAgentDecision = await this.deps.mainAgent.decide({
          chatId: event.chatId,
          newVisibleEntries,
          activeTask: session.activeTask,
          channelFormatting: this.channelFormatting,
        });

        await this.taskLifecycle.executeMainAgentDecision(session, event, decision);
        return;
      }
    }
  }

  private async routeActiveTaskChatEvent(session: SessionState, event: SupportedChatEvent): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    switch (event.kind) {
      case "cancel_request":
        await this.taskLifecycle.cancelActiveTask(session, "Cancelled at the user's request.");
        await this.deps.channel.sendText(event.chatId, messages.taskCancelled(activeTask.taskName));
        return;
      case "mark_finished_request":
        if (activeTask.pendingPrivilegeRequest) {
          await this.deps.channel.sendText(event.chatId, messages.privilegeRequestStillPending());
          return;
        }
        await this.runtimeState.requireHandle(activeTask.taskId).markFinished();
        return;
      case "danger_report":
        logger.error("chat.unexpected_danger_report", null, undefined, {
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
        await this.privileges.resolvePendingPrivilegeRequest(session, activeTask.pendingPrivilegeRequest, event.decision);
        return;
      case "user_message": {
        if (activeTask.pendingPrivilegeRequest) {
          await this.deps.channel.sendText(event.chatId, messages.privilegeRequestStillPending());
          return;
        }
        const handle = this.runtimeState.requireHandle(activeTask.taskId);
        await handle.sendUserMessage(
          buildWorkerFollowUpInput(
            event.text,
            await this.taskLifecycle.stageAttachments(event.chatId, event.messageId, event.attachments, handle.getTaskSharePath()),
          ),
        );
        return;
      }
    }
  }
}
