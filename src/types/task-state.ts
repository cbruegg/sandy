import type { PrivilegeRequest } from "./privilege.js";

type McpToolGrant = {
  serverId: string;
  toolName: string;
};

type HttpTokenGrant = {
  tokenId: string;
  host: string;
  consumed: boolean;
};

type TaskStatus =
  | "idle"
  | "running"
  | "awaiting_privilege_decision"
  | "completed"
  | "cancelled"
  | "failed";

export type ActiveTaskState = {
  taskId: string;
  taskName: string;
  taskBrief: string;
  status: TaskStatus;
  startedAt: string;
  lastActivityAt: string;
  pendingPrivilegeRequest: PrivilegeRequest | null;
  approvedMcpTools: McpToolGrant[];
  approvedHttpTokens: HttpTokenGrant[];
  workerConnected: boolean;
  hasReportableOutput: boolean;
  taskSummary: string | null;
};

type PendingShareDeletion = {
  requestId: string;
  taskId: string;
  taskName: string;
  summary: string;
};

export type SessionState = {
  chatId: string;
  activeTask: ActiveTaskState | null;
  pendingTaskSummary: {
    taskName: string;
    summary: string;
  } | null;
  pendingShareDeletion: PendingShareDeletion | null;
};
