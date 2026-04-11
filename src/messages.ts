import type {PrivilegeRequest} from "./types.js";

export const buttonLabels = {
  reportDangerousOutput: "Report dangerous output",
  abortTask: "Abort task",
  markAsFinished: "Mark as finished",
  approve: "Approve once",
  approveWorkerSession: "Allow in task",
  approveAlways: "Always allow",
  deny: "Deny",
} as const;

export const messages = {
  unsupportedInput: (inputType: string): string =>
    `This build supports text messages, file attachments, and optionally voice messages when STT is configured. Received unsupported ${inputType} input.`,
  voiceMessagesNotEnabled: (): string =>
    "Voice messages are disabled. Configure STT in Sandy's config file to enable transcription.",
  voiceTranscriptionFailed: (): string =>
    "Voice transcription failed. Please try again or send the request as text.",
  nextPlannedStep: (step: string): string => `Next planned step: ${step}`,
  commandProgress: (status: string, command: string): string => `Command ${status}: ${command}`,
  taskSummaryReady: (taskName: string, summary: string): string =>
    `Task "${taskName}" completed.\n\nSummary:\n${summary}`,
  taskFailed: (message: string): string => `Task failed: ${message}`,
  handlerFailed: (message: string): string => `Something went wrong: ${message}`,
  noActiveTaskToCancel: (): string => "There is no active task to cancel.",
  noActiveTaskToFinish: (): string => "There is no active task to mark as finished.",
  noPendingPrivilegeRequest: (): string => "There is no pending privilege request.",
  noActiveOutputToReport: (): string => "There is no active sub-agent output to report.",
  discardedPendingOutput: (): string => "Discarded the pending sub-agent output.",
  taskCancelled: (taskName: string): string => `Cancelled task "${taskName}".`,
  noPendingOutputToReport: (): string => "There is no pending sub-agent output to report.",
  taskTerminatedAndDiscarded: (taskName: string): string =>
    `Terminated task "${taskName}" and discarded the pending sub-agent output.`,
  taskTerminatedAfterDangerousPrivilegeRequest: (taskName: string): string =>
    `Terminated task "${taskName}" after a dangerous privilege request report.`,
  stalePrivilegeRequest: (): string => "That privilege request is no longer pending.",
  privilegeRequestStillPending: (): string =>
    "A privilege request is pending. Resolve it before sending more task input.",
  shareDeletionStillPending: (): string =>
    "A shared workspace deletion decision is pending. Reply with approve or deny before sending more input.",
  taskStarted: (taskName: string): string =>
      `Started task "${taskName}". You will receive progress updates here.`,
  privilegeApproved: (requestId: string, detail: string): string => `Approved privilege request ${requestId}.\n${detail}`,
  privilegeDenied: (requestId: string): string => `Denied privilege request ${requestId}.`,
  privilegeRejected: (requestId: string, detail: string): string => `Rejected privilege request ${requestId}.\n${detail}`,
  privilegeFailed: (requestId: string, detail: string): string => `Privilege request ${requestId} failed.\n${detail}`,
  userDeniedPrivilegeRequest: (requestId: string): string => `The user denied privilege request ${requestId}.`,
  unsupportedPrivilegeRequestType: (requestType: string): string =>
    `Privilege request type "${requestType}" is not supported by this runtime.`,
  staleShareDeletionRequest: (): string => "That shared workspace deletion request is no longer pending.",
  shareDeletionRequestPrompt: (taskName: string, summary: string): string =>
    `Task "${taskName}" left files in its shared workspace.\n\n${summary}\n\nApprove to delete this workspace, or deny to keep it.`,
  shareDeleted: (taskName: string): string => `Deleted the shared workspace for task "${taskName}".`,
  sharePreserved: (taskName: string): string => `Kept the shared workspace for task "${taskName}".`,
  privilegeRequestPrompt: (request: PrivilegeRequest): string =>
    `Privilege request:\n${describePrivilegeRequest(request)}\n\n${describePrivilegeActions(request)}`,
  taskEndedBeforePrivilegeRequestResolved: (taskId: string, requestId: string): string =>
    `Task ${taskId} ended before privilege request ${requestId} could be resolved.`,
  taskNotActive: (taskId: string): string => `Task ${taskId} is not active.`,
  taskNoLongerActive: (taskId: string): string => `Task ${taskId} is no longer active.`,
  anotherPrivilegeRequestPendingForTask: (): string => "Another privilege request is already pending for this task.",
  unsupportedMcpPrivilegeRequest: (serverId: string, toolName: string): string =>
    `Unsupported MCP privilege request ${serverId}.${toolName}.`,
  userDeniedMcpToolCall: (serverId: string, toolName: string): string =>
    `The user denied MCP tool call ${serverId}.${toolName}.`,
  mcpToolAllowedOnce: (serverId: string, toolName: string): string =>
    `Allowed ${serverId}.${toolName} once.`,
  mcpToolAllowedForWorkerSession: (serverId: string, toolName: string): string =>
    `Allowed ${serverId}.${toolName} for this worker session.`,
  mcpToolAllowedFromPersistentConfig: (serverId: string, toolName: string): string =>
    `Allowed ${serverId}.${toolName} from persistent config.`,
  mcpToolAllowedAndPersisted: (serverId: string, toolName: string): string =>
    `Allowed ${serverId}.${toolName} and updated Sandy's config file.`,
  mcpToolProgress: (status: string, serverId: string, toolName: string, payload: unknown): string =>
    status === "completed"
      ? `MCP ${status}: ${serverId}.${toolName} ${describeMcpToolPayload(payload)}`
      : `MCP ${status}: ${serverId}.${toolName}`,
} as const;

export const mcpAdminMessages = {
  oauthLoginUnsupported: (serverId: string): string =>
    `MCP server ${serverId} does not support OAuth login because it is not streamable_http.`,
  oauthAuthorizationUrlMissing: (serverId: string): string =>
    `OAuth login for ${serverId} did not provide an authorization URL.`,
  unknownServer: (serverId: string): string =>
    `Unknown MCP server "${serverId}".`,
  oauthCallbackReturnedError: (error: string): string =>
    `OAuth callback returned error: ${error}`,
  oauthLoginFailedResponse: (): string =>
    "OAuth login failed. You can close this tab.",
  oauthAuthorizationCodeMissing: (): string =>
    "Missing OAuth authorization code.",
  oauthLoginCompletedResponse: (): string =>
    "OAuth login completed. You can close this tab.",
  oauthCallbackServerStartFailed: (): string =>
    "Failed to start OAuth callback server.",
  oauthLoginOpenUrl: (serverId: string): string =>
    `Open this URL to authorize ${serverId}:`,
} as const;

function describePrivilegeRequest(request: PrivilegeRequest): string {
  if (request.kind === "mcp_tool_call") {
    return [
      `mcp_tool_call: ${request.serverId}.${request.toolName}`,
      `Arguments: ${JSON.stringify(request.arguments)}`,
    ].join("\n");
  }

  switch (request.payload.type) {
    case "copy_into_share":
    case "copy_out_of_share":
      return `${request.payload.type}: ${request.payload.sourcePath} -> ${request.payload.targetPath}\nReason: ${request.payload.reason}`;
    case "mount_ro":
    case "mount_rw":
      return `${request.payload.type}: ${request.payload.hostPath} -> ${request.payload.targetPath}\nReason: ${request.payload.reason}`;
    case "enable_mcp":
    case "enable_onecli":
      return `${request.payload.type}: ${request.payload.identifier}\nReason: ${request.payload.reason}`;
  }
}

function describePrivilegeActions(request: PrivilegeRequest): string {
  if (request.kind === "mcp_tool_call") {
    return "Choose approve once, allow in this task, always allow, or deny.";
  }
  return "Approve or deny this request.";
}

function describeMcpToolPayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload);
    return serialized ?? "null";
  } catch {
    return "[unserializable payload]";
  }
}
