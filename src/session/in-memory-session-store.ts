import { SessionState } from "../types.js";
import type { ChatId } from "../types.js";

export interface SessionStore {
  getOrCreate(chatId: ChatId): SessionState;
  getByTaskId(taskId: string): SessionState | undefined;
  listSessions(): SessionState[];
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<ChatId, SessionState>();

  getOrCreate(chatId: ChatId): SessionState {
    const existing = this.sessions.get(chatId);
    if (existing) {
      return existing;
    }
    const session = new SessionState(chatId);
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
