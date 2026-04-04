import { z } from "zod";
import { createWorkerToolPayloadSchema } from "../subagent/worker-tool-registry.js";
import type { PrivilegedWorkerToolPayload } from "../subagent/worker-tool-registry.js";

export const privilegeRequestPayloadSchema = createWorkerToolPayloadSchema(
  (entry) => entry.definition.requiresPrivilegeEscalation,
);

// TODO: Delete unused code (introduce linter for that)
export const privilegeRequestSchema = z.object({
  requestId: z.string(),
  payload: privilegeRequestPayloadSchema,
}).strict();

export const privilegeResolutionResultSchema = z.object({
  requestId: z.string(),
  outcome: z.enum(["approved", "denied", "rejected", "failed"]),
  message: z.string(),
}).strict();

export type PrivilegeRequestPayload = PrivilegedWorkerToolPayload;
export type PrivilegeRequest = {
  requestId: string;
  payload: PrivilegeRequestPayload;
};
export type PrivilegeResolutionResult = {
  requestId: string;
  outcome: "approved" | "denied" | "rejected" | "failed";
  message: string;
};
