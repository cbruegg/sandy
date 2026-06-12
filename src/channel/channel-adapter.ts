import type {
  ChannelFormatting,
  MessageAttachment,
  NormalizedChatEvent,
  PrivilegeRequest,
  SavedAttachment,
} from "../types.js";
import type { ChannelDestinationStore } from "./channel-destination-store.js";

export type MessageHandler = (event: NormalizedChatEvent) => Promise<void>;

export interface ChannelAdapter {
  readonly destinationStore: ChannelDestinationStore;
  getLastUserInteractionTimestamp(chatId: string): string | null;
  getFormatting(): ChannelFormatting;
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
  saveAttachments(chatId: string, attachments: MessageAttachment[], targetDirectory: string): Promise<SavedAttachment[]>;
  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendTaskUpdate(chatId: string, text: string): Promise<void>;
  sendReportableText(chatId: string, text: string): Promise<void>;
  sendPrivilegeRequest(chatId: string, request: PrivilegeRequest): Promise<void>;
  sendShareDeletionRequest(chatId: string, requestId: string, taskName: string, summary: string): Promise<void>;
}
