import type { SessionState } from "../types.js";

export interface SessionStore {
  getOrCreate(chatId: string): SessionState;
  save(session: SessionState): void;
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
      transcript: [],
      mainThreadId: null,
      activeTask: null,
      pendingQuarantinedOutputs: [],
    };
    this.sessions.set(chatId, session);
    return session;
  }

  save(session: SessionState): void {
    this.sessions.set(session.chatId, session);
  }
}
