import type { PrivilegeRequest } from "./types.js";

export const buttonLabels = {
  reportDangerousOutput: "Report dangerous output",
  cancelTask: "Cancel task",
  approve: "Approve",
  deny: "Deny",
} as const;

export const messages = {
  unsupportedInput: (inputType: string): string =>
    `This v1 build only supports text messages. Received unsupported ${inputType} input.`,
  taskComplete: (text: string): string => `Task complete:\n${text}`,
  taskCompleted: (taskId: string): string => `Task "${taskId}" completed.`,
  taskFailed: (message: string): string => `Task failed: ${message}`,
  noActiveTaskToCancel: (): string => "There is no active task to cancel.",
  noPendingPrivilegeRequest: (): string => "There is no pending privilege request.",
  noActiveOutputToReport: (): string => "There is no active sub-agent output to report.",
  discardedPendingOutput: (): string => "Discarded the pending sub-agent output.",
  taskCancelled: (taskName: string): string => `Cancelled task "${taskName}".`,
  noPendingOutputToReport: (): string => "There is no pending sub-agent output to report.",
  taskTerminatedAndDiscarded: (taskName: string): string =>
    `Terminated task "${taskName}" and discarded the pending sub-agent output.`,
  stalePrivilegeRequest: (): string => "That privilege request is no longer pending.",
  privilegeRequestStillPending: (): string =>
    "A privilege request is pending. Reply with approve or deny before sending more task input.",
  taskStarted: (taskName: string): string =>
    `Started task "${taskName}". You will receive progress updates here.`,
  privilegeApproved: (requestId: string): string => `Approved privilege request ${requestId}.`,
  privilegeDenied: (requestId: string): string => `Denied privilege request ${requestId}.`,
  privilegeRequestPrompt: (request: PrivilegeRequest): string =>
    `Privilege request:\n${describePrivilegeRequest(request)}\n\nApprove or deny this request.`,
} as const;

function describePrivilegeRequest(request: PrivilegeRequest): string {
  switch (request.type) {
    case "copy_into_share":
    case "copy_out_of_share":
      return `${request.type}: ${request.sourcePath} -> ${request.targetPath}\nReason: ${request.reason}`;
    case "mount_ro":
    case "mount_rw":
      return `${request.type}: ${request.hostPath} -> ${request.targetPath}\nReason: ${request.reason}`;
    case "enable_mcp":
    case "enable_onecli":
      return `${request.type}: ${request.identifier}\nReason: ${request.reason}`;
  }
}
