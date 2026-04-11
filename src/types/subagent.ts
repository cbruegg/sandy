import {z} from "zod";
import type {WorkerToolPayload} from "../subagent/worker-tool-registry.js";
import {createWorkerToolPayloadSchema} from "../subagent/worker-tool-registry.js";
import type {PrivilegeResolutionResult} from "./privilege.js";

const workerToolCallSchema = createWorkerToolPayloadSchema((entry) => entry.name !== "complete_task");
type HostMediatedWorkerToolPayload = Exclude<WorkerToolPayload, { type: "complete_task" }>;

export type ProgressEvent = {
  type: "progress";
  message: string;
};

export type AssistantOutputEvent = {
  type: "assistant_output";
  text: string;
};

export type FinalResultEvent = {
  type: "final_result";
  text: string;
};

export type TaskSummaryEvent = {
  type: "task_summary";
  summary: string;
};

export type ToolCallEvent = {
  type: "tool_call";
  call: HostMediatedWorkerToolPayload;
};

export type TaskDoneEvent = {
  type: "task_done";
};

export type TaskErrorEvent = {
  type: "task_error";
  message: string;
};

export type WorkerConnectedEvent = {
  type: "worker_connected";
};

export type WorkerDisconnectedEvent = {
  type: "worker_disconnected";
  message: string;
};

export type SubAgentEvent =
  | ProgressEvent
  | AssistantOutputEvent
  | FinalResultEvent
  | TaskSummaryEvent
  | ToolCallEvent
  | TaskDoneEvent
  | TaskErrorEvent
  | WorkerConnectedEvent
  | WorkerDisconnectedEvent;

export type HostCommand =
  | {
      type: "user_message";
      text: string;
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
    type: z.literal("tool_call"),
    call: workerToolCallSchema,
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
]);

export function parseSubAgentEvent(raw: string): SubAgentEvent {
  return subAgentEventSchema.parse(JSON.parse(raw)) as SubAgentEvent;
}

export function serializeHostCommand(command: HostCommand): string {
  return JSON.stringify(command);
}
