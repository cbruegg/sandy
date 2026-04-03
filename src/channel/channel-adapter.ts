import type {
  ChannelFormatting,
  MessageAttachment,
  NormalizedChatEvent,
  PrivilegeRequest,
  SavedAttachment,
} from "../types.js";

export type MessageHandler = (event: NormalizedChatEvent) => Promise<void>;

export interface ChannelAdapter {
  getFormatting(): ChannelFormatting;
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
  saveAttachments(chatId: string, attachments: MessageAttachment[], targetDirectory: string): Promise<SavedAttachment[]>;
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendTaskUpdate(chatId: string, text: string): Promise<void>;
  sendPrivilegeRequest(chatId: string, request: PrivilegeRequest): Promise<void>;
  sendShareDeletionRequest(chatId: string, requestId: string, taskName: string, summary: string): Promise<void>;
}
