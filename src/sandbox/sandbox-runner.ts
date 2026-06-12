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
  taskLanguage: string;
  channelFormatting: ChannelFormatting;
  workerStartConfig: WorkerStartConfig;
  prepareStartInput: (taskSharePath: string) => Promise<TaskStartInput>;
};

export type TaskStartInput = {
  taskBrief: string;
  initialInput: TaskInputPayload;
};

export type ShareInspection = {
  isEmpty: boolean;
  summary: string | null;
};

export type SandboxTaskBundle = {
  bundleId: string;
  hostfsVolumeName: string | null;
};

export interface SandboxHandle {
  getTaskSharePath(): string;
  getTaskBundle(): SandboxTaskBundle;
  sendUserMessage(input: TaskInputPayload): Promise<void>;
  notifyTaskBecameInteractive(): Promise<void>;
  resolvePrivilege(result: PrivilegeResolutionResult): Promise<void>;
  markFinished(): Promise<void>;
  close(): Promise<void>;
  cancel(reason: string): Promise<void>;
  resolveAuthRefresh?(tokens: ChatGPTExternalTokens | null): Promise<void>;
}

export interface SandboxRunner {
  start?(): void;
  launchTask(request: LaunchTaskRequest, onEvent: (event: SubAgentEvent) => Promise<void>): Promise<SandboxHandle>;
  inspectTaskShare(taskId: string): Promise<ShareInspection>;
  deleteTaskShare(taskId: string): Promise<void>;
  shutdown?(): Promise<void>;
}
