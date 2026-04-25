import { z } from "zod";
import type { PrivilegedWorkerToolPayload } from "../subagent/worker-tool-registry.js";

const privilegeApprovalScopeSchema = z.enum(["once", "worker_session", "always"]);

type HostOperationPrivilegeRequest = {
  kind: "host_operation";
  requestId: string;
  payload: PrivilegedWorkerToolPayload;
};

type McpToolCallPrivilegeRequest = {
  kind: "mcp_tool_call";
  requestId: string;
  serverId: string;
  toolName: string;
  arguments: unknown;
};

export type PrivilegeRequest = HostOperationPrivilegeRequest | McpToolCallPrivilegeRequest;

export const privilegeResolutionResultSchema = z.object({
  requestId: z.string().min(1),
  outcome: z.enum(["approved", "denied", "failed"]),
  message: z.string(),
  scope: privilegeApprovalScopeSchema.optional(),
});
export type PrivilegeResolutionResult = z.infer<typeof privilegeResolutionResultSchema>;
