import { z } from "zod";
import type {HostDirectoryAccessLevel} from "../hostfs/path-policy.ts";
import type { JobMutationRequest } from "../jobs/job-types.js";
import type { FileCopyWorkerToolPayload } from "../subagent/worker-tools.js";

const privilegeApprovalScopeSchema = z.enum(["once", "worker_session", "job", "always"]);

type FileCopyPrivilegeRequest = {
  kind: "file_copy";
  requestId: string;
  payload: FileCopyWorkerToolPayload;
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
  canApproveForJob?: boolean;
};

type McpResourceReadPrivilegeRequest = {
  kind: "mcp_resource_read";
  requestId: string;
  serverId: string;
  uri: string;
  confirmsAutoApprovalForTask?: boolean;
  canApproveForJob?: boolean;
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

type JobMutationPrivilegeRequest = {
  kind: "job_mutation";
  requestId: string;
  mutation: JobMutationRequest;
};

export type PrivilegeRequest = FileCopyPrivilegeRequest | HostDirectoryAccessPrivilegeRequest | McpToolCallPrivilegeRequest | McpResourceReadPrivilegeRequest | HttpTokenUsePrivilegeRequest | SkillMutationPrivilegeRequest | JobMutationPrivilegeRequest;

export const privilegeResolutionResultSchema = z.object({
  requestId: z.string().min(1),
  outcome: z.enum(["approved", "denied", "failed"]),
  message: z.string(),
  scope: privilegeApprovalScopeSchema.optional(),
  reason: z.string().optional(),
});
export type PrivilegeResolutionResult = z.infer<typeof privilegeResolutionResultSchema>;
