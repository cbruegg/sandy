import type {PrivilegedWorkerToolPayload} from "../subagent/worker-tool-registry.js";

export type PrivilegeRequest = {
  requestId: string;
  payload: PrivilegedWorkerToolPayload;
};
export type PrivilegeResolutionResult = {
  requestId: string;
  outcome: "approved" | "denied" | "rejected" | "failed";
  message: string;
};
