import type {ChannelFormatting, PrivilegeRequest} from "./types.js";
import { assertNever } from "./utils/assert-never.js";

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
  matrixTaskReactionHint: (): string =>
    "_React with 👍 to finish task, 😮 to abort task_",
  matrixAbortReactionHint: (): string =>
    "_React with 😮 to abort task_",
  matrixReportReactionHint: (): string =>
    "_React with 😮 to report dangerous output_",
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
  chatgptAuthRefreshFailed: (): string =>
    "ChatGPT authentication expired on the host and could not be refreshed. Sign in again on the host, then retry the task.",
  handlerFailed: (message: string): string => `Something went wrong: ${message}`,
  noActiveTaskToCancel: (): string => "There is no active task to cancel.",
  noActiveTaskToFinish: (): string => "There is no active task to mark as finished.",
  noPendingPrivilegeRequest: (): string => "There is no pending privilege request.",
  noActiveOutputToReport: (): string => "There is no active sub-agent output to report.",
  discardedPendingOutput: (): string => "Discarded the pending sub-agent output.",
  taskCancelled: (taskName: string): string => `Cancelled task "${taskName}".`,
  noPendingOutputToReport: (): string => "There is no pending sub-agent output to report.",
  stalePrivilegeRequest: (): string => "That privilege request is no longer pending.",
  privilegeRequestStillPending: (): string =>
    "A privilege request is pending. Resolve it before sending more task input.",
  shareDeletionStillPending: (): string =>
    "A shared workspace deletion decision is pending. Reply with approve or deny before sending more input.",
  taskStarted: (taskName: string): string => `Started task "${taskName}".`,
  privilegeDenied: (requestId: string): string => `Denied privilege request ${requestId}.`,
  privilegeFailed: (requestId: string, detail: string): string => `Privilege request ${requestId} failed.\n${detail}`,
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
  denialReasonPrompt: (request: PrivilegeRequest): string =>
    `You denied the following privilege request. Reply with a short reason, or send "skip" to deny without a reason.\n\n${describePrivilegeRequest(request)}`,
  denialReasonStillPending: (): string =>
    "A denial reason is still pending. Reply with a short reason, or send \"skip\" to deny without a reason.",
  mcpToolProgress: (status: string, serverId: string, toolName: string, payload: unknown): string =>
    status === "completed"
      ? `MCP ${status}: ${serverId}.${toolName} ${describeMcpToolPayload(payload)}`
      : `MCP ${status}: ${serverId}.${toolName}`,
  scheduledJobBlocked: (jobName: string, taskName: string): string =>
    `A scheduled job (${jobName}) is waiting to interact, but task "${taskName}" is still active.`,
  scheduledJobBecameInteractive: (taskName: string, jobName: string | null): string => {
    const label = describeInteractiveTask(taskName, jobName);
    return `${label} is now interactive. The next update or request comes from this task.`;
  },
  jobRequestsInteraction: (taskName: string, jobName: string | null, message?: string): string => {
    const label = describeInteractiveTask(taskName, jobName);
    return message
      ? `${label} needs your attention: ${message}`
      : `${label} needs your attention.`;
  },
} as const;

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

function formatCommandForChannel(command: string, channelFormatting: ChannelFormatting | null): string {
  if (!channelFormatting) {
    return command;
  }

  switch (channelFormatting.markup) {
    case "plain_text":
      return command;

    case "telegram_markdown":
    case "matrix_markdown":
      return wrapMarkdownCode(command);

    case "matrix_html":
      return `<code>${command}</code>`;

    default:
      return assertNever(channelFormatting.markup);
  }
}

function wrapMarkdownCode(text: string): string {
  const backtickRuns = text.match(/`+/g) ?? [];
  const longestRun = backtickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(longestRun + 1);
  const needsPadding = text.startsWith("`") || text.endsWith("`");
  const paddedText = needsPadding ? ` ${text} ` : text;
  return `${fence}${paddedText}${fence}`;
}

function describeInteractiveTask(taskName: string, jobName: string | null): string {
  return jobName ? `Scheduled job "${jobName}"` : `Task "${taskName}"`;
}

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
    const lines = [
      `Skill mutation: ${request.operation}`,
      `Skill ID: ${request.skillId}`,
    ];
    if (request.name) {
      lines.push(`Name: ${request.name}`);
    }
    if (request.description) {
      lines.push(`Description: ${request.description}`);
    }
    if (request.body !== undefined) {
      lines.push(`Skill content:\n---\n${request.body}\n---`);
    }
    return lines.join("\n");
  }

  if (request.kind === "job_mutation") {
    const lines = [
      `Job mutation: ${request.mutation.operation}`,
      `Job ID: ${request.mutation.jobId}`,
    ];
    if (request.mutation.definition) {
      lines.push(`Definition:\n${JSON.stringify(request.mutation.definition, null, 2)}`);
    }
    return lines.join("\n");
  }

  switch (request.payload.type) {
    case "copy_into_share":
      return `Copy file into the shared workspace: ${request.payload.sourcePath} -> ${request.payload.targetPath}\nReason: ${request.payload.reason}`;
    case "copy_out_of_share":
      return `Copy file out of the shared workspace: ${request.payload.sourcePath} -> ${request.payload.targetPath}\nReason: ${request.payload.reason}`;
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
