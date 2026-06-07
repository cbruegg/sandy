import type { PrivilegeRequest } from "./privilege.js";
import type { MainAgentTaskPolicy } from "./main-agent.js";
import type {HostDirectoryAccessLevel} from "../hostfs/path-policy.ts";

type McpToolGrant = {
  serverId: string;
  toolName: string;
};

type McpResourceReadGrant = {
  serverId: string;
  uri: string;
};

type HttpTokenOnceGrant = {
  tokenId: string;
  host: string;
  consumed: boolean;
};

type HttpTokenSessionGrant = {
  tokenId: string;
  host: string;
};

type HostDirectoryGrant = {
  path: string;
  level: HostDirectoryAccessLevel;
};

type TaskStatus =
  | "idle"
  | "running"
  | "awaiting_privilege_decision"
  | "completed"
  | "cancelled"
    | "failed";

type TaskOrigin =
  | { kind: "launchedByUser"; chatId: string }
  | { kind: "launchedByJob"; jobId: string };

type JobTaskInteractionState = "silent" | "waitingToInteract" | "interacting";

export type ActiveTaskState = {
  taskId: string;
  taskName: string;
  status: TaskStatus;
  startedAt: string;
  lastActivityAt: string;
  pendingPrivilegeRequest: PrivilegeRequest | null;
  taskPolicy: MainAgentTaskPolicy;
  approvedMcpTools: McpToolGrant[];
  approvedMcpResourceReads: McpResourceReadGrant[];
  approvedHttpTokenSessionGrants: HttpTokenSessionGrant[];
  approvedHttpTokenOnceGrants: HttpTokenOnceGrant[];
  approvedHostDirectories: HostDirectoryGrant[];
  workerConnected: boolean;
  taskSummary: string | null;
  origin?: TaskOrigin;
  interactionState?: JobTaskInteractionState;
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
