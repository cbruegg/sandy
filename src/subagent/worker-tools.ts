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
  mount_ro: {
    description: "Ask the host to mount an absolute host path into the workspace as read-only.",
    requiresPrivilegeEscalation: true,
    schema: z.object({
      type: z.literal("mount_ro"),
      hostPath: z.string(),
      targetPath: z.string(),
      reason: z.string(),
    }).strict(),
  },
  mount_rw: {
    description: "Ask the host to mount an absolute host path into the workspace as read-write.",
    requiresPrivilegeEscalation: true,
    schema: z.object({
      type: z.literal("mount_rw"),
      hostPath: z.string(),
      targetPath: z.string(),
      reason: z.string(),
    }).strict(),
  },
  enable_mcp: {
    description: "Ask the host to enable an MCP integration identified by name.",
    requiresPrivilegeEscalation: true,
    schema: z.object({
      type: z.literal("enable_mcp"),
      identifier: z.string(),
      reason: z.string(),
    }).strict(),
  },
  enable_onecli: {
    description: "Ask the host to enable a OneCLI integration identified by name.",
    requiresPrivilegeEscalation: true,
    schema: z.object({
      type: z.literal("enable_onecli"),
      identifier: z.string(),
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
} as const satisfies Record<string, WorkerToolDefinition>;
