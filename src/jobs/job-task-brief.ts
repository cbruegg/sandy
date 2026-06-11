import type { JobDefinition } from "./job-validation.js";

export function buildJobTaskBrief(job: JobDefinition, workspacePath: string | null): string {
  return [
    `Run scheduled Sandy job "${job.name}" (${job.id}).`,
    `Use Sandy skill: ${job.skillId}.`,
    workspacePath ? `This recurring job has a persistent workspace directory on the host: ${workspacePath}` : null,
    workspacePath ? "The workspace is for durable notes, generated files, helper scripts, caches, and job state." : null,
    workspacePath ? "If you need to access that directory from the worker, request host directory access for it; Sandy has pre-approved read/write access for this job execution." : null,
    "If you can complete the job without user interaction, finish silently.",
    "If you need the user's attention or input, call the sandy.request_interaction MCP tool with an optional message explaining what you need. Sandy will promote the task to interactive mode so the user can see your output and respond.",
  ].filter((line): line is string => line !== null).join("\n\n");
}
