import { z } from "zod";

export const sandyMcpServerId = "sandy";

type WorkerToolDefinition<TSchema extends z.ZodObject<z.core.$ZodLooseShape> = z.ZodObject<z.core.$ZodLooseShape>> = {
  description: string;
  requiresPrivilegeEscalation: boolean;
  schema: TSchema;
};

const workerToolDefinitions = {
  copy_into_share: {
    description: "Ask the host to copy a file or directory from an absolute host path into the shared workspace.",
    requiresPrivilegeEscalation: true,
    schema: z.object({
      type: z.literal("copy_into_share"),
      sourcePath: z.string(),
      targetPath: z.string(),
      reason: z.string(),
    }).strict(),
  },
  copy_out_of_share: {
    description: "Ask the host to copy a file or directory from the shared workspace to an absolute host path.",
    requiresPrivilegeEscalation: true,
    schema: z.object({
      type: z.literal("copy_out_of_share"),
      sourcePath: z.string(),
      targetPath: z.string(),
      reason: z.string(),
    }).strict(),
  },
  send_file_to_channel: {
    description: "Send a file that already exists in the shared workspace back to the user through the channel adapter.",
    requiresPrivilegeEscalation: false,
    schema: z.object({
      type: z.literal("send_file_to_channel"),
      path: z.string(),
      caption: z.string().optional(),
    }).strict(),
  },
  complete_task: {
    description: "Signal to the host that the tasks the user stated so far are fully complete. You *must* emit this at the very end.",
    requiresPrivilegeEscalation: false,
    schema: z.object({
      type: z.literal("complete_task"),
    }).strict(),
  },
  request_http_token: {
    description: "Ask the host for permission to use a preconfigured HTTP token. Emit this tool call directly instead of asking the user in plain text. You must request approval before making HTTP requests that use placeholder headers like 'Authorization: Bearer SANDY_TOKEN_<tokenId>'. The host will inject the real token value into proxied HTTP requests if approved.",
    requiresPrivilegeEscalation: true,
    schema: z.object({
      type: z.literal("request_http_token"),
      tokenId: z.string(),
      host: z.string(),
      reason: z.string(),
    }).strict(),
  },
} as const satisfies Record<string, WorkerToolDefinition>;

type WorkerToolDefinitions = typeof workerToolDefinitions;
type WorkerToolName = keyof WorkerToolDefinitions;
export type WorkerToolPayload<TName extends WorkerToolName = WorkerToolName> = z.infer<WorkerToolDefinitions[TName]["schema"]>;
type WorkerToolNameByPrivilege<TRequiresPrivilegeEscalation extends boolean> = {
  [TName in WorkerToolName]:
    WorkerToolDefinitions[TName]["requiresPrivilegeEscalation"] extends TRequiresPrivilegeEscalation ? TName : never;
}[WorkerToolName];
export type PrivilegedWorkerToolPayload = WorkerToolPayload<WorkerToolNameByPrivilege<true>>;
type WorkerToolEntry<TName extends WorkerToolName = WorkerToolName> = {
  name: TName;
  definition: WorkerToolDefinitions[TName];
};

export const workerToolEntries = Object.entries(workerToolDefinitions)
  .map(([name, definition]) => ({
    name,
    definition,
  })) as WorkerToolEntry[];

function withoutTypeField(schema: z.ZodObject<z.core.$ZodLooseShape>): z.ZodObject<z.core.$ZodLooseShape> {
  const shape = {
    ...schema.shape,
  };
  delete shape["type"];
  return z.object(shape).strict();
}

export function buildWorkerToolInputSchema(name: WorkerToolName): Record<string, unknown> {
  return z.toJSONSchema(withoutTypeField(workerToolDefinitions[name].schema));
}

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
