import type { ChannelFormatting, PrivilegeResolutionResult, SubAgentEvent } from "../types.js";

export type LaunchTaskRequest = {
  chatId: string;
  taskId: string;
  taskName: string;
  taskBrief: string;
  channelFormatting: ChannelFormatting;
};

export type ShareInspection = {
  isEmpty: boolean;
  summary: string | null;
};

export interface SandboxHandle {
  sendUserMessage(text: string): Promise<void>;
  resolvePrivilege(result: PrivilegeResolutionResult): Promise<void>;
  markFinished(): Promise<void>;
  close(): Promise<void>;
  cancel(reason: string): Promise<void>;
}

export interface SandboxRunner {
  launchTask(request: LaunchTaskRequest, onEvent: (event: SubAgentEvent) => Promise<void>): Promise<SandboxHandle>;
  inspectTaskShare(taskId: string): Promise<ShareInspection>;
  deleteTaskShare(taskId: string): Promise<void>;
  getTaskSharePath(taskId: string): string;
}
