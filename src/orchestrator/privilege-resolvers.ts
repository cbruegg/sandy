import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import type { JobApprovalStoreApi } from "../jobs/job-approval-store.js";
import type { JobStore } from "../jobs/job-store.js";
import { messages } from "../messages.js";
import type {
  ActiveTaskState,
  NormalizedChatEvent,
  PrivilegeRequest,
  PrivilegeResolutionResult,
  SessionState,
} from "../types.js";
import type { WorkerToolsHandler } from "../subagent/worker-tools-handler.js";
import {
  approvedPrivilegeResult,
  assertNever,
  deniedPrivilegeResult,
  failedPrivilegeResult,
  withHostDirectoryGrantMessage,
} from "./privilege-results.js";
import {
  grantHttpTokenOnce,
  grantHttpTokenSessionAccess,
  grantHttpTokenAutoApprovalForTask,
  grantMcpAutoApprovalForTask,
  grantTaskHostDirectoryAccess,
  grantTaskResourceReadAccess,
  grantTaskToolAccess,
} from "./task-grants.js";
import type { SkillArchiveCoordinator } from "./skill-archive-coordinator.js";

type ApprovalDecision = Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"];

/**
 * Collaborators the privilege resolvers and authorizers need to apply a decision.
 * A superset that both modules share so the orchestrator builds it once.
 */
export interface PrivilegeContext {
  readonly persistentApprovalStore: PersistentApprovalStore;
  readonly jobApprovalStore: JobApprovalStoreApi;
  readonly jobStore: JobStore;
  readonly workerToolsHandler: WorkerToolsHandler;
  readonly skillArchiveCoordinator: SkillArchiveCoordinator;
}

export async function resolveMcpToolCallRequest(
  ctx: PrivilegeContext,
  session: SessionState,
  request: Extract<PrivilegeRequest, { kind: "mcp_tool_call" }>,
  decision: ApprovalDecision,
): Promise<PrivilegeResolutionResult> {
  return resolveScopedApprovalRequest(session, request, decision, {
    deniedMessage: messages.userDeniedMcpToolCall(request.serverId, request.toolName),
    onceMessage: messages.mcpToolAllowedOnce(request.serverId, request.toolName),
    sessionMessage: messages.mcpToolAllowedForWorkerSession(request.serverId, request.toolName),
    alwaysMessage: messages.mcpToolAllowedAndPersisted(request.serverId, request.toolName),
    persistentMessage: messages.mcpToolAllowedFromPersistentConfig(request.serverId, request.toolName),
    grantAutoApprovalForTask: (task) => grantMcpAutoApprovalForTask(ctx.jobApprovalStore, task, request.serverId),
    grantAccess: (task) => grantTaskToolAccess(task, request.serverId, request.toolName),
    persist: () => ctx.persistentApprovalStore.allowTool(request.serverId, request.toolName),
  });
}

export async function resolveMcpResourceReadRequest(
  ctx: PrivilegeContext,
  session: SessionState,
  request: Extract<PrivilegeRequest, { kind: "mcp_resource_read" }>,
  decision: ApprovalDecision,
): Promise<PrivilegeResolutionResult> {
  return resolveScopedApprovalRequest(session, request, decision, {
    deniedMessage: messages.userDeniedMcpResourceRead(request.serverId, request.uri),
    onceMessage: messages.mcpResourceReadAllowedOnce(request.serverId, request.uri),
    sessionMessage: messages.mcpResourceReadAllowedForWorkerSession(request.serverId, request.uri),
    alwaysMessage: messages.mcpResourceReadAllowedAndPersisted(request.serverId, request.uri),
    persistentMessage: messages.mcpResourceReadAllowedFromPersistentConfig(request.serverId, request.uri),
    grantAutoApprovalForTask: (task) => grantMcpAutoApprovalForTask(ctx.jobApprovalStore, task, request.serverId),
    grantAccess: (task) => grantTaskResourceReadAccess(task, request.serverId, request.uri),
    persist: () => ctx.persistentApprovalStore.allowResourceRead(request.serverId, request.uri),
  });
}

export async function resolveHttpTokenRequest(
  ctx: PrivilegeContext,
  session: SessionState,
  request: Extract<PrivilegeRequest, { kind: "http_token_use" }>,
  decision: ApprovalDecision,
): Promise<PrivilegeResolutionResult> {
  return resolveScopedApprovalRequest(session, request, decision, {
    deniedMessage: messages.httpTokenDenied(request.tokenId, request.host),
    onceMessage: messages.httpTokenAllowedOnce(request.tokenId, request.host),
    sessionMessage: messages.httpTokenAllowedForWorkerSession(request.tokenId, request.host),
    alwaysMessage: messages.httpTokenAllowedAndPersisted(request.tokenId, request.host),
    persistentMessage: messages.httpTokenAllowedFromPersistentConfig(request.tokenId, request.host),
    grantAutoApprovalForTask: (task) => grantHttpTokenAutoApprovalForTask(ctx.jobApprovalStore, task, request.tokenId),
    grantOnce: (task) => grantHttpTokenOnce(task, request.tokenId, request.host),
    grantAccess: (task) => grantHttpTokenSessionAccess(task, request.tokenId, request.host),
    persist: () => ctx.persistentApprovalStore.allowHttpToken(request.tokenId, request.host),
  });
}

/**
 * Shared resolution for "scoped" approvals (MCP tool, MCP resource read, HTTP token).
 * Each request can be approved once, for the worker session, or persisted ("always");
 * a request that confirms task auto-approval persists at task scope on any approval.
 */
async function resolveScopedApprovalRequest(
  session: SessionState,
  request: { requestId: string; confirmsAutoApprovalForTask?: boolean },
  decision: ApprovalDecision,
  options: {
    deniedMessage: string;
    onceMessage: string;
    sessionMessage: string;
    alwaysMessage: string;
    persistentMessage: string;
    grantAutoApprovalForTask: (task: ActiveTaskState) => Promise<void>;
    grantAccess: (task: ActiveTaskState) => void;
    grantOnce?: (task: ActiveTaskState) => void;
    persist: () => Promise<void>;
  },
): Promise<PrivilegeResolutionResult> {
  const activeTask = requireSessionActiveTask(session, request.requestId);
  if ("result" in activeTask) {
    return activeTask.result;
  }

  switch (decision) {
    case "deny":
      return deniedPrivilegeResult(request.requestId, options.deniedMessage);
    case "approve":
    case "approve_once":
      if (request.confirmsAutoApprovalForTask) {
        await options.grantAutoApprovalForTask(activeTask.activeTask);
        return approvedPrivilegeResult(request.requestId, options.persistentMessage, "always");
      }
      options.grantOnce?.(activeTask.activeTask);
      return approvedPrivilegeResult(request.requestId, options.onceMessage, "once");
    case "approve_worker_session":
      if (request.confirmsAutoApprovalForTask) {
        await options.grantAutoApprovalForTask(activeTask.activeTask);
        return approvedPrivilegeResult(request.requestId, options.persistentMessage, "always");
      }
      options.grantAccess(activeTask.activeTask);
      return approvedPrivilegeResult(request.requestId, options.sessionMessage, "worker_session");
    case "approve_always":
      await options.persist();
      await options.grantAutoApprovalForTask(activeTask.activeTask);
      return approvedPrivilegeResult(request.requestId, options.alwaysMessage, "always");
    default:
      return assertNever(decision);
  }
}

export async function resolveHostDirectoryRequest(
  ctx: PrivilegeContext,
  session: SessionState,
  request: Extract<PrivilegeRequest, { kind: "host_directory_access" }>,
  decision: ApprovalDecision,
): Promise<PrivilegeResolutionResult> {
  const activeTask = requireSessionActiveTask(session, request.requestId);
  if ("result" in activeTask) {
    return activeTask.result;
  }

  switch (decision) {
    case "deny":
      return deniedPrivilegeResult(request.requestId, messages.hostDirectoryAccessDenied(request.path, request.level));
    case "approve":
    case "approve_once":
    case "approve_worker_session":
      grantTaskHostDirectoryAccess(activeTask.activeTask, request.path, request.level);
      return grantHostDirectoryWithMessage(
        ctx,
        activeTask.activeTask,
        request,
        messages.hostDirectoryAccessAllowedForWorkerSession(request.path, request.level),
        "worker_session",
      );
    case "approve_always":
      await ctx.persistentApprovalStore.allowHostDirectory(request.path, request.level);
      grantTaskHostDirectoryAccess(activeTask.activeTask, request.path, request.level);
      return grantHostDirectoryWithMessage(
        ctx,
        activeTask.activeTask,
        request,
        messages.hostDirectoryAccessAllowedAndPersisted(request.path, request.level),
        "always",
      );
    default:
      return assertNever(decision);
  }
}

/**
 * Performs the actual host directory mount grant via the worker tools handler,
 * prefixing the caller-provided scope message onto the returned grant path.
 */
export async function grantHostDirectoryWithMessage(
  ctx: PrivilegeContext,
  activeTask: ActiveTaskState,
  request: Extract<PrivilegeRequest, { kind: "host_directory_access" }>,
  message: string,
  scope: "worker_session" | "always",
): Promise<PrivilegeResolutionResult> {
  return withHostDirectoryGrantMessage(await grantHostDirectoryAccess(ctx, activeTask, request), message, scope);
}

async function grantHostDirectoryAccess(
  ctx: PrivilegeContext,
  activeTask: ActiveTaskState,
  request: Extract<PrivilegeRequest, { kind: "host_directory_access" }>,
): Promise<PrivilegeResolutionResult> {
  const result = await ctx.workerToolsHandler.mountHostDirectory({
    taskId: activeTask.taskId,
    path: request.path,
    level: request.level,
  });

  if (!result.ok) {
    return failedPrivilegeResult(
      request.requestId,
      messages.hostDirectoryAccessFailed(request.path, result.error),
    );
  }

  return approvedPrivilegeResult(request.requestId, `Use the path: ${result.grantPath}`);
}

export async function resolveSkillMutationRequest(
  ctx: PrivilegeContext,
  session: SessionState,
  request: Extract<PrivilegeRequest, { kind: "skill_mutation" }>,
  decision: ApprovalDecision,
): Promise<PrivilegeResolutionResult> {
  return resolveApproveOnlyMutation(session, request.requestId, decision, {
    deniedMessage: messages.skillMutationDenied(request.operation, request.skillId),
    apply: async () => {
      await ctx.workerToolsHandler.applySkillMutation({
        operation: request.operation,
        skillId: request.skillId,
        name: request.name,
        description: request.description,
        body: request.body,
      });
      return "";
    },
    approvedMessage: () => messages.skillMutationApproved(request.operation, request.skillId),
    failedMessage: (detail) => messages.skillMutationFailed(request.operation, request.skillId, detail),
    unknownFailureDetail: "Unknown skill mutation failure.",
  });
}

export async function resolveJobMutationRequest(
  ctx: PrivilegeContext,
  session: SessionState,
  request: Extract<PrivilegeRequest, { kind: "job_mutation" }>,
  decision: ApprovalDecision,
): Promise<PrivilegeResolutionResult> {
  const { operation, jobId } = request.mutation;

  if (decision !== "approve") {
    if (!session.visibleTask) {
      return failedPrivilegeResult(request.requestId, messages.taskNoLongerActive(session.chatId));
    }
    return deniedPrivilegeResult(request.requestId, messages.jobMutationDenied(operation, jobId));
  }

  // Snapshot the job before deletion so we can check whether to offer
  // archiving the associated skill afterwards.
  let jobBeforeDelete = null;
  if (operation === "delete") {
    jobBeforeDelete = await ctx.jobStore.getDefinition(jobId);
  }

  try {
    const detail = await ctx.workerToolsHandler.applyJobMutation(request.mutation);

    if (operation === "delete" && jobBeforeDelete && jobBeforeDelete.schedule.kind === "cron") {
      // The job has already been deleted by applyMutation, so we can
      // pass jobId as excluded (though it's already gone from the store).
      await ctx.skillArchiveCoordinator.offerArchiveForJobSkill(session.chatId, jobBeforeDelete.skillId, jobBeforeDelete.id);
    }

    return approvedPrivilegeResult(request.requestId, `${messages.jobMutationApproved(operation, jobId)} ${detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown job mutation failure.";
    return failedPrivilegeResult(request.requestId, messages.jobMutationFailed(operation, jobId, detail));
  }
}

/**
 * Shared resolution for mutations that only support a binary approve/deny decision and
 * apply through the worker tools handler.
 */
async function resolveApproveOnlyMutation(
  session: SessionState,
  requestId: string,
  decision: ApprovalDecision,
  options: {
    deniedMessage: string;
    apply: () => Promise<string>;
    approvedMessage: (detail: string) => string;
    failedMessage: (detail: string) => string;
    unknownFailureDetail: string;
  },
): Promise<PrivilegeResolutionResult> {
  if (!session.visibleTask) {
    return failedPrivilegeResult(requestId, messages.taskNoLongerActive(session.chatId));
  }

  if (decision !== "approve") {
    return deniedPrivilegeResult(requestId, options.deniedMessage);
  }

  try {
    const detail = await options.apply();
    return approvedPrivilegeResult(requestId, options.approvedMessage(detail));
  } catch (error) {
    const detail = error instanceof Error ? error.message : options.unknownFailureDetail;
    return failedPrivilegeResult(requestId, options.failedMessage(detail));
  }
}

export async function resolveFileCopyRequest(
  ctx: PrivilegeContext,
  request: Extract<PrivilegeRequest, { kind: "file_copy" }>,
  decision: ApprovalDecision,
  taskId: string,
): Promise<PrivilegeResolutionResult> {
  if (decision === "deny") {
    return deniedPrivilegeResult(request.requestId, messages.userDeniedPrivilegeRequest(request.requestId));
  }

  const operation = await ctx.workerToolsHandler.applyFileCopy(request.payload, { taskId });
  return {
    requestId: request.requestId,
    ...operation,
  };
}

function requireSessionActiveTask(
  session: SessionState,
  requestId: string,
): { activeTask: ActiveTaskState } | { result: PrivilegeResolutionResult } {
  if (!session.visibleTask) {
    return {
      result: failedPrivilegeResult(requestId, messages.taskNoLongerActive(session.chatId)),
    };
  }

  return {
    activeTask: session.visibleTask,
  };
}
