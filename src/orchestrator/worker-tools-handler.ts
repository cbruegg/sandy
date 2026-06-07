import { randomUUID } from "node:crypto";
import { messages } from "../messages.js";
import type { JobService } from "../jobs/job-service.js";
import type { SkillService } from "../skills.js";
import type { NormalizedChatEvent, PrivilegeRequest, PrivilegeResolutionResult } from "../types.js";

type ApprovalDecision = Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"];

export class WorkerToolsHandler {
  constructor(
    private readonly skillService: SkillService,
    private readonly jobService: JobService | null,
  ) {}

  async listJobs(): Promise<PrivilegeResolutionResult> {
    return {
      requestId: randomUUID(),
      outcome: "approved",
      message: JSON.stringify(await this.requireJobService().listJobs(), null, 2),
    };
  }

  async getJob(jobId: string): Promise<PrivilegeResolutionResult> {
    const job = await this.requireJobService().getJob(jobId);
    return {
      requestId: randomUUID(),
      outcome: job ? "approved" : "failed",
      message: job ? JSON.stringify(job, null, 2) : `Job ${jobId} does not exist.`,
    };
  }

  async resolveSkillMutation(
    request: Extract<PrivilegeRequest, { kind: "skill_mutation" }>,
    decision: ApprovalDecision,
    taskNoLongerActiveMessage: string | null,
  ): Promise<PrivilegeResolutionResult> {
    if (taskNoLongerActiveMessage) {
      return { requestId: request.requestId, outcome: "failed", message: taskNoLongerActiveMessage };
    }

    if (decision !== "approve") {
      return {
        requestId: request.requestId,
        outcome: "denied",
        message: messages.skillMutationDenied(request.operation, request.skillId),
      };
    }

    try {
      if (request.operation === "create") {
        await this.skillService.createSkill({
          skillId: request.skillId,
          name: request.name ?? "",
          description: request.description ?? "",
          body: request.body ?? "",
        });
      } else if (request.operation === "update") {
        await this.skillService.updateSkill({
          skillId: request.skillId,
          ...(request.name !== undefined ? { name: request.name } : {}),
          ...(request.description !== undefined ? { description: request.description } : {}),
          ...(request.body !== undefined ? { body: request.body } : {}),
        });
      } else if (request.operation === "delete") {
        await this.skillService.deleteSkill({ skillId: request.skillId });
      }
      return {
        requestId: request.requestId,
        outcome: "approved",
        message: messages.skillMutationApproved(request.operation, request.skillId),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown skill mutation failure.";
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.skillMutationFailed(request.operation, request.skillId, detail),
      };
    }
  }

  async resolveJobMutation(
    request: Extract<PrivilegeRequest, { kind: "job_mutation" }>,
    decision: ApprovalDecision,
    taskNoLongerActiveMessage: string | null,
  ): Promise<PrivilegeResolutionResult> {
    if (taskNoLongerActiveMessage) {
      return { requestId: request.requestId, outcome: "failed", message: taskNoLongerActiveMessage };
    }

    const { operation, jobId } = request.mutation;
    if (decision !== "approve") {
      return { requestId: request.requestId, outcome: "denied", message: messages.jobMutationDenied(operation, jobId) };
    }

    try {
      const detail = await this.requireJobService().applyMutation(request.mutation);
      return { requestId: request.requestId, outcome: "approved", message: `${messages.jobMutationApproved(operation, jobId)} ${detail}` };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown job mutation failure.";
      return { requestId: request.requestId, outcome: "failed", message: messages.jobMutationFailed(operation, jobId, detail) };
    }
  }

  private requireJobService(): JobService {
    if (!this.jobService) throw new Error("Scheduled jobs are not available in this Sandy runtime.");
    return this.jobService;
  }
}
