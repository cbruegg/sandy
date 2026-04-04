import type { PrivilegedWorkerToolPayload } from "../subagent/worker-tool-registry.js";

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
