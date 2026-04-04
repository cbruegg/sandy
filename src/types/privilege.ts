import { z } from "zod";
import { workerToolDefinitions } from "../subagent/worker-tools.js";

// TODO: It will be easy to forget new additions here. Find a way to get rid of this list or compose it automatically?
export const privilegeRequestPayloadSchema = z.discriminatedUnion("type", [
  workerToolDefinitions.copy_into_share.schema,
  workerToolDefinitions.copy_out_of_share.schema,
  workerToolDefinitions.mount_ro.schema,
  workerToolDefinitions.mount_rw.schema,
  workerToolDefinitions.enable_mcp.schema,
  workerToolDefinitions.enable_onecli.schema,
]);

export const privilegeRequestSchema = z.object({
  requestId: z.string(),
  payload: privilegeRequestPayloadSchema,
}).strict();

export const privilegeResolutionResultSchema = z.object({
  requestId: z.string(),
  outcome: z.enum(["approved", "denied", "rejected", "failed"]),
  message: z.string(),
}).strict();

export type PrivilegeRequestPayload = z.infer<typeof privilegeRequestPayloadSchema>;
export type PrivilegeRequest = z.infer<typeof privilegeRequestSchema>;
export type PrivilegeResolutionResult = z.infer<typeof privilegeResolutionResultSchema>;
