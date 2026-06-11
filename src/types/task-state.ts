import type {PrivilegeRequest} from "./privilege.js";
import type {MainAgentTaskPolicy} from "./main-agent.js";
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

export type TaskOrigin =
  | { kind: "launchedByUser" }
  | { kind: "launchedByJob"; jobId: string };

type JobTaskInteractionState = "silent" | "waitingToInteract" | "interacting";

export type ActiveTaskState = {
  taskId: string;
  taskName: string;
  status: TaskStatus;
  startedAt: string;
  pendingPrivilegeRequest: PrivilegeRequest | null;
  taskPolicy: MainAgentTaskPolicy;
  approvedMcpTools: McpToolGrant[];
  approvedMcpResourceReads: McpResourceReadGrant[];
  approvedHttpTokenSessionGrants: HttpTokenSessionGrant[];
  approvedHttpTokenOnceGrants: HttpTokenOnceGrant[];
  approvedHostDirectories: HostDirectoryGrant[];
  workerConnected: boolean;
  taskSummary: string | null;
  origin: TaskOrigin;
  interactionState: JobTaskInteractionState;
};

type PendingShareDeletion = {
  requestId: string;
  taskId: string;
  taskName: string;
  summary: string;
};

export class SessionState {
  chatId: string;
  activeTask: ActiveTaskState | null;
  backgroundJobTasks: ActiveTaskState[];
  pendingTaskSummary: {
    taskName: string;
    summary: string;
  } | null;
  pendingShareDeletion: PendingShareDeletion | null;

  constructor(chatId: string) {
    this.chatId = chatId;
    this.activeTask = null;
    this.backgroundJobTasks = [];
    this.pendingTaskSummary = null;
    this.pendingShareDeletion = null;
  }

  findTask(taskId: string): { task: ActiveTaskState; location: "active" | "background"; } | null {
    if (this.activeTask?.taskId === taskId) {
      return {
        task: this.activeTask,
        location: "active",
      };
    }

    const index = this.backgroundJobTasks.findIndex((task) => task.taskId === taskId);
    if (index === -1) {
      return null;
    }

    const task = this.backgroundJobTasks[index];
    if (!task) {
      return null;
    }

    return {
      task,
      location: "background",
    };
  }

  removeTask(taskId: string): ActiveTaskState | null {
    if (this.activeTask?.taskId === taskId) {
      const task = this.activeTask;
      this.activeTask = null;
      return task;
    }

    const index = this.backgroundJobTasks.findIndex((task) => task.taskId === taskId);
    if (index === -1) {
      return null;
    }

    const [task] = this.backgroundJobTasks.splice(index, 1);
    return task ?? null;
  }

  promoteBackgroundJobTask(taskId: string): ActiveTaskState {
    if (this.activeTask) {
      throw new Error(`Cannot promote task ${taskId} while another visible task is active.`);
    }

    const task = this.removeTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} is no longer active.`);
    }

    this.activeTask = task;
    return task;
  }
}
