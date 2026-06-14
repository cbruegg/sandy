import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import type { SkillService } from "../skills.js";
import type { JobStore } from "../jobs/job-store.js";
import type { SessionStore } from "../session/in-memory-session-store.js";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import type { ActiveTaskState, SessionState } from "../types.js";
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
      if (session.pendingPrompt?.kind === "skill_archive" && session.pendingPrompt.skillId === skillId) {
        return;
      }
      if (this.taskCoordinator.hasQueuedSkillArchivePrompt(chatId, skillId)) {
        return;
      }

      await this.taskCoordinator.showOrQueueSkillArchivePrompt(chatId, {
        requestId,
        skillId,
        request,
      });
    } catch (error) {
      logger.error("skill_archive.offer_failed", error);
    }
  }

  /**
   * Called after a launched-by-job task completes. Checks whether the one-shot
   * job has been consumed (not rescheduled to the future) and, if so, offers
   * to archive the associated skill when no other job still uses it.
   */
  async offerArchiveAfterTaskCompletion(session: SessionState, task: ActiveTaskState): Promise<void> {
    if (task.status !== "completed") {
      return;
    }
    if (task.origin.kind !== "launchedByJob") {
      return;
    }

    const job = await this.jobStore.getDefinition(task.origin.jobId);
    if (!job || job.schedule.kind !== "one_shot") {
      return;
    }

    const runtimeState = await this.jobStore.getRuntimeState(job.id);
    if (!runtimeState.lastRunAt) {
      return;
    }
    if (Date.parse(runtimeState.lastRunAt) < Date.parse(job.schedule.runAt)) {
      // Rescheduled to the future – the job will run again.
      return;
    }

    await this.offerArchiveForJobSkill(session.chatId, job.skillId, job.id);
  }

  /**
   * Applies the user's decision to the pending archive request.
   * Called by the orchestrator when an approval_response arrives.
   */
  async resolvePendingRequest(session: SessionState, decision: "approve" | "deny"): Promise<void> {
    await this.taskCoordinator.resolvePendingPrompt(session, "skill_archive", async (pending) => {
      if (pending.kind !== "skill_archive") {
        return;
      }

      if (decision === "deny") {
        await this.channel.sendText(session.chatId, messages.skillArchiveDenied(pending.skillId));
        return;
      }

      // Revalidate: another job may have started using the skill while the
      // archive prompt was awaiting the user's decision.
      const definitions = await this.jobStore.listDefinitions();
      const stillUsed = definitions.some((d) => d.skillId === pending.skillId);
      if (stillUsed) {
        await this.channel.sendText(session.chatId, messages.skillArchiveNoLongerEligible(pending.skillId));
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
    });
  }
}
