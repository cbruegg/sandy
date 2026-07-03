import type { MainAgentController } from "../agent/main-agent-controller.js";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import type { ChannelDestinationStore } from "../channel/channel-destination-store.js";
import type { HostfsBroker } from "../hostfs/hostfs-broker.js";
import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import type { SandboxRunner } from "../sandbox/sandbox-runner.js";
import type { SessionStore } from "../session/in-memory-session-store.js";
import type { JobApprovalStoreApi } from "../jobs/job-approval-store.js";
import type {
  ActiveTaskState,
  ChatGPTExternalTokens,
  ChannelFormatting,
  NormalizedChatEvent,
  SessionState,
  WorkerStartConfig,
} from "../types.js";
import type { SkillService } from "../skills.js";
import type { OrchestratorTaskLifecycle } from "./task-lifecycle.js";
import type { OrchestratorPrivileges } from "./privileges.js";
import type { CommentaryBufferManager } from "./commentary-buffer-manager.js";
import type { TaskCoordinator } from "./task-coordinator.js";
import type { TaskMemoryContextCollector } from "../memory/task-memory-context-collector.js";

export type SupportedChatEvent = Exclude<NormalizedChatEvent, { kind: "unsupported_input" }>;
export type UserMessageEvent = Extract<NormalizedChatEvent, { kind: "user_message" }>;
export type ActiveTaskStatus = ActiveTaskState["status"];

export type OrchestratorCoreDependencies = {
  mainAgent: MainAgentController;
  sandboxRunner: SandboxRunner;
  buildWorkerStartConfig: () => Promise<WorkerStartConfig>;
  refreshChatGPTTokens?: (taskId: string, previousAccountId: string | null) => Promise<ChatGPTExternalTokens | null>;
  sessionStore: SessionStore;
  persistentApprovalStore: PersistentApprovalStore;
  jobApprovalStore: JobApprovalStoreApi;
  hostfsBroker: HostfsBroker;
  skillService: SkillService;
  memoryContextCollector: TaskMemoryContextCollector;
  taskCoordinator: TaskCoordinator;
  commentaryBuffer: CommentaryBufferManager;
};

export type SandyOrchestratorDependencies = OrchestratorCoreDependencies & {
  channel: ChannelAdapter;
  destinationStore: ChannelDestinationStore;
  channelFormatting: ChannelFormatting;
  taskLifecycle: OrchestratorTaskLifecycle;
  privileges: OrchestratorPrivileges;
};

export interface TaskFailureHandler {
  failActiveTaskFromEventHandling(session: SessionState, taskId: string, message: string): Promise<void>;
}
