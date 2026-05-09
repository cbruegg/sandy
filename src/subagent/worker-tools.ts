import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { hostGrantsPrefix } from "../paths.js";

export const sandyMcpServerId = "sandy";

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
const completeTaskToolName = "complete_task";
const requestHttpTokenToolName = "request_http_token";
const requestHostDirectoryAccessToolName = "request_host_directory_access";

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

const sendFileToChannelSchema = z.object({
  type: z.literal(sendFileToChannelToolName),
  path: z.string(),
  caption: z.string().optional(),
}).strict();

const completeTaskSchema = z.object({
  type: z.literal(completeTaskToolName),
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
    "Send a file from the shared workspace to the user as a chat attachment. Use this when the user asks you to send, share, or upload a file.",
    false,
    sendFileToChannelSchema,
  ),
  defineWorkerTool(
    completeTaskToolName,
    "Signal to the host that the tasks the user stated so far are fully complete. You *must* emit this at the very end, but only after you have emitted the last user-facing message.",
    false,
    completeTaskSchema,
  ),
  defineWorkerTool(
    requestHttpTokenToolName,
    "Ask the host for permission to use a preconfigured HTTP token. Emit this tool call directly instead of asking the user in plain text. You must request approval before making HTTP requests that use placeholder headers like 'Authorization: Bearer SANDY_TOKEN_<tokenId>'. The host will inject the real token value into proxied HTTP requests if approved.",
    true,
    requestHttpTokenSchema,
  ),
  defineWorkerTool(
    requestHostDirectoryAccessToolName,
    `Ask the host for permission to access a directory on the host filesystem. Emit this tool call directly instead of asking the user in plain text. The host will mount the approved directory inside ${hostGrantsPrefix}/ if approved.`,
    true,
    requestHostDirectoryAccessSchema,
  ),
] as const satisfies readonly WorkerToolDefinition[];

// Public API

export type WorkerToolPayload =
  | z.infer<typeof copyIntoShareSchema>
  | z.infer<typeof copyOutOfShareSchema>
  | z.infer<typeof sendFileToChannelSchema>
  | z.infer<typeof completeTaskSchema>
  | z.infer<typeof requestHttpTokenSchema>
  | z.infer<typeof requestHostDirectoryAccessSchema>;
export type PrivilegedWorkerToolPayload =
  | z.infer<typeof copyIntoShareSchema>
  | z.infer<typeof copyOutOfShareSchema>
  | z.infer<typeof requestHttpTokenSchema>
  | z.infer<typeof requestHostDirectoryAccessSchema>;

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
