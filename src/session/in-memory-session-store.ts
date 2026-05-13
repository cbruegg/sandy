import type { SessionState } from "../types.js";

export interface SessionStore {
  getOrCreate(chatId: string): SessionState;
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
      pendingTaskSummary: null,
      pendingShareDeletion: null,
    };
    this.sessions.set(chatId, session);
    return session;
  }

  listSessions(): SessionState[] {
    return Array.from(this.sessions.values());
  }
}
