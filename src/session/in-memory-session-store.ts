import type { SessionState } from "../types.js";

export interface SessionStore {
  getOrCreate(chatId: string): SessionState;
  getByTaskId(taskId: string): SessionState | undefined;
  listSessions(): SessionState[];
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionState>();

  getOrCreate(chatId: string): SessionState {
    const existing = this.sessions.get(chatId);
    if (existing) {
      return existing;
    }
    const session: SessionState = {
      chatId,
      activeTask: null,
      backgroundJobTasks: [],
      pendingTaskSummary: null,
      pendingShareDeletion: null,
    };
    this.sessions.set(chatId, session);
    return session;
  }

  getByTaskId(taskId: string): SessionState | undefined {
    for (const session of this.sessions.values()) {
      if (session.activeTask?.taskId === taskId || session.backgroundJobTasks.some((task) => task.taskId === taskId)) {
        return session;
      }
    }
    return undefined;
  }

  listSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }
}
