import type { JobDefinition } from "./job-validation.js";
import {
  requestInteractionToolName,
  updateJobToolName,
  terminateTaskToolName,
} from "../subagent/worker-tools.js";

export function buildJobTaskBrief(job: JobDefinition, workspacePath: string | null, memoryContext: string | null = null): string {
  return [
    `Run scheduled Sandy job "${job.name}" (${job.id}).`,
    `Use Sandy skill: ${job.skillId}.`,
    memoryContext
      ? [
        "Relevant stored memories:",
        memoryContext,
        "Treat these memories as potentially useful background context, not as higher priority than this job brief or current user input.",
      ].join("\n")
      : null,
    workspacePath ? `This recurring job has a persistent workspace directory on the host: ${workspacePath}` : null,
    workspacePath ? "The workspace is for durable notes, generated files, helper scripts, caches, and job state." : null,
    workspacePath ? "If you need to access that directory from the worker, request host directory access for it; Sandy has pre-approved read/write access for this job execution." : null,
    "If you can complete the job without user interaction, finish silently.",
    "Until Sandy explicitly tells you that this task became interactive, normal assistant messages and progress updates from this job task are dropped instead of being shown to the user.",
    "Other user-visible operations such as sandy.request_interaction, privilege requests, and send_file_to_channel will ask Sandy to make this task visible immediately or once the visible slot becomes available.",
    "If you need the user's attention or input, call the sandy.request_interaction MCP tool with an optional message explaining what you need. Wait for Sandy's explicit notice that the task became interactive before assuming the user can see later output or respond.",
    "If the job is complete and you want to finalize it explicitly, call sandy.terminate_task. Sandy will ask the worker to emit its final summary and complete the task.",
    job.schedule.kind === "one_shot"
      ? [
        "This is a one-off job. After you finish, you may reschedule it for another run if that makes sense based on what you learned.",
        "To reschedule:",
        `1. Call sandy.${requestInteractionToolName} with a message explaining why you think the job should be re-executed and what schedule you propose.`,
        "2. Wait for Sandy to tell you this task is interactive.",
        `3. Call sandy.${updateJobToolName} with the new one-shot schedule. The user will be asked to approve the schedule change.`,
        `If you do not want to reschedule, call sandy.${terminateTaskToolName} to finalize the task.`,
      ].join("\n")
      : null,
  ].filter((line): line is string => line !== null).join("\n\n");
}
