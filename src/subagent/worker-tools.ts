import { z } from "zod";
import type { WorkerToolDefinition } from "./worker-protocol.js";

export const workerToolDefinitions = {
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
