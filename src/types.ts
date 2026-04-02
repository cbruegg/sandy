export type TranscriptRole = "user" | "assistant" | "system";

export type TranscriptEntry = {
  role: TranscriptRole;
  kind: string;
  timestamp: string;
  text?: string;
  metadata?: Record<string, string | boolean>;
};

type ChatEventBase = {
  chatId: string;
  messageId: string;
  timestamp: string;
};

export type UserTextEvent = ChatEventBase & {
  kind: "user_text";
  text: string;
  rawText: string;
};

export type CancelRequestEvent = ChatEventBase & {
  kind: "cancel_request";
};

export type ApprovalResponseEvent = ChatEventBase & {
  kind: "approval_response";
  decision: "approve" | "deny";
  requestId?: string;
};

export type DangerReportEvent = ChatEventBase & {
  kind: "danger_report";
};

export type UnsupportedInputEvent = ChatEventBase & {
  kind: "unsupported_input";
  inputType: "image" | "file" | "voice";
};

export type NormalizedChatEvent =
  | UserTextEvent
  | CancelRequestEvent
  | ApprovalResponseEvent
  | DangerReportEvent
  | UnsupportedInputEvent;

export type TaskStatus =
  | "idle"
  | "running"
  | "awaiting_privilege_decision"
  | "completed"
  | "cancelled"
  | "failed";

type BasePrivilegeRequest = {
  requestId: string;
  reason: string;
};

export type CopyIntoShareRequest = BasePrivilegeRequest & {
  type: "copy_into_share";
  sourcePath: string;
  targetPath: string;
};

export type CopyOutOfShareRequest = BasePrivilegeRequest & {
  type: "copy_out_of_share";
  sourcePath: string;
  targetPath: string;
};

export type MountRequest = BasePrivilegeRequest & {
  type: "mount_ro" | "mount_rw";
  hostPath: string;
  targetPath: string;
};

export type ResourceEnableRequest = BasePrivilegeRequest & {
  type: "enable_mcp" | "enable_onecli";
  identifier: string;
};

export type PrivilegeRequest =
  | CopyIntoShareRequest
  | CopyOutOfShareRequest
  | MountRequest
  | ResourceEnableRequest;

export type MainAgentDecision =
  | {
      action: "reply";
      replyText: string;
    }
  | {
      action: "launch_task";
      taskBrief: string;
      taskName: string;
    };

export type TaskMetadata = {
  taskId: string;
  taskName: string;
  status: TaskStatus;
  startedAt: string;
  lastActivityAt: string;
  hasPendingQuarantinedOutput: boolean;
  hasPendingPrivilegeRequest: boolean;
  approvedResourceIdentifiers: string[];
  workerConnected: boolean;
};

export type DecideContext = {
  chatId: string;
  transcript: TranscriptEntry[];
  activeTask: TaskMetadata | null;
};

export type ProgressEvent = {
  type: "progress";
  message: string;
};

export type AssistantOutputEvent = {
  type: "assistant_output";
  text: string;
};

export type FinalResultEvent = {
  type: "final_result";
  text: string;
};

export type PrivilegeRequestEvent = {
  type: "privilege_request";
  request: PrivilegeRequest;
};

export type TaskDoneEvent = {
  type: "task_done";
};

export type TaskErrorEvent = {
  type: "task_error";
  message: string;
};

export type WorkerConnectedEvent = {
  type: "worker_connected";
};

export type WorkerDisconnectedEvent = {
  type: "worker_disconnected";
  message: string;
};

export type SubAgentEvent =
  | ProgressEvent
  | AssistantOutputEvent
  | FinalResultEvent
  | PrivilegeRequestEvent
  | TaskDoneEvent
  | TaskErrorEvent
  | WorkerConnectedEvent
  | WorkerDisconnectedEvent;

export type HostCommand =
  | {
      type: "user_message";
      text: string;
    }
  | {
      type: "privilege_decision";
      requestId: string;
      decision: "approve" | "deny";
    }
  | {
      type: "cancel";
      reason: string;
    };

export type ActiveTaskState = {
  taskId: string;
  taskName: string;
  taskBrief: string;
  status: TaskStatus;
  startedAt: string;
  lastActivityAt: string;
  pendingPrivilegeRequest: PrivilegeRequest | null;
  quarantinedOutputs: string[];
  approvedResourceIdentifiers: string[];
  workerConnected: boolean;
};

export type SessionState = {
  chatId: string;
  transcript: TranscriptEntry[];
  mainThreadId: string | null;
  activeTask: ActiveTaskState | null;
  pendingQuarantinedOutputs: string[];
};

export function toTaskMetadata(task: ActiveTaskState): TaskMetadata {
  return {
    taskId: task.taskId,
    taskName: task.taskName,
    status: task.status,
    startedAt: task.startedAt,
    lastActivityAt: task.lastActivityAt,
    hasPendingQuarantinedOutput: task.quarantinedOutputs.length > 0,
    hasPendingPrivilegeRequest: task.pendingPrivilegeRequest !== null,
    approvedResourceIdentifiers: [...task.approvedResourceIdentifiers],
    workerConnected: task.workerConnected,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function parseMainAgentDecision(raw: string): MainAgentDecision {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isString(parsed.action)) {
    throw new Error("Main agent returned an invalid decision payload.");
  }
  if (parsed.action === "reply" && isString(parsed.replyText)) {
    return { action: "reply", replyText: parsed.replyText };
  }
  if (
    parsed.action === "launch_task" &&
    isString(parsed.taskBrief) &&
    isString(parsed.taskName)
  ) {
    return {
      action: "launch_task",
      taskBrief: parsed.taskBrief,
      taskName: parsed.taskName,
    };
  }
  throw new Error("Main agent returned an unsupported decision.");
}

function parsePrivilegeRequest(payload: unknown): PrivilegeRequest {
  if (!isRecord(payload) || !isString(payload.type) || !isString(payload.requestId) || !isString(payload.reason)) {
    throw new Error("Invalid privilege request payload.");
  }

  switch (payload.type) {
    case "copy_into_share":
    case "copy_out_of_share":
      if (isString(payload.sourcePath) && isString(payload.targetPath)) {
        return {
          type: payload.type,
          requestId: payload.requestId,
          reason: payload.reason,
          sourcePath: payload.sourcePath,
          targetPath: payload.targetPath,
        };
      }
      break;
    case "mount_ro":
    case "mount_rw":
      if (isString(payload.hostPath) && isString(payload.targetPath)) {
        return {
          type: payload.type,
          requestId: payload.requestId,
          reason: payload.reason,
          hostPath: payload.hostPath,
          targetPath: payload.targetPath,
        };
      }
      break;
    case "enable_mcp":
    case "enable_onecli":
      if (isString(payload.identifier)) {
        return {
          type: payload.type,
          requestId: payload.requestId,
          reason: payload.reason,
          identifier: payload.identifier,
        };
      }
      break;
    default:
      break;
  }

  throw new Error("Unsupported privilege request payload.");
}

export function parseSubAgentEvent(raw: string): SubAgentEvent {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isString(parsed.type)) {
    throw new Error("Invalid sub-agent event payload.");
  }

  switch (parsed.type) {
    case "progress":
      if (isString(parsed.message)) {
        return { type: "progress", message: parsed.message };
      }
      break;
    case "assistant_output":
      if (isString(parsed.text)) {
        return { type: "assistant_output", text: parsed.text };
      }
      break;
    case "final_result":
      if (isString(parsed.text)) {
        return { type: "final_result", text: parsed.text };
      }
      break;
    case "privilege_request":
      return {
        type: "privilege_request",
        request: parsePrivilegeRequest(parsed.request),
      };
    case "task_done":
      return { type: "task_done" };
    case "task_error":
      if (isString(parsed.message)) {
        return { type: "task_error", message: parsed.message };
      }
      break;
    case "worker_connected":
      return { type: "worker_connected" };
    case "worker_disconnected":
      if (isString(parsed.message)) {
        return { type: "worker_disconnected", message: parsed.message };
      }
      break;
    default:
      break;
  }

  throw new Error("Unsupported sub-agent event payload.");
}

export function serializeHostCommand(command: HostCommand): string {
  return JSON.stringify(command);
}
