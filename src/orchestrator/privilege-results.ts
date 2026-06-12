import { messages } from "../messages.js";
import type {
  PrivilegeRequest,
  PrivilegeResolutionResult,
} from "../types.js";
import type { NativeWorkerToolCallResult } from "../subagent/worker-tools.js";

type UnsupportedPrivilegeRequest = Extract<PrivilegeRequest, {
  kind: "host_operation" | "mcp_tool_call" | "mcp_resource_read" | "http_token_use";
}>;

export type McpPrivilegeRequest = Extract<PrivilegeRequest, {
  kind: "mcp_tool_call" | "mcp_resource_read";
}>;

export type NativeToolPrivilegeRequest = Extract<PrivilegeRequest, {
  kind: "host_operation" | "http_token_use" | "host_directory_access" | "skill_mutation" | "job_mutation";
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
  return request.kind === "host_operation"
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

export function buildUnsupportedPrivilegeResult(request: UnsupportedPrivilegeRequest): PrivilegeResolutionResult {
  switch (request.kind) {
    case "host_operation":
      return failedPrivilegeResult(request.requestId, messages.unsupportedPrivilegeRequestType(request.payload.type));
    case "mcp_tool_call":
      return failedPrivilegeResult(
        request.requestId,
        messages.unsupportedMcpPrivilegeRequest(request.serverId, request.toolName),
      );
    case "mcp_resource_read":
      return failedPrivilegeResult(
        request.requestId,
        messages.unsupportedMcpResourceReadPrivilegeRequest(request.serverId, request.uri),
      );
    case "http_token_use":
      return failedPrivilegeResult(request.requestId, messages.httpTokenNotConfigured(request.tokenId));
    default:
      return assertNever(request);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled privilege request: ${JSON.stringify(value)}`);
}
