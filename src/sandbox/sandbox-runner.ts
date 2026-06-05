import type {
  ChannelFormatting,
  ChatGPTExternalTokens,
  PrivilegeResolutionResult,
  SubAgentEvent,
  TaskInputPayload,
  WorkerStartConfig,
} from "../types.js";

export type LaunchTaskRequest = {
  chatId: string;
  taskId: string;
  taskName: string;
  taskBrief: string;
  taskLanguage: string;
  channelFormatting: ChannelFormatting;
  initialInput: TaskInputPayload;
  workerStartConfig: WorkerStartConfig;
};

export type ShareInspection = {
  isEmpty: boolean;
  summary: string | null;
};

export interface SandboxHandle {
  sendUserMessage(input: TaskInputPayload): Promise<void>;
  resolvePrivilege(result: PrivilegeResolutionResult): Promise<void>;
  markFinished(): Promise<void>;
  close(): Promise<void>;
  cancel(reason: string): Promise<void>;
  resolveAuthRefresh?(tokens: ChatGPTExternalTokens | null): Promise<void>;
}

export interface SandboxRunner {
  start?(): void;
  prepareTaskShare(taskId: string): Promise<string>;
  launchTask(request: LaunchTaskRequest, onEvent: (event: SubAgentEvent) => Promise<void>): Promise<SandboxHandle>;
  inspectTaskShare(taskId: string): Promise<ShareInspection>;
  deleteTaskShare(taskId: string): Promise<void>;
  getTaskSharePath(taskId: string): string;
  shutdown?(): Promise<void>;
}
