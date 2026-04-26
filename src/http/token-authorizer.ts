import { randomUUID } from "node:crypto";
import type { SessionStore } from "../session/in-memory-session-store.js";
import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import type { PrivilegeResolutionResult } from "../types.js";
import { messages } from "../messages.js";
import type { TaskRegistry } from "../task-registry.js";
import type { SessionState } from "../types/task-state.js";

type AuthorizeHttpTokenUseInput = {
  taskId: string;
  tokenId: string;
  host: string;
};

export class HttpTokenAuthorizer {
  constructor(
    private readonly taskRegistry: TaskRegistry,
    private readonly sessionStore: SessionStore,
    private readonly persistentApprovalStore: PersistentApprovalStore,
  ) {}

  authorizeHttpTokenUse(input: AuthorizeHttpTokenUseInput): Promise<PrivilegeResolutionResult> {
    const chatId = this.taskRegistry.getChatId(input.taskId);
    if (!chatId) {
      return Promise.resolve({
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.taskNotActive(input.taskId),
      });
    }

    const session = this.sessionStore.getOrCreate(chatId);
    const activeTask = session.activeTask;
    if (!activeTask || activeTask.taskId !== input.taskId) {
      return Promise.resolve({
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.taskNotActive(input.taskId),
      });
    }

    if (isHttpTokenSessionGrantAllowed(activeTask, input.tokenId, input.host)) {
      return Promise.resolve({
        requestId: randomUUID(),
        outcome: "approved",
        message: messages.httpTokenAllowedForWorkerSession(input.tokenId, input.host),
        scope: "worker_session",
      });
    }

    if (this.persistentApprovalStore.isHttpTokenAlwaysAllowed(input.tokenId, input.host)) {
      return Promise.resolve({
        requestId: randomUUID(),
        outcome: "approved",
        message: messages.httpTokenAllowedFromPersistentConfig(input.tokenId, input.host),
        scope: "always",
      });
    }

    const onceGrant = activeTask.approvedHttpTokenOnceGrants.find(
      (entry) => entry.tokenId === input.tokenId && entry.host === input.host && !entry.consumed,
    );
    if (onceGrant) {
      onceGrant.consumed = true;
      this.sessionStore.save(session);
      return Promise.resolve({
        requestId: randomUUID(),
        outcome: "approved",
        message: messages.httpTokenAllowedOnce(input.tokenId, input.host),
        scope: "once",
      });
    }

    return Promise.resolve({
      requestId: randomUUID(),
      outcome: "denied",
      message: messages.httpTokenProxyRejected(input.tokenId),
    });
  }
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
