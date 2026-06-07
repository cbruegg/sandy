import { randomUUID } from "node:crypto";
import type { SessionStore } from "../session/in-memory-session-store.js";
import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import type { JobApprovalStore } from "../jobs/job-approval-store.js";
import type { PrivilegeResolutionResult } from "../types.js";
import { messages } from "../messages.js";
import type { SessionState } from "../types/task-state.js";
import { findSessionTask } from "../orchestrator/session-task-state.js";

type AuthorizeHttpTokenUseInput = {
  taskId: string;
  tokenId: string;
  host: string;
};

export class HttpTokenAuthorizer {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly persistentApprovalStore: PersistentApprovalStore,
    private readonly jobApprovalStore: JobApprovalStore,
  ) {}

  async authorizeHttpTokenUse(input: AuthorizeHttpTokenUseInput): Promise<PrivilegeResolutionResult> {
    const session = this.sessionStore.getByTaskId(input.taskId);
    if (!session) {
      return Promise.resolve({
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.taskNotActive(input.taskId),
      });
    }

    const activeTask = findSessionTask(session, input.taskId)?.task;
    if (!activeTask) {
      return Promise.resolve({
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.taskNotActive(input.taskId),
      });
    }

    if (isHttpTokenSessionGrantAllowed(activeTask, input.tokenId, input.host)) {
      return {
        requestId: randomUUID(),
        outcome: "approved",
        message: messages.httpTokenAllowedForWorkerSession(input.tokenId, input.host),
        scope: "worker_session",
      };
    }

    if ((activeTask.origin?.kind === "launchedByJob" || isHttpTokenAutoApprovalAllowed(activeTask, input.tokenId))
      && await this.isHttpTokenAlwaysAllowed(activeTask, input.tokenId, input.host)) {
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

  private async isHttpTokenAlwaysAllowed(
    task: NonNullable<SessionState["activeTask"]>,
    tokenId: string,
    host: string,
  ): Promise<boolean> {
    if (task.origin?.kind === "launchedByJob") {
      return await this.jobApprovalStore.isHttpTokenAlwaysAllowed(task.origin.jobId, tokenId, host);
    }
    return this.persistentApprovalStore.isHttpTokenAlwaysAllowed(tokenId, host);
  }
}

function isHttpTokenAutoApprovalAllowed(
  task: NonNullable<SessionState["activeTask"]>,
  tokenId: string,
): boolean {
  return task.taskPolicy.autoApproveHttpTokens.includes(tokenId);
}

function isHttpTokenSessionGrantAllowed(
  task: NonNullable<SessionState["activeTask"]>,
  tokenId: string,
  host: string,
): boolean {
  return task.approvedHttpTokenSessionGrants.some(
    (entry) => entry.tokenId === tokenId && entry.host === host,
  );
}
