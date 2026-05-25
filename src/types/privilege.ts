import { z } from "zod";
import type { PrivilegedWorkerToolPayload } from "../subagent/worker-tools.js";
import type {HostDirectoryAccessLevel} from "../hostfs/path-policy.ts";

const privilegeApprovalScopeSchema = z.enum(["once", "worker_session", "always"]);

type HostOperationPrivilegeRequest = {
  kind: "host_operation";
  requestId: string;
  payload: PrivilegedWorkerToolPayload;
};

type HostDirectoryAccessPrivilegeRequest = {
  kind: "host_directory_access";
  requestId: string;
  path: string;
  level: HostDirectoryAccessLevel;
};

type McpToolCallPrivilegeRequest = {
  kind: "mcp_tool_call";
  requestId: string;
  serverId: string;
  toolName: string;
  arguments: unknown;
  confirmsAutoApprovalForTask?: boolean;
};

type McpResourceReadPrivilegeRequest = {
  kind: "mcp_resource_read";
  requestId: string;
  serverId: string;
  uri: string;
  confirmsAutoApprovalForTask?: boolean;
};

type HttpTokenUsePrivilegeRequest = {
  kind: "http_token_use";
  requestId: string;
  tokenId: string;
  host: string;
  reason: string;
  confirmsAutoApprovalForTask?: boolean;
};

type SkillMutationPrivilegeRequest = {
  kind: "skill_mutation";
  requestId: string;
  operation: "create" | "update" | "delete";
  skillId: string;
  name?: string;
  description?: string;
  body?: string;
};

export type PrivilegeRequest = HostOperationPrivilegeRequest | HostDirectoryAccessPrivilegeRequest | McpToolCallPrivilegeRequest | McpResourceReadPrivilegeRequest | HttpTokenUsePrivilegeRequest | SkillMutationPrivilegeRequest;

export const privilegeResolutionResultSchema = z.object({
  requestId: z.string().min(1),
  outcome: z.enum(["approved", "denied", "failed"]),
  message: z.string(),
  scope: privilegeApprovalScopeSchema.optional(),
});
export type PrivilegeResolutionResult = z.infer<typeof privilegeResolutionResultSchema>;
