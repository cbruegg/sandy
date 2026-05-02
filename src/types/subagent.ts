import {z} from "zod";
import type {PrivilegeResolutionResult} from "./privilege.js";
import type {ChannelFormatting} from "./channel.js";
import type {ImageAttachment} from "../subagent/worker-prompt.js";

type ProgressEvent = {
  type: "progress";
  message: string;
};

type AssistantOutputEvent = {
  type: "assistant_output";
  text: string;
};

type FinalResultEvent = {
  type: "final_result";
  text: string;
};

type TaskSummaryEvent = {
  type: "task_summary";
  summary: string;
};

type TaskDoneEvent = {
  type: "task_done";
};

type TaskErrorEvent = {
  type: "task_error";
  message: string;
};

type WorkerConnectedEvent = {
  type: "worker_connected";
};

type WorkerDisconnectedEvent = {
  type: "worker_disconnected";
  message: string;
};

type WorkerLogEvent = {
  type: "worker_log";
  level: "debug" | "info" | "warn" | "error";
  event: string;
  data?: Record<string, unknown>;
};

type ChatgptAuthRefreshRequestEvent = {
  type: "chatgpt_auth_refresh_request";
  previousAccountId: string | null;
};

export type SubAgentEvent =
  | ProgressEvent
  | AssistantOutputEvent
  | FinalResultEvent
  | TaskSummaryEvent
  | TaskDoneEvent
  | TaskErrorEvent
  | WorkerConnectedEvent
  | WorkerDisconnectedEvent
  | WorkerLogEvent
  | ChatgptAuthRefreshRequestEvent;

export type TaskInputPayload = {
  text: string;
  images: ImageAttachment[];
};

export type ChatGPTExternalTokens = {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
};

export type WorkerStartConfig = {
  openAiApiKey: string | null;
  codexModel: string | null;
  channelFormatting: ChannelFormatting | null;
  httpTokens: Array<{
    tokenId: string;
    description: string;
  }>;
  httpProxyWrapper: string | null;
  chatgptExternalTokens: ChatGPTExternalTokens | null;
};

export type HostCommand =
  | {
      type: "start_task";
      taskId: string;
      taskBrief: string;
      input: TaskInputPayload;
      taskLanguage: string;
      config: WorkerStartConfig;
      environment: Record<string, string>;
      codexConfigToml: string | null;
      httpProxyUrl: string | null;
    }
  | {
      type: "user_message";
      input: TaskInputPayload;
    }
  | {
      type: "privilege_result";
      result: PrivilegeResolutionResult;
    }
  | {
      type: "cancel";
      reason: string;
    }
  | {
      type: "mark_finished";
    }
  | {
      type: "chatgpt_auth_refresh_result";
      tokens: ChatGPTExternalTokens | null;
      error: string | null;
    };

const subAgentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    message: z.string(),
  }).strict(),
  z.object({
    type: z.literal("assistant_output"),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal("final_result"),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal("task_summary"),
    summary: z.string(),
  }).strict(),
  z.object({
    type: z.literal("task_done"),
  }).strict(),
  z.object({
    type: z.literal("task_error"),
    message: z.string(),
  }).strict(),
  z.object({
    type: z.literal("worker_connected"),
  }).strict(),
  z.object({
    type: z.literal("worker_disconnected"),
    message: z.string(),
  }).strict(),
  z.object({
    type: z.literal("worker_log"),
    level: z.enum(["debug", "info", "warn", "error"]),
    event: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    type: z.literal("chatgpt_auth_refresh_request"),
    previousAccountId: z.string().nullable(),
  }).strict(),
]);

export function parseSubAgentEvent(raw: string): SubAgentEvent {
  return subAgentEventSchema.parse(JSON.parse(raw));
}

export function serializeHostCommand(command: HostCommand): string {
  return JSON.stringify(command);
}
