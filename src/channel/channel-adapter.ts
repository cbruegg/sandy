import type {
  ChannelFormatting,
  MessageAttachment,
  NormalizedChatEvent,
  PrivilegeRequest,
  SavedAttachment,
} from "../types.js";
import type { ChatId } from "../types.js";

export type MessageHandler = (event: NormalizedChatEvent) => Promise<void>;

export interface ChannelAdapter {
  getLastUserInteractionTimestamp(chatId: ChatId): string | null;
  getFormatting(): ChannelFormatting;
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
  saveAttachments(chatId: ChatId, attachments: MessageAttachment[], targetDirectory: string): Promise<SavedAttachment[]>;
  sendFile(chatId: ChatId, filePath: string, caption?: string): Promise<void>;
  sendText(chatId: ChatId, text: string): Promise<void>;
  sendTaskUpdate(chatId: ChatId, text: string): Promise<void>;
  sendReportableText(chatId: ChatId, text: string): Promise<void>;
  sendPrivilegeRequest(chatId: ChatId, request: PrivilegeRequest): Promise<void>;
  askForDenialReason(chatId: ChatId, request: PrivilegeRequest): Promise<void>;
  sendShareDeletionRequest(chatId: ChatId, requestId: string, taskName: string, summary: string): Promise<void>;
}
