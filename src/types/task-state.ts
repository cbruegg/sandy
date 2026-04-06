import type { PrivilegeRequest } from "./privilege.js";

export type McpToolGrant = {
  serverId: string;
  toolName: string;
};

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
  approvedMcpTools: McpToolGrant[];
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
  approvedMcpTools: McpToolGrant[];
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
