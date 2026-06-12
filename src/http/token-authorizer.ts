import { randomUUID } from "node:crypto";
import type { SessionStore } from "../session/in-memory-session-store.js";
import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import type { PrivilegeResolutionResult } from "../types.js";
import { messages } from "../messages.js";
import type { ActiveTaskState } from "../types/task-state.js";


type AuthorizeHttpTokenUseInput = {
  taskId: string;
  tokenId: string;
  host: string;
};

export class HttpTokenAuthorizer {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly persistentApprovalStore: PersistentApprovalStore,
  ) {}

  authorizeHttpTokenUse(input: AuthorizeHttpTokenUseInput): PrivilegeResolutionResult {
    const session = this.sessionStore.getByTaskId(input.taskId);
    if (!session) {
      return {
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.taskNotActive(input.taskId),
      };
    }

    const activeTask = session.findTask(input.taskId)?.task;
    if (!activeTask) {
      return {
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.taskNotActive(input.taskId),
      };
    }

    if (isHttpTokenSessionGrantAllowed(activeTask, input.tokenId, input.host)) {
      return {
        requestId: randomUUID(),
        outcome: "approved",
        message: messages.httpTokenAllowedForWorkerSession(input.tokenId, input.host),
        scope: "worker_session",
      };
    }

    if (isHttpTokenAutoApprovalAllowed(activeTask, input.tokenId)
      && this.isHttpTokenAlwaysAllowed(input.tokenId, input.host)) {
      return {
        requestId: randomUUID(),
        outcome: "approved",
        message: messages.httpTokenAllowedFromPersistentConfig(input.tokenId, input.host),
        scope: "always",
      };
    }

    const onceGrant = activeTask.approvedHttpTokenOnceGrants.find(
      (entry) => entry.tokenId === input.tokenId && entry.host === input.host && !entry.consumed,
    );
    if (onceGrant) {
      onceGrant.consumed = true;
      return {
        requestId: randomUUID(),
        outcome: "approved",
        message: messages.httpTokenAllowedOnce(input.tokenId, input.host),
        scope: "once",
      };
    }

    return {
      requestId: randomUUID(),
      outcome: "denied",
      message: messages.httpTokenProxyRejected(input.tokenId),
    };
  }

  private isHttpTokenAlwaysAllowed(tokenId: string, host: string): boolean {
    return this.persistentApprovalStore.isHttpTokenAlwaysAllowed(tokenId, host);
  }
}

function isHttpTokenAutoApprovalAllowed(
  task: ActiveTaskState,
  tokenId: string,
): boolean {
  return task.taskPolicy.autoApproveHttpTokens.includes(tokenId);
}

function isHttpTokenSessionGrantAllowed(
  task: ActiveTaskState,
  tokenId: string,
  host: string,
): boolean {
  return task.approvedHttpTokenSessionGrants.some(
    (entry) => entry.tokenId === tokenId && entry.host === host,
  );
}
