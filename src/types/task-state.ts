import type {PrivilegeRequest} from "./privilege.js";
import type {MainAgentTaskPolicy} from "./main-agent.js";
import type {HostDirectoryAccessLevel} from "../hostfs/path-policy.ts";
import type { ChatId } from "./chat-events.js";
import type { TranscriptEntry } from "./transcript.js";

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
  | "awaiting_denial_reason"
  | "completed"
  | "cancelled"
  | "failed";

/**
 * Allowed transitions for {@link ActiveTaskState.moveToState}.
 * Terminal states (completed/cancelled/failed) permit no further transitions.
 * `idle` is only ever left via construction; tasks start in `running`.
 */
const VALID_TASK_STATE_TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  idle: new Set<TaskStatus>(["running"]),
  running: new Set<TaskStatus>(["awaiting_privilege_decision", "awaiting_denial_reason", "completed", "cancelled", "failed"]),
  awaiting_privilege_decision: new Set<TaskStatus>(["running", "awaiting_denial_reason", "completed", "cancelled", "failed"]),
  awaiting_denial_reason: new Set<TaskStatus>(["running", "completed", "cancelled", "failed"]),
  completed: new Set<TaskStatus>(),
  cancelled: new Set<TaskStatus>(),
  failed: new Set<TaskStatus>(),
};

function isValidTaskStateTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TASK_STATE_TRANSITIONS[from].has(to);
}

export type TaskOrigin =
  | { kind: "launchedByUser" }
  | { kind: "launchedByJob"; jobId: string; jobName: string };

type JobTaskInteractionState = "silent" | "waitingToInteract" | "interacting";

type ActiveTaskStateRequired = Pick<
  ActiveTaskState,
  "taskId" | "taskName" | "startedAt" | "taskPolicy" | "origin" | "interactionState"
>;

type ActiveTaskStateOverrides = Partial<
  Omit<ActiveTaskState, "taskId" | "taskName" | "startedAt" | "taskPolicy" | "origin" | "status">
>;

type ActiveTaskStateInit = ActiveTaskStateRequired & ActiveTaskStateOverrides;

/**
 * Mutable per-task state. All fields are publicly readable/mutable except
 * {@link ActiveTaskState.status}, which is private and may only change through
 * {@link ActiveTaskState.moveToState} so every transition is validated.
 */
export class ActiveTaskState {
  readonly taskId: string;
  readonly taskName: string;
  readonly startedAt: string;
  readonly taskPolicy: MainAgentTaskPolicy;
  readonly origin: TaskOrigin;
  pendingPrivilegeRequest: PrivilegeRequest | null;
  approvedMcpTools: McpToolGrant[];
  approvedMcpResourceReads: McpResourceReadGrant[];
  approvedHttpTokenSessionGrants: HttpTokenSessionGrant[];
  approvedHttpTokenOnceGrants: HttpTokenOnceGrant[];
  approvedHostDirectories: HostDirectoryGrant[];
  workerConnected: boolean;
  taskSummary: string | null;
  interactionState: JobTaskInteractionState;
  #status: TaskStatus;

  constructor(init: ActiveTaskStateInit) {
    this.taskId = init.taskId;
    this.taskName = init.taskName;
    this.startedAt = init.startedAt;
    this.taskPolicy = init.taskPolicy;
    this.origin = init.origin;
    this.interactionState = init.interactionState;
    this.#status = "running";
    this.pendingPrivilegeRequest = init.pendingPrivilegeRequest ?? null;
    this.approvedMcpTools = init.approvedMcpTools ?? [];
    this.approvedMcpResourceReads = init.approvedMcpResourceReads ?? [];
    this.approvedHttpTokenSessionGrants = init.approvedHttpTokenSessionGrants ?? [];
    this.approvedHttpTokenOnceGrants = init.approvedHttpTokenOnceGrants ?? [];
    this.approvedHostDirectories = init.approvedHostDirectories ?? [];
    this.workerConnected = init.workerConnected ?? false;
    this.taskSummary = init.taskSummary ?? null;
  }

  get status(): TaskStatus {
    return this.#status;
  }

  /**
   * Transition the task to {@link next} status, throwing if the transition is
   * not permitted by {@link VALID_TASK_STATE_TRANSITIONS}. This is the only way
   * to mutate {@link status}.
   */
  moveToState(next: TaskStatus): void {
    const current = this.#status;
    if (!isValidTaskStateTransition(current, next)) {
      throw new Error(`Invalid task state transition: ${current} -> ${next}.`);
    }
    this.#status = next;
  }
}

type PendingShareDeletion = {
  requestId: string;
  taskId: string;
  taskName: string;
  summary: string;
};

export class SessionState {
  chatId: ChatId;
  visibleTask: ActiveTaskState | null;
  backgroundJobTasks: ActiveTaskState[];
  pendingTaskSummary: {
    taskName: string;
    summary: string;
    confirmationRequestId?: string;
  } | null;
  confirmedTaskSummaryEntries: TranscriptEntry[];
  pendingShareDeletion: PendingShareDeletion | null;

  constructor(chatId: ChatId) {
    this.chatId = chatId;
    this.visibleTask = null;
    this.backgroundJobTasks = [];
    this.pendingTaskSummary = null;
    this.confirmedTaskSummaryEntries = [];
    this.pendingShareDeletion = null;
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
