import { z } from "zod";
import type {HostDirectoryAccessLevel} from "../hostfs/path-policy.ts";
import type { JobMutationRequest } from "../jobs/job-types.js";
import type { FileCopyWorkerToolPayload } from "../subagent/worker-tools.js";

const privilegeApprovalScopeSchema = z.enum(["once", "worker_session", "job", "always"]);

type PrivilegeRequestBase = {
  kind: string;
  requestId: string;
  canApproveForJob?: boolean;
};

type FileCopyPrivilegeRequest = PrivilegeRequestBase & {
  kind: "file_copy";
  payload: FileCopyWorkerToolPayload;
};

type HostDirectoryAccessPrivilegeRequest = PrivilegeRequestBase & {
  kind: "host_directory_access";
  path: string;
  level: HostDirectoryAccessLevel;
};

type McpToolCallPrivilegeRequest = PrivilegeRequestBase & {
  kind: "mcp_tool_call";
  serverId: string;
  toolName: string;
  arguments: unknown;
  confirmsAutoApprovalForTask?: boolean;
};

type McpResourceReadPrivilegeRequest = PrivilegeRequestBase & {
  kind: "mcp_resource_read";
  serverId: string;
  uri: string;
  confirmsAutoApprovalForTask?: boolean;
};

type HttpTokenUsePrivilegeRequest = PrivilegeRequestBase & {
  kind: "http_token_use";
  tokenId: string;
  host: string;
  reason: string;
  confirmsAutoApprovalForTask?: boolean;
};

type SkillMutationPrivilegeRequest = PrivilegeRequestBase & {
  kind: "skill_mutation";
  operation: "create" | "update" | "delete";
  skillId: string;
  name?: string;
  description?: string;
  body?: string;
};

type JobMutationPrivilegeRequest = PrivilegeRequestBase & {
  kind: "job_mutation";
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
