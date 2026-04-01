import type { NormalizedChatEvent, PrivilegeRequest } from "../types.js";

export type MessageHandler = (event: NormalizedChatEvent) => Promise<void>;

export interface ChannelAdapter {
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendTaskUpdate(chatId: string, text: string): Promise<void>;
  sendPrivilegeRequest(chatId: string, request: PrivilegeRequest): Promise<void>;
}
