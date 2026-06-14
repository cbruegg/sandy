import { logger } from "../logger.js";
import { messages } from "../messages.js";
import { assertNever } from "../assert-never.js";
import type { SandyOrchestratorDependencies, SupportedChatEvent } from "./shared.js";
import { describeUserMessageForMainAgent } from "./task-lifecycle.js";
import { buildWorkerFollowUpInput } from "./worker-input.js";
import type {
  ChannelFormatting,
  MainAgentDecision,
  NormalizedChatEvent,
  SessionState,
} from "../types.js";
import type { SkillArchiveCoordinator } from "./skill-archive-coordinator.js";

export class SandyOrchestrator {
  private readonly channelFormatting: ChannelFormatting;
  private readonly skillArchiveCoordinator: SkillArchiveCoordinator;

  constructor(private readonly deps: SandyOrchestratorDependencies) {
    this.channelFormatting = deps.channelFormatting;
    this.skillArchiveCoordinator = deps.skillArchiveCoordinator;
  }

  async handleChatEvent(event: NormalizedChatEvent): Promise<void> {
    const session = this.deps.sessionStore.getOrCreate(event.chatId);
    try {
      logger.info("chat.event_handled", {
        chatId: event.chatId,
        kind: event.kind,
        hasVisibleTask: session.visibleTask !== null,
      });
      await this.deps.destinationStore.setDefaultChatId(event.chatId);
      this.deps.taskCoordinator.onUserInteraction(event.chatId);
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

      if (!session.visibleTask) {
        await this.routeIdleChatEvent(session, event);
        return;
      }

      await this.routeActiveTaskChatEvent(session, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown chat event handling failure.";
      logger.error("chat.event_handler_failed", error, "Unknown chat event handling failure.", {
        chatId: event.chatId,
        kind: event.kind,
        hasVisibleTask: session.visibleTask !== null,
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
    return await this.deps.privileges.executeNativeWorkerToolCall(input);
  }

  async authorizeMcpToolCall(input: {
    taskId: string;
    serverId: string;
    toolName: string;
    arguments: unknown;
  }) {
    return await this.deps.privileges.authorizeMcpToolCall(input);
  }

  async authorizeMcpResourceRead(input: {
    taskId: string;
    serverId: string;
    uri: string;
  }) {
    return await this.deps.privileges.authorizeMcpResourceRead(input);
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
        if (session.pendingPrompt) {
          if (event.requestId && event.requestId !== session.pendingPrompt.requestId) {
            const staleMessage = session.pendingPrompt.kind === "share_deletion"
              ? messages.staleShareDeletionRequest()
              : messages.staleSkillArchiveRequest();
            await this.deps.channel.sendText(event.chatId, staleMessage);
            return;
          }
          if (session.pendingPrompt.kind === "share_deletion") {
            await this.deps.taskLifecycle.resolvePendingShareDeletion(session, event.decision === "deny" ? "deny" : "approve");
          } else {
            await this.skillArchiveCoordinator.resolvePendingRequest(session, event.decision === "deny" ? "deny" : "approve");
          }
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
        if (session.pendingPrompt) {
          await this.deps.channel.sendText(event.chatId, messages.promptStillPending());
          return;
        }

        const releasedEntries = this.deps.taskLifecycle.releasePendingTaskSummaries(session);

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
          activeTask: session.visibleTask,
          channelFormatting: this.channelFormatting,
        });

        await this.deps.taskLifecycle.executeMainAgentDecision(session, event, decision);
        return;
      }
      default:
        assertNever(event);
    }
  }

  private async routeActiveTaskChatEvent(session: SessionState, event: SupportedChatEvent): Promise<void> {
    const activeTask = session.visibleTask;
    if (!activeTask) {
      return;
    }

    switch (event.kind) {
      case "cancel_request":
        await this.deps.taskLifecycle.cancelActiveTask(session, "Cancelled at the user's request.");
        await this.deps.channel.sendText(event.chatId, messages.taskCancelled(activeTask.taskName));
        return;
      case "mark_finished_request":
        if (activeTask.pendingPrivilegeRequest) {
          await this.deps.channel.sendText(event.chatId, messages.privilegeRequestStillPending());
          return;
        }
        await this.deps.taskLifecycle.markActiveTaskFinished(activeTask.taskId);
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
        await this.deps.privileges.resolvePendingPrivilegeRequest(session, activeTask.pendingPrivilegeRequest, event.decision);
        return;
      case "user_message": {
        if (activeTask.pendingPrivilegeRequest) {
          await this.deps.channel.sendText(event.chatId, messages.privilegeRequestStillPending());
          return;
        }
        const handle = this.deps.taskLifecycle.requireActiveTaskHandle(activeTask.taskId);
        await handle.sendUserMessage(
          buildWorkerFollowUpInput(
            event.text,
            await this.deps.taskLifecycle.stageAttachments(event.chatId, event.messageId, event.attachments, handle.getTaskSharePath()),
          ),
        );
        return;
      }
      default:
        assertNever(event);
    }
  }
}
