import type {PrivilegeRequest} from "./privilege.js";
import type {MainAgentTaskPolicy} from "./main-agent.js";
import type {HostDirectoryAccessLevel} from "../hostfs/path-policy.ts";
import type { ChatId } from "./chat-events.js";

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
  | { kind: "launchedByJob"; jobId: string; jobName: string };

type JobTaskInteractionState = "silent" | "waitingToInteract" | "interacting";

export type ActiveTaskState = {
  readonly taskId: string;
  readonly taskName: string;
  status: TaskStatus;
  readonly startedAt: string;
  pendingPrivilegeRequest: PrivilegeRequest | null;
  readonly taskPolicy: MainAgentTaskPolicy;
  approvedMcpTools: McpToolGrant[];
  approvedMcpResourceReads: McpResourceReadGrant[];
  approvedHttpTokenSessionGrants: HttpTokenSessionGrant[];
  approvedHttpTokenOnceGrants: HttpTokenOnceGrant[];
  approvedHostDirectories: HostDirectoryGrant[];
  workerConnected: boolean;
  taskSummary: string | null;
  readonly origin: TaskOrigin;
  interactionState: JobTaskInteractionState;
};

export function createActiveTaskState(
  required: Pick<ActiveTaskState, "taskId" | "taskName" | "startedAt" | "taskPolicy" | "origin" | "interactionState">,
  overrides?: Partial<Omit<ActiveTaskState, "taskId" | "taskName" | "startedAt" | "taskPolicy" | "origin">>,
): ActiveTaskState {
  return {
    status: "running",
    pendingPrivilegeRequest: null,
    approvedMcpTools: [],
    approvedMcpResourceReads: [],
    approvedHttpTokenSessionGrants: [],
    approvedHttpTokenOnceGrants: [],
    approvedHostDirectories: [],
    workerConnected: false,
    taskSummary: null,
    ...required,
    ...overrides,
  };
}

type PendingShareDeletion = {
  kind: "share_deletion";
  requestId: string;
  taskId: string;
  taskName: string;
  summary: string;
};

type PendingSkillArchive = {
  kind: "skill_archive";
  requestId: string;
  skillId: string;
};

type PendingPrompt = PendingShareDeletion | PendingSkillArchive;

export class SessionState {
  chatId: ChatId;
  visibleTask: ActiveTaskState | null;
  backgroundJobTasks: ActiveTaskState[];
  pendingTaskSummary: {
    taskName: string;
    summary: string;
  } | null;
  pendingPrompt: PendingPrompt | null;

  constructor(chatId: ChatId) {
    this.chatId = chatId;
    this.visibleTask = null;
    this.backgroundJobTasks = [];
    this.pendingTaskSummary = null;
    this.pendingPrompt = null;
  }

  findTask(taskId: string): { task: ActiveTaskState; location: "visible" | "background"; } | null {
    if (this.visibleTask?.taskId === taskId) {
      return {
        task: this.visibleTask,
        location: "visible",
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
    if (this.visibleTask?.taskId === taskId) {
      const task = this.visibleTask;
      this.visibleTask = null;
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
    if (this.visibleTask) {
      throw new Error(`Cannot promote task ${taskId} while another visible task is active.`);
    }

    const task = this.removeTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} is no longer active.`);
    }

    this.visibleTask = task;
    return task;
  }
}
