import type { MainAgentController } from "../agent/main-agent-controller.js";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import type { HostfsBroker } from "../hostfs/hostfs-broker.js";
import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import type { SandboxRunner } from "../sandbox/sandbox-runner.js";
import type { SessionStore } from "../session/in-memory-session-store.js";
import type {
  ChatGPTExternalTokens,
  ChannelFormatting,
  NormalizedChatEvent,
  SessionState,
  WorkerStartConfig,
} from "../types.js";
import type { PrivilegeBroker } from "../privilege/privilege-broker.js";
import type { SkillService } from "../skills.js";
import type { OrchestratorTaskLifecycle } from "./task-lifecycle.js";
import type { OrchestratorPrivileges } from "./privileges.js";

export type SupportedChatEvent = Exclude<NormalizedChatEvent, { kind: "unsupported_input" }>;
export type UserMessageEvent = Extract<NormalizedChatEvent, { kind: "user_message" }>;
export type ActiveTaskStatus = NonNullable<SessionState["activeTask"]>["status"];

export type OrchestratorCoreDependencies = {
  channel: ChannelAdapter;
  mainAgent: MainAgentController;
  sandboxRunner: SandboxRunner;
  buildWorkerStartConfig: () => Promise<WorkerStartConfig>;
  refreshChatGPTTokens?: (taskId: string, previousAccountId: string | null) => Promise<ChatGPTExternalTokens | null>;
  sessionStore: SessionStore;
  privilegeBroker: PrivilegeBroker;
  persistentApprovalStore: PersistentApprovalStore;
  hostfsBroker: HostfsBroker;
  skillService: SkillService;
};

export type SandyOrchestratorDependencies = OrchestratorCoreDependencies & {
  channelFormatting: ChannelFormatting;
  taskLifecycle: OrchestratorTaskLifecycle;
  privileges: OrchestratorPrivileges;
};
