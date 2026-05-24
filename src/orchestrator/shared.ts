import type { MainAgentController } from "../agent/main-agent-controller.js";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import type { HostfsBroker } from "../hostfs/hostfs-broker.js";
import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import type { SandboxRunner } from "../sandbox/sandbox-runner.js";
import type { TaskBundleAssignmentLookup } from "../sandbox/task-bundle-assignment-registry.js";
import type { SessionStore } from "../session/in-memory-session-store.js";
import type { ChatGptExternalTokens, NormalizedChatEvent, SessionState, WorkerStartConfig } from "../types.js";
import type { PrivilegeBroker } from "../privilege/privilege-broker.js";

export type SupportedChatEvent = Exclude<NormalizedChatEvent, { kind: "unsupported_input" }>;
export type UserMessageEvent = Extract<NormalizedChatEvent, { kind: "user_message" }>;
export type ActiveTaskStatus = NonNullable<SessionState["activeTask"]>["status"];

export type SandyOrchestratorDependencies = {
  channel: ChannelAdapter;
  mainAgent: MainAgentController;
  sandboxRunner: SandboxRunner;
  buildWorkerStartConfig: () => WorkerStartConfig | Promise<WorkerStartConfig>;
  refreshChatGptTokens?: (taskId: string, previousAccountId: string | null) => Promise<ChatGptExternalTokens | null>;
  sessionStore: SessionStore;
  privilegeBroker: PrivilegeBroker;
  persistentApprovalStore: PersistentApprovalStore;
  hostfsBroker: HostfsBroker;
  taskBundleAssignmentRegistry: TaskBundleAssignmentLookup;
};
