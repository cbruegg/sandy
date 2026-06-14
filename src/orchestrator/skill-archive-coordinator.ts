import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import type { SkillService } from "../skills.js";
import type { JobStore } from "../jobs/job-store.js";
import type { SessionStore } from "../session/in-memory-session-store.js";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import type { SessionState } from "../types.js";
import type { ChatId } from "../types.js";
import type { PrivilegeRequest } from "../types.js";
import type { TaskCoordinator } from "./task-coordinator.js";

/**
 * Coordinates offering to archive a skill when it is no longer used by any
 * scheduled job.  Uses a session-level privilege request (approve/deny)
 * rather than a task-bound approval.
 */
export class SkillArchiveCoordinator {
  constructor(
    private readonly skillService: SkillService,
    private readonly jobStore: JobStore,
    private readonly sessionStore: SessionStore,
    private readonly channel: ChannelAdapter,
    private readonly taskCoordinator: TaskCoordinator,
  ) {}

  /**
   * Offers to archive `skillId` in `chatId` if it is no longer associated
   * with any job (enabled or disabled) other than the optionally excluded one.
   * The offer is sent as a privilege request that the user can approve or deny.
   *
   * When the chat's visible slot is busy the prompt is deferred and shown
   * once the slot frees.
   */
  async offerArchiveForJobSkill(chatId: ChatId, skillId: string, excludeJobId?: string): Promise<void> {
    try {
      // Skip if the skill directory does not exist (e.g. already deleted or never created).
      const skillDir = join(this.skillService.getSkillsDirectory(), skillId);
      if (!existsSync(skillDir)) {
        return;
      }

      const definitions = await this.jobStore.listDefinitions();
      const usedByOtherJob = definitions.some((d) => d.skillId === skillId && d.id !== excludeJobId);
      if (usedByOtherJob) {
        return;
      }

      const requestId = randomUUID();
      const request: PrivilegeRequest = {
        kind: "skill_archive",
        requestId,
        skillId,
      };

      const session = this.sessionStore.getOrCreate(chatId);
      if (session.pendingSkillArchiveRequest) {
        // Another archive request is already awaiting a decision for this chat.
        return;
      }

      if (this.taskCoordinator.isSlotAvailable(session)) {
        // Slot is free – send the request immediately.
        session.pendingSkillArchiveRequest = { requestId, skillId };
        await this.channel.sendPrivilegeRequest(chatId, request);
      } else {
        // Defer the prompt until the visible slot frees.
        this.taskCoordinator.scheduleSkillArchivePrompt(chatId, {
          requestId,
          skillId,
          request,
        });
      }
    } catch (error) {
      logger.error("skill_archive.offer_failed", error);
    }
  }

  /**
   * Applies the user's decision to the pending archive request.
   * Called by the orchestrator when an approval_response arrives.
   */
  async resolvePendingRequest(session: SessionState, decision: "approve" | "deny"): Promise<void> {
    const pending = session.pendingSkillArchiveRequest;
    if (!pending) {
      return;
    }

    session.pendingSkillArchiveRequest = null;

    if (decision === "deny") {
      await this.channel.sendText(session.chatId, messages.skillArchiveDenied(pending.skillId));
      await this.taskCoordinator.onVisibleSlotAvailable(session.chatId);
      return;
    }

    try {
      await this.skillService.archiveSkill(pending.skillId);
      await this.channel.sendText(session.chatId, messages.skillArchiveApproved(pending.skillId));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown archive failure.";
      logger.error("skill_archive.resolve_failed", error);
      await this.channel.sendText(session.chatId, messages.skillArchiveFailed(pending.skillId, detail));
    }

    await this.taskCoordinator.onVisibleSlotAvailable(session.chatId);
  }
}
