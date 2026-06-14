import type {
  PrivilegeRequest,
  PrivilegeResolutionResult,
} from "../types.js";
import type { NativeWorkerToolCallResult } from "../subagent/worker-tools.js";

export type McpPrivilegeRequest = Extract<PrivilegeRequest, {
  kind: "mcp_tool_call" | "mcp_resource_read";
}>;

export type NativeToolPrivilegeRequest = Extract<PrivilegeRequest, {
  kind: "file_copy" | "http_token_use" | "host_directory_access" | "skill_mutation" | "job_mutation";
}>;

export function approvedPrivilegeResult(
  requestId: string,
  message: string,
  scope?: PrivilegeResolutionResult["scope"],
): PrivilegeResolutionResult {
  if (!scope) {
    return {
      requestId,
      outcome: "approved",
      message,
    };
  }

  return {
    requestId,
    outcome: "approved",
    message,
    scope,
  };
}

export function deniedPrivilegeResult(requestId: string, message: string): PrivilegeResolutionResult {
  return {
    requestId,
    outcome: "denied",
    message,
  };
}

export function failedPrivilegeResult(requestId: string, message: string): PrivilegeResolutionResult {
  return {
    requestId,
    outcome: "failed",
    message,
  };
}

export function toNativeWorkerToolCallResult(result: PrivilegeResolutionResult): NativeWorkerToolCallResult {
  return {
    isError: result.outcome !== "approved",
    message: result.message,
  };
}

export function isMcpPrivilegeRequest(request: PrivilegeRequest): request is McpPrivilegeRequest {
  return request.kind === "mcp_tool_call" || request.kind === "mcp_resource_read";
}

export function isNativeToolPrivilegeRequest(request: PrivilegeRequest): request is NativeToolPrivilegeRequest {
  return request.kind === "file_copy"
    || request.kind === "http_token_use"
    || request.kind === "host_directory_access"
    || request.kind === "skill_mutation"
    || request.kind === "job_mutation";
}

export function withHostDirectoryGrantMessage(
  result: PrivilegeResolutionResult,
  message: string,
  scope: Extract<NonNullable<PrivilegeResolutionResult["scope"]>, "worker_session" | "always">,
): PrivilegeResolutionResult {
  if (result.outcome !== "approved") {
    return result;
  }

  return {
    ...result,
    message: `${message} ${result.message}`,
    scope,
  };
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}
