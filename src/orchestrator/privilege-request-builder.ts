import type { GlobalApprovalStore } from "../privilege/global-approval-store.js";
import type { SessionState } from "../types.js";
import type { WorkerToolPayload } from "../subagent/worker-tools.js";
import type { TaskCoordinator } from "./task-coordinator.js";
import { assertNever } from "../utils/assert-never.js";
import type { NativeToolPrivilegeRequest } from "./privilege-results.js";
import { isHttpTokenAutoApprovalAllowed } from "./task-grants.js";

export type PrivilegedNativeToolCall = Extract<WorkerToolPayload, {
  type:
    | "copy_into_share"
    | "copy_out_of_share"
    | "request_http_token"
    | "request_host_directory_access"
    | "create_skill"
    | "update_skill"
    | "delete_skill"
    | "create_job"
    | "update_job"
    | "delete_job"
    | "enable_job"
    | "disable_job"
    | "run_job_now";
}>;

export interface PrivilegeRequestBuilderContext {
  readonly taskCoordinator: TaskCoordinator;
  readonly globalApprovalStore: GlobalApprovalStore;
}

/**
 * Maps a privileged native worker tool call to the privilege request that must be
 * authorized before it can run. Pure aside from reading already-known approval state.
 */
export function buildNativeToolPrivilegeRequest(
  ctx: PrivilegeRequestBuilderContext,
  session: SessionState,
  taskId: string,
  call: PrivilegedNativeToolCall,
  requestId: string,
): NativeToolPrivilegeRequest {
  switch (call.type) {
    case "copy_into_share":
    case "copy_out_of_share":
      return {
        kind: "file_copy",
        requestId,
        payload: call,
      };
    case "request_http_token":
      return {
        kind: "http_token_use",
        requestId,
        tokenId: call.tokenId,
        host: call.host,
        reason: call.reason,
        confirmsAutoApprovalForTask: shouldConfirmHttpTokenAutoApprovalForTask(ctx, session, taskId, call.tokenId, call.host),
      };
    case "request_host_directory_access":
      return {
        kind: "host_directory_access",
        requestId,
        path: call.path,
        level: call.level,
      };
    case "create_skill":
      return {
        kind: "skill_mutation",
        requestId,
        operation: "create",
        skillId: call.skillId,
        name: call.name,
        description: call.description,
        body: call.body,
      };
    case "update_skill":
      return {
        kind: "skill_mutation",
        requestId,
        operation: "update",
        skillId: call.skillId,
        name: call.name,
        description: call.description,
        body: call.body,
      };
    case "delete_skill":
      return {
        kind: "skill_mutation",
        requestId,
        operation: "delete",
        skillId: call.skillId,
      };
    case "create_job":
      return {
        kind: "job_mutation",
        requestId,
        mutation: { operation: "create", jobId: call.definition.id, definition: call.definition },
      };
    case "update_job":
      return {
        kind: "job_mutation",
        requestId,
        mutation: { operation: "update", jobId: call.definition.id, definition: call.definition },
      };
    case "delete_job":
      return {
        kind: "job_mutation",
        requestId,
        mutation: { operation: "delete", jobId: call.jobId },
      };
    case "enable_job":
      return {
        kind: "job_mutation",
        requestId,
        mutation: { operation: "enable", jobId: call.jobId },
      };
    case "disable_job":
      return {
        kind: "job_mutation",
        requestId,
        mutation: { operation: "disable", jobId: call.jobId },
      };
    case "run_job_now":
      return {
        kind: "job_mutation",
        requestId,
        mutation: { operation: "run_now", jobId: call.jobId },
      };
    default:
      return assertNever(call);
  }
}

function shouldConfirmHttpTokenAutoApprovalForTask(
  ctx: PrivilegeRequestBuilderContext,
  session: SessionState,
  taskId: string,
  tokenId: string,
  host: string,
): boolean {
  const activeTask = ctx.taskCoordinator.findTask(session, taskId);
  return activeTask !== null
    && !isHttpTokenAutoApprovalAllowed(activeTask, tokenId)
    && ctx.globalApprovalStore.isHttpTokenAlwaysAllowed(tokenId, host);
}
