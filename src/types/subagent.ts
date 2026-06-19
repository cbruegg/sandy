import {z} from "zod";
import type {PrivilegeResolutionResult} from "./privilege.js";
import type {ChannelFormatting} from "./channel.js";
import type {ImageAttachment} from "../subagent/worker-prompt.js";

const progressEventSchema = z.object({
  type: z.literal("progress"),
  message: z.string(),
}).strict();

const assistantOutputEventSchema = z.object({
  type: z.literal("assistant_output"),
  text: z.string(),
  phase: z.enum(["commentary", "final_answer"]).nullable(),
}).strict();

const finalResultEventSchema = z.object({
  type: z.literal("final_result"),
  text: z.string(),
}).strict();

const taskSummaryEventSchema = z.object({
  type: z.literal("task_summary"),
  summary: z.string(),
}).strict();

const taskDoneEventSchema = z.object({
  type: z.literal("task_done"),
}).strict();

const taskErrorEventSchema = z.object({
  type: z.literal("task_error"),
  message: z.string(),
}).strict();

const workerConnectedEventSchema = z.object({
  type: z.literal("worker_connected"),
}).strict();

const workerDisconnectedEventSchema = z.object({
  type: z.literal("worker_disconnected"),
  message: z.string(),
}).strict();

const workerLogEventSchema = z.object({
  type: z.literal("worker_log"),
  level: z.enum(["debug", "info", "warn", "error"]),
  event: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
}).strict();

const chatGPTAuthRefreshRequestEventSchema = z.object({
  type: z.literal("chatgpt_auth_refresh_request"),
  previousAccountId: z.string().nullable(),
}).strict();

export type TaskInputPayload = {
  text: string;
  images: ImageAttachment[];
};

export type ChatGPTExternalTokens = {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
};

export type WorkerAuthConfig =
  | { mode: "ambient_api_key"; openAiApiKey: string }
  | { mode: "ambient_auth_file" }
  | { mode: "external_tokens"; tokens: ChatGPTExternalTokens };

export type WorkerStartConfig = {
  auth: WorkerAuthConfig;
  codexModel: string | null;
  channelFormatting: ChannelFormatting | null;
  httpTokens: Array<{
    tokenId: string;
    description: string;
  }>;
  httpProxyWrapper: string | null;
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
      type: "task_became_interactive";
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
  progressEventSchema,
  assistantOutputEventSchema,
  finalResultEventSchema,
  taskSummaryEventSchema,
  taskDoneEventSchema,
  taskErrorEventSchema,
  workerConnectedEventSchema,
  workerDisconnectedEventSchema,
  workerLogEventSchema,
  chatGPTAuthRefreshRequestEventSchema,
]);

export type SubAgentEvent = z.infer<typeof subAgentEventSchema>;

export function parseSubAgentEvent(raw: string): SubAgentEvent {
  return subAgentEventSchema.parse(JSON.parse(raw));
}

export function serializeHostCommand(command: HostCommand): string {
  return JSON.stringify(command);
}
