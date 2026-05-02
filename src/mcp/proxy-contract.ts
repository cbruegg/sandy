import type { PrivilegeResolutionResult } from "../types.js";

type McpToolCallAuthorizationRequest = {
  taskId: string;
  serverId: string;
  toolName: string;
  arguments: unknown;
};

type McpResourceReadAuthorizationRequest = {
  taskId: string;
  serverId: string;
  uri: string;
};

type NativeToolCallRequest = {
  taskId: string;
  toolName: string;
  arguments: unknown;
};

export type NativeToolCallResult = {
  isError: boolean;
  message: string;
};

export type AuthorizeMcpToolCall = (input: McpToolCallAuthorizationRequest) => Promise<PrivilegeResolutionResult>;
export type AuthorizeMcpResourceRead = (input: McpResourceReadAuthorizationRequest) => Promise<PrivilegeResolutionResult>;
export type ExecuteNativeToolCall = (input: NativeToolCallRequest) => Promise<NativeToolCallResult>;
