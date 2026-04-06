import type { PrivilegedWorkerToolPayload } from "../subagent/worker-tool-registry.js";

export type PrivilegeApprovalScope = "once" | "worker_session" | "always";

export type HostOperationPrivilegeRequest = {
  kind: "host_operation";
  requestId: string;
  payload: PrivilegedWorkerToolPayload;
};

export type McpToolCallPrivilegeRequest = {
  kind: "mcp_tool_call";
  requestId: string;
  serverId: string;
  toolName: string;
  arguments: unknown;
};

export type PrivilegeRequest = HostOperationPrivilegeRequest | McpToolCallPrivilegeRequest;

export type PrivilegeResolutionResult = {
  requestId: string;
  outcome: "approved" | "denied" | "rejected" | "failed";
  message: string;
  scope?: PrivilegeApprovalScope;
};
