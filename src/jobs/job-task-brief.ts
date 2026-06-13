import type { JobDefinition } from "./job-validation.js";

export function buildJobTaskBrief(job: JobDefinition, workspacePath: string | null): string {
  return [
    `Run scheduled Sandy job "${job.name}" (${job.id}).`,
    `Use Sandy skill: ${job.skillId}.`,
    workspacePath ? `This recurring job has a persistent workspace directory on the host: ${workspacePath}` : null,
    workspacePath ? "The workspace is for durable notes, generated files, helper scripts, caches, and job state." : null,
    workspacePath ? "If you need to access that directory from the worker, request host directory access for it; Sandy has pre-approved read/write access for this job execution." : null,
    "If you can complete the job without user interaction, finish silently.",
    "Until Sandy explicitly tells you that this task became interactive, normal assistant messages and progress updates from this job task are dropped instead of being shown to the user.",
    "Other user-visible operations such as privilege requests and send_file_to_channel fail until Sandy has made this task interactive.",
    "If you need the user's attention or input, call the sandy.request_interaction MCP tool with an optional message explaining what you need. Wait for Sandy's explicit notice that the task became interactive before assuming the user can see later output or respond.",
    "If the job is complete and you want to finalize it explicitly, call sandy.terminate_task. Sandy will ask the worker to emit its final summary and complete the task.",
  ].filter((line): line is string => line !== null).join("\n\n");
}
