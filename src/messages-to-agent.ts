export const messages = {
  userDeniedPrivilegeRequest: (requestId: string, reason?: string): string =>
    reason
      ? `The user denied privilege request ${requestId}.\nReason: ${reason}`
      : `The user denied privilege request ${requestId}.`,
  taskEndedBeforePrivilegeRequestResolved: (taskId: string, requestId: string): string =>
    `Task ${taskId} ended before privilege request ${requestId} could be resolved.`,
  taskNotActive: (taskId: string): string => `Task ${taskId} is not active.`,
  taskNoLongerActive: (taskId: string): string => `Task ${taskId} is no longer active.`,
  sharedFileSentToUser: (path: string): string => `Sent ${path} to the user.`,
  anotherPrivilegeRequestPendingForTask: (): string => "Another privilege request is already pending for this task.",

  userDeniedMcpToolCall: (serverId: string, toolName: string, reason?: string): string =>
    reason
      ? `The user denied MCP tool call ${serverId}.${toolName}.\nReason: ${reason}`
      : `The user denied MCP tool call ${serverId}.${toolName}.`,
  mcpToolAllowedOnce: (serverId: string, toolName: string): string =>
    `Allowed ${serverId}.${toolName} once.`,
  mcpToolAllowedForWorkerSession: (serverId: string, toolName: string): string =>
    `Allowed ${serverId}.${toolName} for this worker session.`,
  mcpToolAllowedFromPersistentConfig: (serverId: string, toolName: string): string =>
    `Allowed ${serverId}.${toolName} from persistent config for this task.`,
  mcpToolAllowedAndPersisted: (serverId: string, toolName: string): string =>
    `Allowed ${serverId}.${toolName} and updated Sandy's config file for future suitable tasks.`,

  userDeniedMcpResourceRead: (serverId: string, uri: string, reason?: string): string =>
    reason
      ? `The user denied MCP resource read ${serverId} ${uri}.\nReason: ${reason}`
      : `The user denied MCP resource read ${serverId} ${uri}.`,
  mcpResourceReadAllowedOnce: (serverId: string, uri: string): string =>
    `Allowed ${serverId} ${uri} once.`,
  mcpResourceReadAllowedForWorkerSession: (serverId: string, uri: string): string =>
    `Allowed ${serverId} ${uri} for this worker session.`,
  mcpResourceReadAllowedFromPersistentConfig: (serverId: string, uri: string): string =>
    `Allowed ${serverId} ${uri} from persistent config for this task.`,
  mcpResourceReadAllowedAndPersisted: (serverId: string, uri: string): string =>
    `Allowed ${serverId} ${uri} and updated Sandy's config file for future suitable tasks.`,

  httpTokenDenied: (tokenId: string, host: string, reason?: string): string =>
    reason
      ? `The user denied HTTP token use ${tokenId} for host ${host}.\nReason: ${reason}`
      : `The user denied HTTP token use ${tokenId} for host ${host}.`,
  httpTokenAllowedOnce: (tokenId: string, host: string): string =>
    `Allowed HTTP token ${tokenId} for host ${host} once.`,
  httpTokenAllowedForWorkerSession: (tokenId: string, host: string): string =>
    `Allowed HTTP token ${tokenId} for host ${host} for this worker session.`,
  httpTokenAllowedFromPersistentConfig: (tokenId: string, host: string): string =>
    `Allowed HTTP token ${tokenId} for host ${host} from persistent config for this task.`,
  httpTokenAllowedAndPersisted: (tokenId: string, host: string): string =>
    `Allowed HTTP token ${tokenId} for host ${host} and updated Sandy's config file for future suitable tasks.`,
  httpTokenProxyRejected: (tokenId: string): string =>
    `HTTP proxy rejected request for token ${tokenId} because no approval is active. Emit SANDY_REQUEST_HTTP_TOKEN for that token and wait for host approval before retrying.`,
  hostDirectoryAccessDenied: (path: string, level: string, reason?: string): string =>
    reason
      ? `The user denied host directory access to ${path} (${level}).\nReason: ${reason}`
      : `The user denied host directory access to ${path} (${level}).`,
  hostDirectoryAccessAllowedForWorkerSession: (path: string, level: string): string =>
    `Allowed host directory access to ${path} (${level}) for this worker session.`,
  hostDirectoryAccessAllowedFromPersistentConfig: (path: string, level: string): string =>
    `Allowed host directory access to ${path} (${level}) from persistent config for this task.`,
  hostDirectoryAccessAllowedAndPersisted: (path: string, level: string): string =>
    `Allowed host directory access to ${path} (${level}) and updated Sandy's config file for future suitable tasks.`,
  hostDirectoryAccessFailed: (path: string, error: string): string =>
    `Host directory access request for ${path} failed: ${error}`,

  skillMutationDenied: (operation: string, skillId: string, reason?: string): string =>
    reason
      ? `Denied ${operation} skill "${skillId}".\nReason: ${reason}`
      : `Denied ${operation} skill "${skillId}".`,
  skillMutationApproved: (operation: string, skillId: string): string =>
    `Approved ${operation} skill "${skillId}".`,
  skillMutationFailed: (operation: string, skillId: string, error: string): string =>
    `Failed to ${operation} skill "${skillId}": ${error}`,

  jobMutationDenied: (operation: string, jobId: string, reason?: string): string =>
    reason
      ? `Denied ${operation} job "${jobId}".\nReason: ${reason}`
      : `Denied ${operation} job "${jobId}".`,
  jobDoesNotExist: (jobId: string): string => `Job ${jobId} does not exist.`,
  jobMutationApproved: (operation: string, jobId: string): string =>
    `Approved ${operation} job "${jobId}".`,
  jobMutationFailed: (operation: string, jobId: string, error: string): string =>
    `Failed to ${operation} job "${jobId}": ${error}`,

  requestInteractionApproved: (): string =>
    "The task has been promoted to interactive mode. The user can now see your output and respond.",
  requestInteractionAlreadyInteractive: (): string =>
    "This task is already in interactive mode. No promotion is needed.",
  requestInteractionAlreadyRequested: (): string =>
    "This task is already waiting to become interactive. Sandy will notify you once the user can see your output.",
  terminateTaskApproved: (): string =>
    "This task has been marked for completion. Sandy will finalize it after the current turn.",
  terminateTaskNotJobTask: (): string =>
    "This tool is only available for scheduled job tasks. User-launched tasks are already interactive and can be cancelled by the user.",
} as const;
