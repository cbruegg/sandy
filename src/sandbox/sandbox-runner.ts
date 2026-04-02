import type { SubAgentEvent } from "../types.js";

export type LaunchTaskRequest = {
  chatId: string;
  taskId: string;
  taskName: string;
  taskBrief: string;
};

export interface SandboxHandle {
  sendUserMessage(text: string): Promise<void>;
  resolvePrivilege(requestId: string, decision: "approve" | "deny"): Promise<void>;
  cancel(reason: string): Promise<void>;
}

export interface SandboxRunner {
  launchTask(request: LaunchTaskRequest, onEvent: (event: SubAgentEvent) => Promise<void>): Promise<SandboxHandle>;
}
