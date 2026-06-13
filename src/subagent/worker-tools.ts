import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { hostGrantsPrefix } from "../paths.js";

export const sandyMcpServerId = "sandy";

export type NativeWorkerToolCallResult = {
  isError: boolean;
  message: string;
};

// Infrastructure

type WorkerToolDefinition = Tool & {
  requiresPrivilegeEscalation: boolean;
  schema: z.ZodObject<z.core.$ZodLooseShape>;
};

function withoutTypeField(schema: z.ZodObject<z.core.$ZodLooseShape>): z.ZodObject<z.core.$ZodLooseShape> {
  const shape = {
    ...schema.shape,
  };
  delete shape["type"];
  return z.object(shape).strict();
}

function defineWorkerTool<TName extends string, TSchema extends z.ZodObject<z.core.$ZodLooseShape>>(
  name: TName,
  description: string,
  requiresPrivilegeEscalation: boolean,
  schema: TSchema,
) {
  return {
    name,
    description,
    requiresPrivilegeEscalation,
    schema,
    inputSchema: z.toJSONSchema(withoutTypeField(schema)) as Tool["inputSchema"],
  };
}

// Tool definitions

const copyIntoShareToolName = "copy_into_share";
const copyOutOfShareToolName = "copy_out_of_share";
const sendFileToChannelToolName = "send_file_to_channel";
const requestHttpTokenToolName = "request_http_token";
const requestHostDirectoryAccessToolName = "request_host_directory_access";
const requestInteractionToolName = "request_interaction";
const terminateTaskToolName = "terminate_task";
const createSkillToolName = "create_skill";
const updateSkillToolName = "update_skill";
const deleteSkillToolName = "delete_skill";
const listJobsToolName = "list_jobs";
const getJobToolName = "get_job";
const createJobToolName = "create_job";
const updateJobToolName = "update_job";
const deleteJobToolName = "delete_job";
const enableJobToolName = "enable_job";
const disableJobToolName = "disable_job";
const runJobNowToolName = "run_job_now";

const interactiveTaskGuidance = "User-launched tasks are already interactive.";
const scheduledJobVisibilityGuidance = "Scheduled job tasks must call sandy.request_interaction and wait until Sandy says the task became interactive before using this tool.";

const copyIntoShareSchema = z.object({
  type: z.literal(copyIntoShareToolName),
  sourcePath: z.string(),
  targetPath: z.string(),
  reason: z.string(),
}).strict();

const copyOutOfShareSchema = z.object({
  type: z.literal(copyOutOfShareToolName),
  sourcePath: z.string(),
  targetPath: z.string(),
  reason: z.string(),
}).strict();

export type FileCopyWorkerToolPayload =
  | z.infer<typeof copyIntoShareSchema>
  | z.infer<typeof copyOutOfShareSchema>;

const sendFileToChannelSchema = z.object({
  type: z.literal(sendFileToChannelToolName),
  path: z.string(),
  caption: z.string().optional(),
}).strict();

const requestHttpTokenSchema = z.object({
  type: z.literal(requestHttpTokenToolName),
  tokenId: z.string(),
  host: z.string(),
  reason: z.string(),
}).strict();

const requestHostDirectoryAccessSchema = z.object({
  type: z.literal(requestHostDirectoryAccessToolName),
  path: z.string(),
  level: z.enum(["read_only", "read_write"]),
}).strict();

const requestInteractionSchema = z.object({
  type: z.literal(requestInteractionToolName),
  message: z.string().optional(),
}).strict();

const terminateTaskSchema = z.object({
  type: z.literal(terminateTaskToolName),
}).strict();

const createSkillSchema = z.object({
  type: z.literal(createSkillToolName),
  skillId: z.string(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
}).strict();

const updateSkillSchema = z.object({
  type: z.literal(updateSkillToolName),
  skillId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  body: z.string().optional(),
}).strict();

const deleteSkillSchema = z.object({
  type: z.literal(deleteSkillToolName),
  skillId: z.string(),
}).strict();

const jobScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("one_shot"), runAt: z.string() }).strict(),
  z.object({ kind: z.literal("cron"), expression: z.string(), timezone: z.string().optional() }).strict(),
]);

const jobDefinitionInputSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  schedule: jobScheduleSchema,
  skillId: z.string(),
}).strict();

const listJobsSchema = z.object({ type: z.literal(listJobsToolName) }).strict();
const getJobSchema = z.object({ type: z.literal(getJobToolName), jobId: z.string() }).strict();
const createJobSchema = z.object({ type: z.literal(createJobToolName), definition: jobDefinitionInputSchema }).strict();
const updateJobSchema = z.object({ type: z.literal(updateJobToolName), definition: jobDefinitionInputSchema }).strict();
const deleteJobSchema = z.object({ type: z.literal(deleteJobToolName), jobId: z.string() }).strict();
const enableJobSchema = z.object({ type: z.literal(enableJobToolName), jobId: z.string() }).strict();
const disableJobSchema = z.object({ type: z.literal(disableJobToolName), jobId: z.string() }).strict();
const runJobNowSchema = z.object({ type: z.literal(runJobNowToolName), jobId: z.string() }).strict();

export const workerToolEntries = [
  defineWorkerTool(
    copyIntoShareToolName,
    "Ask the host to copy a file or directory from an absolute host path into the shared workspace.",
    true,
    copyIntoShareSchema,
  ),
  defineWorkerTool(
    copyOutOfShareToolName,
    "Ask the host to copy a file or directory from the shared workspace to an absolute host path.",
    true,
    copyOutOfShareSchema,
  ),
  defineWorkerTool(
    sendFileToChannelToolName,
    `Send a file from the shared workspace to the user as a chat attachment. Use this when the user asks you to send, share, or upload a file. ${interactiveTaskGuidance} ${scheduledJobVisibilityGuidance}`,
    false,
    sendFileToChannelSchema,
  ),
  defineWorkerTool(
    requestHttpTokenToolName,
    `Ask the host for permission to use a preconfigured HTTP token. Emit this tool call directly instead of asking the user in plain text. You must request approval before making HTTP requests that use placeholder headers like 'Authorization: Bearer SANDY_TOKEN_<tokenId>'. The host will inject the real token value into proxied HTTP requests if approved. ${interactiveTaskGuidance} ${scheduledJobVisibilityGuidance}`,
    true,
    requestHttpTokenSchema,
  ),
  defineWorkerTool(
    requestHostDirectoryAccessToolName,
    `Ask the host for permission to access a directory on the host filesystem. Emit this tool call directly instead of asking the user in plain text. The host will mount the approved directory inside ${hostGrantsPrefix}/ if approved. ${interactiveTaskGuidance} Scheduled job tasks may use this silently for pre-approved directories such as the job workspace, but must call sandy.request_interaction and wait until Sandy says the task became interactive before requesting directory access that still needs user approval.`,
    true,
    requestHostDirectoryAccessSchema,
  ),
  defineWorkerTool(
    requestInteractionToolName,
    "Request interactive mode for a scheduled job task. Use this when a scheduled job needs the user's attention or input to continue. The host will promote the task so the user can see your output and respond. Provide an optional message explaining what you need from the user. This tool has no effect on user-launched tasks that are already interactive.",
    false,
    requestInteractionSchema,
  ),
  defineWorkerTool(
    terminateTaskToolName,
    "Terminate this scheduled job task, finalizing it with any pending summary. Call this when a scheduled job can be completed without further user interaction. The host will ask the worker to emit a final summary and then close the task. This tool has no effect on user-launched tasks.",
    false,
    terminateTaskSchema,
  ),
  defineWorkerTool(
    createSkillToolName,
    `Ask the host to create a new Sandy skill. Provide the skillId, name, description, and body. It is not necessary to write any files to disk. ${interactiveTaskGuidance} ${scheduledJobVisibilityGuidance}`,
    true,
    createSkillSchema,
  ),
  defineWorkerTool(
    updateSkillToolName,
    `Ask the host to update an existing Sandy skill. Provide the skillId, name, description, and body. It is not necessary to write any files to disk. ${interactiveTaskGuidance} ${scheduledJobVisibilityGuidance}`,
    true,
    updateSkillSchema,
  ),
  defineWorkerTool(
    deleteSkillToolName,
    `Ask the host to delete an existing Sandy skill. Provide the skillId. ${interactiveTaskGuidance} ${scheduledJobVisibilityGuidance}`,
    true,
    deleteSkillSchema,
  ),
  defineWorkerTool(listJobsToolName, "List scheduled Sandy jobs.", false, listJobsSchema),
  defineWorkerTool(getJobToolName, "Inspect one scheduled Sandy job.", false, getJobSchema),
  defineWorkerTool(createJobToolName, `Ask the host to create a scheduled Sandy job. ${interactiveTaskGuidance} ${scheduledJobVisibilityGuidance}`, true, createJobSchema),
  defineWorkerTool(updateJobToolName, `Ask the host to replace a scheduled Sandy job definition. ${interactiveTaskGuidance} ${scheduledJobVisibilityGuidance}`, true, updateJobSchema),
  defineWorkerTool(deleteJobToolName, `Ask the host to delete a scheduled Sandy job. ${interactiveTaskGuidance} ${scheduledJobVisibilityGuidance}`, true, deleteJobSchema),
  defineWorkerTool(enableJobToolName, `Ask the host to enable a scheduled Sandy job. ${interactiveTaskGuidance} ${scheduledJobVisibilityGuidance}`, true, enableJobSchema),
  defineWorkerTool(disableJobToolName, `Ask the host to disable a scheduled Sandy job. ${interactiveTaskGuidance} ${scheduledJobVisibilityGuidance}`, true, disableJobSchema),
  defineWorkerTool(runJobNowToolName, `Ask the host to run a scheduled Sandy job now. ${interactiveTaskGuidance} ${scheduledJobVisibilityGuidance}`, true, runJobNowSchema),
] as const satisfies readonly WorkerToolDefinition[];

// Public API

export type WorkerToolPayload =
  | z.infer<typeof copyIntoShareSchema>
  | z.infer<typeof copyOutOfShareSchema>
  | z.infer<typeof sendFileToChannelSchema>
  | z.infer<typeof requestHttpTokenSchema>
  | z.infer<typeof requestHostDirectoryAccessSchema>
  | z.infer<typeof requestInteractionSchema>
  | z.infer<typeof terminateTaskSchema>
  | z.infer<typeof createSkillSchema>
  | z.infer<typeof updateSkillSchema>
  | z.infer<typeof deleteSkillSchema>
  | z.infer<typeof listJobsSchema>
  | z.infer<typeof getJobSchema>
  | z.infer<typeof createJobSchema>
  | z.infer<typeof updateJobSchema>
  | z.infer<typeof deleteJobSchema>
  | z.infer<typeof enableJobSchema>
  | z.infer<typeof disableJobSchema>
  | z.infer<typeof runJobNowSchema>;

export function parseWorkerToolPayload(name: string, argumentsValue: unknown): WorkerToolPayload {
  const definition = workerToolEntries.find((entry) => entry.name === name);
  if (!definition) {
    throw new Error(`Unsupported Sandy tool ${name}.`);
  }
  if (argumentsValue !== undefined && (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue))) {
    throw new Error("Tool arguments must be a JSON object.");
  }
  return definition.schema.parse({
    ...(argumentsValue as Record<string, unknown> | undefined),
    type: name,
  });
}
