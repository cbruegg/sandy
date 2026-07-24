import { randomUUID } from "node:crypto";
import { messages } from "../messages-to-agent.js";
import type { ActiveTaskState, PrivilegeRequest, PrivilegeResolutionResult } from "../types.js";
import { approvedPrivilegeResult } from "./privilege-results.js";
import { grantHostDirectoryWithMessage } from "./privilege-resolvers.js";
import type { PrivilegeContext } from "./privilege-resolvers.js";
import {
  isHttpTokenAutoApprovalAllowed,
  isMcpAutoApprovalAllowed,
  isTaskHostDirectoryAccessAllowed,
} from "./task-grants.js";

/**
 * Outcome of checking an MCP request against existing grants: either it is already
 * resolved, or a privilege request must be enqueued (carrying whether a confirmed
 * approval should persist at task scope).
 */
export type McpAuthorizationDecision =
  | { kind: "resolved"; result: PrivilegeResolutionResult }
  | { kind: "needs_request"; confirmsAutoApprovalForTask: boolean };

export async function authorizeMcpImmediately(
  activeTask: ActiveTaskState,
  options: {
    serverId: string;
    isTaskGrantAllowed: (task: ActiveTaskState) => boolean;
    isPersistentAllowed: () => Promise<boolean>;
    sessionMessage: string;
    persistentMessage: string;
  },
): Promise<McpAuthorizationDecision> {
  if (options.isTaskGrantAllowed(activeTask)) {
    return { kind: "resolved", result: approvedPrivilegeResult(randomUUID(), options.sessionMessage, "worker_session") };
  }

  const hasConfiguredAutoApproval = await options.isPersistentAllowed();
  if (hasConfiguredAutoApproval && isMcpAutoApprovalAllowed(activeTask, options.serverId)) {
    return { kind: "resolved", result: approvedPrivilegeResult(randomUUID(), options.persistentMessage, "always") };
  }

  return { kind: "needs_request", confirmsAutoApprovalForTask: hasConfiguredAutoApproval };
}

/**
 * Returns an immediate resolution for an HTTP token request when existing task or
 * persistent grants already allow it.
 */
export function tryAuthorizeNativeHttpTokenUse(
  ctx: PrivilegeContext,
  activeTask: ActiveTaskState,
  request: Extract<PrivilegeRequest, { kind: "http_token_use" }>,
): PrivilegeResolutionResult | null {
  if (activeTask.approvedHttpTokenSessionGrants.some((entry) => entry.tokenId === request.tokenId && entry.host === request.host)) {
    return approvedPrivilegeResult(
      request.requestId,
      messages.httpTokenAllowedForWorkerSession(request.tokenId, request.host),
      "worker_session",
    );
  }

  if (
    isHttpTokenAutoApprovalAllowed(activeTask, request.tokenId)
    && ctx.globalApprovalStore.isHttpTokenAlwaysAllowed(request.tokenId, request.host)
  ) {
    return approvedPrivilegeResult(
      request.requestId,
      messages.httpTokenAllowedFromPersistentConfig(request.tokenId, request.host),
      "always",
    );
  }

  const onceGrant = activeTask.approvedHttpTokenOnceGrants.find(
    (entry) => entry.tokenId === request.tokenId && entry.host === request.host && !entry.consumed,
  );
  if (!onceGrant) {
    return null;
  }

  onceGrant.consumed = true;
  return approvedPrivilegeResult(request.requestId, messages.httpTokenAllowedOnce(request.tokenId, request.host), "once");
}

/**
 * Resolves a host directory access request against existing task or persistent grants.
 * Async because granting performs a hostfs mount; only invoked for host_directory_access.
 */
export async function tryAuthorizeHostDirectoryAccess(
  ctx: PrivilegeContext,
  activeTask: ActiveTaskState,
  request: Extract<PrivilegeRequest, { kind: "host_directory_access" }>,
): Promise<PrivilegeResolutionResult | null> {
  if (isTaskHostDirectoryAccessAllowed(activeTask, request.path, request.level)) {
    return await grantHostDirectoryWithMessage(
      ctx,
      activeTask,
      request,
      messages.hostDirectoryAccessAllowedForWorkerSession(request.path, request.level),
      "worker_session",
    );
  }

  if (ctx.globalApprovalStore.isHostDirectoryAlwaysAllowed(request.path, request.level)) {
    return await grantHostDirectoryWithMessage(
      ctx,
      activeTask,
      request,
      messages.hostDirectoryAccessAllowedFromPersistentConfig(request.path, request.level),
      "always",
    );
  }

  return null;
}
