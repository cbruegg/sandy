import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const sandyMcpServerId = "sandy";

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

const copyIntoShareSchema = z.object({
  type: z.literal("copy_into_share"),
  sourcePath: z.string(),
  targetPath: z.string(),
  reason: z.string(),
}).strict();

const copyOutOfShareSchema = z.object({
  type: z.literal("copy_out_of_share"),
  sourcePath: z.string(),
  targetPath: z.string(),
  reason: z.string(),
}).strict();

const sendFileToChannelSchema = z.object({
  type: z.literal("send_file_to_channel"),
  path: z.string(),
  caption: z.string().optional(),
}).strict();

const completeTaskSchema = z.object({
  type: z.literal("complete_task"),
}).strict();

const requestHttpTokenSchema = z.object({
  type: z.literal("request_http_token"),
  tokenId: z.string(),
  host: z.string(),
  reason: z.string(),
}).strict();

const workerToolDefinitions = {
  copy_into_share: defineWorkerTool(
    "copy_into_share",
    "Ask the host to copy a file or directory from an absolute host path into the shared workspace.",
    true,
    copyIntoShareSchema,
  ),
  copy_out_of_share: defineWorkerTool(
    "copy_out_of_share",
    "Ask the host to copy a file or directory from the shared workspace to an absolute host path.",
    true,
    copyOutOfShareSchema,
  ),
  send_file_to_channel: defineWorkerTool(
    "send_file_to_channel",
    "Send a file that already exists in the shared workspace back to the user through the channel adapter.",
    false,
    sendFileToChannelSchema,
  ),
  complete_task: defineWorkerTool(
    "complete_task",
    "Signal to the host that the tasks the user stated so far are fully complete. You *must* emit this at the very end.",
    false,
    completeTaskSchema,
  ),
  request_http_token: defineWorkerTool(
    "request_http_token",
    "Ask the host for permission to use a preconfigured HTTP token. Emit this tool call directly instead of asking the user in plain text. You must request approval before making HTTP requests that use placeholder headers like 'Authorization: Bearer SANDY_TOKEN_<tokenId>'. The host will inject the real token value into proxied HTTP requests if approved.",
    true,
    requestHttpTokenSchema,
  ),
} as const satisfies Record<string, Tool & {
  requiresPrivilegeEscalation: boolean;
  schema: z.ZodObject<z.core.$ZodLooseShape>;
}>;

type WorkerToolDefinitions = typeof workerToolDefinitions;
type WorkerToolName = keyof WorkerToolDefinitions;
export type WorkerToolPayload =
  | z.infer<typeof copyIntoShareSchema>
  | z.infer<typeof copyOutOfShareSchema>
  | z.infer<typeof sendFileToChannelSchema>
  | z.infer<typeof completeTaskSchema>
  | z.infer<typeof requestHttpTokenSchema>;
export type PrivilegedWorkerToolPayload =
  | z.infer<typeof copyIntoShareSchema>
  | z.infer<typeof copyOutOfShareSchema>
  | z.infer<typeof requestHttpTokenSchema>;
type WorkerToolEntry<TName extends WorkerToolName = WorkerToolName> = {
  name: TName;
  definition: WorkerToolDefinitions[TName];
};

export const workerToolEntries = Object.entries(workerToolDefinitions)
  .map(([name, definition]) => ({
    name,
    definition,
  })) as WorkerToolEntry[];

export function parseWorkerToolPayload(name: string, argumentsValue: unknown): WorkerToolPayload {
  const definition = workerToolDefinitions[name as WorkerToolName];
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
