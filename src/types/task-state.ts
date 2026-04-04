import type { PrivilegeRequest } from "./privilege.js";

export type TaskStatus =
  | "idle"
  | "running"
  | "awaiting_privilege_decision"
  | "completed"
  | "cancelled"
  | "failed";

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

export type PendingShareDeletion = {
  requestId: string;
  taskId: string;
  taskName: string;
  summary: string;
};

export type SessionState = {
  chatId: string;
  activeTask: ActiveTaskState | null;
  pendingQuarantinedOutputs: string[];
  pendingShareDeletion: PendingShareDeletion | null;
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
