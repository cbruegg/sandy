import type {ChannelFormatting, PrivilegeRequest} from "./types.js";

export const buttonLabels = {
  reportDangerousOutput: "Report dangerous output",
  abortTask: "Abort task",
  markAsFinished: "Mark as finished",
  approve: "Approve once",
  approveWorkerSession: "Allow in task",
  approveAlways: "Auto-allow for suitable tasks",
  approveAlwaysHostDirectory: "Always allow",
  deny: "Deny",
} as const;

export const messages = {
  unsupportedInput: (inputType: string): string =>
    `This build supports text messages, file attachments, and optionally voice messages when STT is configured. Received unsupported ${inputType} input.`,
  voiceMessagesNotEnabled: (): string =>
    "Voice messages are disabled. Configure STT in Sandy's config file to enable transcription.",
  voiceTranscriptionFailed: (): string =>
    "Voice transcription failed. Please try again or send the request as text.",
  updateInstalling: (revision: string): string =>
    `A Sandy update is ready. Restarting now to install ${revision}.`,
  nextPlannedStep: (step: string): string => `Next planned step: ${step}`,
  commandProgress: (status: string, command: string, channelFormatting: ChannelFormatting | null): string => {
    const formattedCommand = formatCommandForChannel(command, channelFormatting);
    return `Command ${status}: ${formattedCommand}`;
  },
  taskSummaryReady: (taskName: string, summary: string): string =>
    `Task "${taskName}" completed.\n\n${summary}`,
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
  taskStarted: (taskName: string): string => `Started task "${taskName}".`,
  privilegeDenied: (requestId: string): string => `Denied privilege request ${requestId}.`,
  privilegeFailed: (requestId: string, detail: string): string => `Privilege request ${requestId} failed.\n${detail}`,
  userDeniedPrivilegeRequest: (requestId: string): string => `The user denied privilege request ${requestId}.`,
  unsupportedPrivilegeRequestType: (requestType: string): string =>
    `Privilege request type "${requestType}" is not supported by this runtime.`,
  staleShareDeletionRequest: (): string => "That shared workspace deletion request is no longer pending.",
  shareDeletionRequestPrompt: (taskName: string, summary: string): string =>
    `Task "${taskName}" left files in its shared workspace.\n\n${summary}\n\nApprove to delete this workspace, or deny to keep it.`,
  shareDeleted: (taskName: string): string => `Deleted the shared workspace for task "${taskName}".`,
  sharePreserved: (taskName: string): string => `Kept the shared workspace for task "${taskName}".`,
  privilegeRequestPrompt: (request: PrivilegeRequest): string => {
    const actions = describePrivilegeActions(request);
    return actions
      ? `Privilege request:\n${describePrivilegeRequest(request)}\n\n${actions}`
      : `Privilege request:\n${describePrivilegeRequest(request)}`;
  },
  taskEndedBeforePrivilegeRequestResolved: (taskId: string, requestId: string): string =>
    `Task ${taskId} ended before privilege request ${requestId} could be resolved.`,
  taskNotActive: (taskId: string): string => `Task ${taskId} is not active.`,
  taskNoLongerActive: (taskId: string): string => `Task ${taskId} is no longer active.`,
  sharedFileSentToUser: (path: string): string => `Sent ${path} to the user.`,

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
    `Allowed ${serverId}.${toolName} from persistent config for this task.`,
  mcpToolAllowedAndPersisted: (serverId: string, toolName: string): string =>
    `Allowed ${serverId}.${toolName} and updated Sandy's config file for future suitable tasks.`,
  mcpToolProgress: (status: string, serverId: string, toolName: string, payload: unknown): string =>
    status === "completed"
      ? `MCP ${status}: ${serverId}.${toolName} ${describeMcpToolPayload(payload)}`
      : `MCP ${status}: ${serverId}.${toolName}`,
  unsupportedMcpResourceReadPrivilegeRequest: (serverId: string, uri: string): string =>
    `Unsupported MCP resource read privilege request ${serverId} ${uri}.`,
  userDeniedMcpResourceRead: (serverId: string, uri: string): string =>
    `The user denied MCP resource read ${serverId} ${uri}.`,
  mcpResourceReadAllowedOnce: (serverId: string, uri: string): string =>
    `Allowed ${serverId} ${uri} once.`,
  mcpResourceReadAllowedForWorkerSession: (serverId: string, uri: string): string =>
    `Allowed ${serverId} ${uri} for this worker session.`,
  mcpResourceReadAllowedFromPersistentConfig: (serverId: string, uri: string): string =>
    `Allowed ${serverId} ${uri} from persistent config for this task.`,
  mcpResourceReadAllowedAndPersisted: (serverId: string, uri: string): string =>
    `Allowed ${serverId} ${uri} and updated Sandy's config file for future suitable tasks.`,
  mcpResourceReadProgress: (status: string, serverId: string, uri: string): string =>
    `MCP ${status}: ${serverId} ${uri}`,
  httpTokenDenied: (tokenId: string, host: string): string =>
    `The user denied HTTP token use ${tokenId} for host ${host}.`,
  httpTokenAllowedOnce: (tokenId: string, host: string): string =>
    `Allowed HTTP token ${tokenId} for host ${host} once.`,
  httpTokenAllowedForWorkerSession: (tokenId: string, host: string): string =>
    `Allowed HTTP token ${tokenId} for host ${host} for this worker session.`,
  httpTokenAllowedFromPersistentConfig: (tokenId: string, host: string): string =>
    `Allowed HTTP token ${tokenId} for host ${host} from persistent config for this task.`,
  httpTokenAllowedAndPersisted: (tokenId: string, host: string): string =>
    `Allowed HTTP token ${tokenId} for host ${host} and updated Sandy's config file for future suitable tasks.`,
  httpTokenAlreadyConsumed: (tokenId: string, host: string): string =>
    `One-shot HTTP token grant ${tokenId} for host ${host} has already been consumed.`,
  httpTokenProxyRejected: (tokenId: string): string =>
    `HTTP proxy rejected request for token ${tokenId} because no approval is active. Emit SANDY_REQUEST_HTTP_TOKEN for that token and wait for host approval before retrying.`,
  httpTokenNotConfigured: (tokenId: string): string =>
    `HTTP token "${tokenId}" is not configured in Sandy's config file.`,
  httpTokenHostNotAllowed: (tokenId: string, host: string): string =>
    `Host "${host}" is not in the configured allowed_hosts for token ${tokenId}.`,
  hostDirectoryAccessDenied: (path: string, level: string): string =>
    `The user denied host directory access to ${path} (${level}).`,
  hostDirectoryAccessAllowedForWorkerSession: (path: string, level: string): string =>
    `Allowed host directory access to ${path} (${level}) for this worker session.`,
  hostDirectoryAccessAllowedFromPersistentConfig: (path: string, level: string): string =>
    `Allowed host directory access to ${path} (${level}) from persistent config for this task.`,
  hostDirectoryAccessAllowedAndPersisted: (path: string, level: string): string =>
    `Allowed host directory access to ${path} (${level}) and updated Sandy's config file for future suitable tasks.`,
  hostDirectoryAccessFailed: (path: string, error: string): string =>
    `Host directory access request for ${path} failed: ${error}`,
  hostDirectoryNotFound: (path: string): string =>
    `Host directory not found or not accessible: ${path}`,
  skillMutationDenied: (operation: string, skillId: string): string =>
    `Denied ${operation} skill "${skillId}".`,
  skillMutationApproved: (operation: string, skillId: string): string =>
    `Approved ${operation} skill "${skillId}".`,
  skillMutationFailed: (operation: string, skillId: string, error: string): string =>
    `Failed to ${operation} skill "${skillId}": ${error}`,
} as const;

function formatCommandForChannel(command: string, channelFormatting: ChannelFormatting | null): string {
  if (!channelFormatting || channelFormatting.markup === "plain_text") {
    return command;
  }

  if (channelFormatting.markup === "telegram_markdown") {
    return wrapMarkdownCode(command);
  }

  return `<code>${command}</code>`;
}

function wrapMarkdownCode(text: string): string {
  const backtickRuns = text.match(/`+/g) ?? [];
  const longestRun = backtickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longestRun + 1);
  const needsPadding = text.startsWith("`") || text.endsWith("`");
  const paddedText = needsPadding ? ` ${text} ` : text;
  return `${fence}${paddedText}${fence}`;
}

export const mcpAdminMessages = {
  oauthLoginUnsupported: (serverId: string): string =>
    `MCP server ${serverId} does not support OAuth login because it is not streamable_http.`,
  stdioLoginUnsupported: (serverId: string): string =>
    `MCP server ${serverId} does not support OAuth login because it uses stdio.`,
  stdioLogoutUnsupported: (serverId: string): string =>
    `MCP server ${serverId} does not support OAuth logout because it uses stdio.`,
  oauthAuthorizationUrlMissing: (serverId: string): string =>
    `OAuth login for ${serverId} did not provide an authorization URL.`,
  oauthDiscoveryInvalidMetadata: (
    serverId: string,
    serverUrl: string,
    issues: string[],
    rawResponse?: { url: string; status: number; body: string },
  ): string => {
    const lines = [
      `OAuth login for ${serverId} failed because ${serverUrl} returned invalid authorization metadata.`,
      "The MCP server or its authorization server is not exposing RFC-compliant OAuth discovery data.",
      "Validation errors:",
      ...issues.map((issue) => `- ${issue}`),
    ];

    if (rawResponse) {
      lines.push("Raw response:");
      lines.push(`- URL: ${rawResponse.url}`);
      lines.push(`- Status: ${rawResponse.status}`);
      lines.push(rawResponse.body);
    }

    return lines.join("\n");
  },
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
  oauthLoginPastePrompt: (): string =>
    "If the browser cannot reach Sandy on this machine, paste the final callback URL or the authorization code here and press Enter:",
  oauthPasteInvalid: (): string =>
    "That was not a valid callback URL or authorization code. Paste the full callback URL or just the code.",
  oauthManualInputClosed: (): string =>
    "OAuth login input was closed before an authorization code was received.",
  oauthTokensMissingForStartup: (serverId: string, stateFilePath: string): string =>
    `OAuth state for ${serverId} exists at ${stateFilePath} but is missing tokens. Run "sandy mcp login ${serverId}" before starting Sandy.`,
} as const;

export const matrixAdminMessages = {
  noMatrixConfig: (): string =>
    "Matrix channel is not configured. Set channel.kind = \"matrix\" and configure channel.matrix in your config file.",
  passwordPrompt: (): string =>
    "Enter Matrix password: ",
  passwordRequired: (): string =>
    "Matrix password is required.",
  loginFailed: (error: string): string =>
    `Matrix login failed: ${error}`,
  loginInvalidResponse: (): string =>
    "Matrix login response did not contain required fields (user_id, device_id, access_token).",
  authStateMissing: (): string =>
    'Matrix auth state file is missing. Run "sandy matrix login" first.',
  authStateInvalid: (reason: string): string =>
    `Matrix auth state is invalid: ${reason} Run "sandy matrix login" to re-authenticate.`,
  verifyRecoveryKeyPrompt: (): string =>
    "Enter Matrix recovery key: ",
  recoveryKeyRequired: (): string =>
    "Matrix recovery key is required.",
  noSecretStorage: (): string =>
    "Matrix secret storage is not set up on this account. Set up Secure Backup in a Matrix client (e.g. Element) first.",
  secretStorageKeyNotFound: (eventType: string): string =>
    `Secret storage key descriptor "${eventType}" not found on the homeserver.`,
  crossSigningSecretsMissing: (): string =>
    "Cross-signing secrets are not stored in the account's secret storage. Set up cross-signing in a Matrix client first.",
  verificationSucceeded: (deviceId: string): string =>
    `Device ${deviceId} has been signed successfully.`,
  alreadyVerified: (): string =>
    "This device is already verified.",
} as const;

function describePrivilegeRequest(request: PrivilegeRequest): string {
  if (request.kind === "mcp_tool_call") {
    if (request.confirmsAutoApprovalForTask) {
      return [
        `A saved auto-approval matches this MCP tool: ${request.serverId}.${request.toolName}`,
        "Apply that saved approval to this task?",
        `Arguments: ${JSON.stringify(request.arguments)}`,
      ].join("\n");
    }
    return [
      `MCP tool call: ${request.serverId}.${request.toolName}`,
      `Arguments: ${JSON.stringify(request.arguments)}`,
    ].join("\n");
  }

  if (request.kind === "mcp_resource_read") {
    if (request.confirmsAutoApprovalForTask) {
      return [
        `A saved auto-approval matches this MCP resource read from ${request.serverId}.`,
        "Apply that saved approval to this task?",
        `URI: ${request.uri}`,
      ].join("\n");
    }
    return [
      `MCP resource read from ${request.serverId}`,
      `URI: ${request.uri}`,
    ].join("\n");
  }

  if (request.kind === "http_token_use") {
    if (request.confirmsAutoApprovalForTask) {
      return [
        `A saved auto-approval matches HTTP token ${request.tokenId} for ${request.host}.`,
        "Apply that saved approval to this task?",
        `Reason: ${request.reason}`,
      ].join("\n");
    }
    return [
      `HTTP token use: ${request.tokenId}`,
      `Host: ${request.host}`,
      `Reason: ${request.reason}`,
    ].join("\n");
  }

  if (request.kind === "host_directory_access") {
    return [
      `Host directory access: ${request.path}`,
      `Access level: ${describeHostDirectoryAccessLevel(request.level)}`,
    ].join("\n");
  }

  if (request.kind === "skill_mutation") {
    return [
      `Skill mutation: ${request.operation}`,
      `Skill ID: ${request.skillId}`,
      ...(request.name ? [`Name: ${request.name}`] : []),
      ...(request.description ? [`Description: ${request.description}`] : []),
    ].join("\n");
  }

  switch (request.payload.type) {
    case "copy_into_share":
      return `Copy file into the shared workspace: ${request.payload.sourcePath} -> ${request.payload.targetPath}\nReason: ${request.payload.reason}`;
    case "copy_out_of_share":
      return `Copy file out of the shared workspace: ${request.payload.sourcePath} -> ${request.payload.targetPath}\nReason: ${request.payload.reason}`;
    default:
      return `Host operation: ${request.payload.type}`;
  }
}

function describeHostDirectoryAccessLevel(level: string): string {
  switch (level) {
    case "read_only":
      return "read-only";
    case "read_write":
      return "read and write";
    default:
      return level;
  }
}

function describePrivilegeActions(request: PrivilegeRequest): string | null {
  if (request.kind === "mcp_tool_call" || request.kind === "mcp_resource_read" || request.kind === "http_token_use" || request.kind === "host_directory_access") {
    // In this case, it's pretty clear to the user that approve/deny will approve/deny the request
    return null;
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
