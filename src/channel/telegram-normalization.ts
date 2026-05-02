import type { Update } from "grammy/types";
import type {
  NormalizedChatEvent,
  UserTextEvent,
} from "../types.js";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import type { TranscriptionProvider } from "../transcription/transcription-provider.js";
import { normalizeTelegramUsername } from "./telegram-user.js";

type TelegramEventMetadata = {
  chatType: "private" | "group" | "supergroup" | "channel";
  senderUserId: string;
  senderUsername: string | null;
};

export type TelegramNormalizedChatEvent = NormalizedChatEvent & TelegramEventMetadata;
export type TelegramUpdateMetadata = TelegramEventMetadata & {
  chatId: string;
  messageId: string;
  kind: NormalizedChatEvent["kind"] | "unknown";
};

type VoiceNormalizationDeps = {
  transcriptionProvider: TranscriptionProvider | null;
  fileDownloader: (fileId: string) => Promise<ArrayBuffer>;
  sendText: (chatId: string, text: string) => Promise<void>;
};

export async function normalizeTelegramUpdate(
  update: Update,
  deps?: VoiceNormalizationDeps,
): Promise<TelegramNormalizedChatEvent | null> {
  const callbackEvent = normalizeCallbackQuery(update);
  if (callbackEvent) {
    return callbackEvent;
  }

  if (!update.message) {
    return null;
  }

  const base = {
    chatId: String(update.message.chat.id),
    chatType: update.message.chat.type,
    messageId: String(update.message.message_id),
    senderUserId: String(update.message.from?.id ?? ""),
    senderUsername: normalizeTelegramUsername(update.message.from?.username),
    timestamp: nowFromUnix(update.message.date),
  };

  if ("text" in update.message && typeof update.message.text === "string") {
    return normalizeTelegramTextInput(base, update.message.text);
  }

  if ("voice" in update.message && update.message.voice) {
    return normalizeVoiceMessage(base, update.message.voice, deps);
  }

  if ("photo" in update.message && update.message.photo) {
    const photo = update.message.photo;
    const fileId = photo[photo.length - 1]?.file_id ?? "";
    const fileName = `photo_${update.message.message_id}.jpg`;
    return {
      ...base,
      kind: "user_text",
      text: "",
      rawText: "",
      attachments: [{
        attachmentId: fileId,
        kind: "image",
        fileName,
        mimeType: "image/jpeg",
      }],
    };
  }

  if ("document" in update.message && update.message.document) {
    const fileName = sanitizeTelegramFileName(update.message.document.file_name);
    const caption = typeof update.message.caption === "string" ? update.message.caption : "";
    return {
      ...base,
      kind: "user_text",
      text: caption,
      rawText: caption,
      attachments: [{
        attachmentId: update.message.document.file_id,
        kind: "file",
        fileName,
        mimeType: update.message.document.mime_type,
      }],
    };
  }

  return null;
}

export function extractTelegramUpdateMetadata(update: Update): TelegramUpdateMetadata | null {
  const callbackMetadata = extractCallbackQueryMetadata(update);
  if (callbackMetadata) {
    return callbackMetadata;
  }

  if (!update.message) {
    return null;
  }

  const base = {
    chatId: String(update.message.chat.id),
    chatType: update.message.chat.type,
    messageId: String(update.message.message_id),
    senderUserId: String(update.message.from?.id ?? ""),
    senderUsername: normalizeTelegramUsername(update.message.from?.username),
  };

  if ("text" in update.message && typeof update.message.text === "string") {
    return { ...base, kind: "user_text" };
  }

  if ("voice" in update.message && update.message.voice) {
    return { ...base, kind: "unsupported_input" };
  }

  if ("photo" in update.message && update.message.photo) {
    return { ...base, kind: "user_text" };
  }

  if ("document" in update.message && update.message.document) {
    return { ...base, kind: "user_text" };
  }

  return { ...base, kind: "unknown" };
}

function normalizeTelegramTextInput(
  base: Pick<UserTextEvent, "chatId" | "messageId" | "timestamp"> & TelegramEventMetadata,
  rawText: string,
): TelegramNormalizedChatEvent {
  return {
    ...base,
    kind: "user_text",
    text: rawText,
    rawText,
    attachments: [],
  };
}

function nowFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function extractCallbackQueryMetadata(update: Update): TelegramUpdateMetadata | null {
  if (!update.callback_query?.data || !update.callback_query.message || !("date" in update.callback_query.message)) {
    return null;
  }

  const { data, message } = update.callback_query;
  const base = {
    chatId: String(message.chat.id),
    chatType: message.chat.type,
    messageId: `callback:${update.callback_query.id}`,
    senderUserId: String(update.callback_query.from.id),
    senderUsername: normalizeTelegramUsername(update.callback_query.from.username),
  };

  if (data.startsWith("approve:") || data.startsWith("approve_session:") || data.startsWith("approve_always:") || data.startsWith("deny:")) {
    return { ...base, kind: "approval_response" };
  }

  if (data === "report") {
    return { ...base, kind: "danger_report" };
  }

  if (data === "cancel") {
    return { ...base, kind: "cancel_request" };
  }

  if (data === "mark_finished") {
    return { ...base, kind: "mark_finished_request" };
  }

  return { ...base, kind: "unknown" };
}

function normalizeCallbackQuery(update: Update): TelegramNormalizedChatEvent | null {
  if (!update.callback_query?.data || !update.callback_query.message || !("date" in update.callback_query.message)) {
    return null;
  }

  const { data, message } = update.callback_query;
  const base = {
    chatId: String(message.chat.id),
    chatType: message.chat.type,
    messageId: `callback:${update.callback_query.id}`,
    senderUserId: String(update.callback_query.from.id),
    senderUsername: normalizeTelegramUsername(update.callback_query.from.username),
    timestamp: nowFromUnix(message.date),
  };

  if (data.startsWith("approve:")) {
    const event: TelegramNormalizedChatEvent = {
      ...base,
      kind: "approval_response",
      decision: "approve_once",
      requestId: data.slice("approve:".length) || undefined,
    };
    return event;
  }

  if (data.startsWith("approve_session:")) {
    const event: TelegramNormalizedChatEvent = {
      ...base,
      kind: "approval_response",
      decision: "approve_worker_session",
      requestId: data.slice("approve_session:".length) || undefined,
    };
    return event;
  }

  if (data.startsWith("approve_always:")) {
    const event: TelegramNormalizedChatEvent = {
      ...base,
      kind: "approval_response",
      decision: "approve_always",
      requestId: data.slice("approve_always:".length) || undefined,
    };
    return event;
  }

  if (data.startsWith("deny:")) {
    const event: TelegramNormalizedChatEvent = {
      ...base,
      kind: "approval_response",
      decision: "deny",
      requestId: data.slice("deny:".length) || undefined,
    };
    return event;
  }

  if (data === "report") {
    const event: TelegramNormalizedChatEvent = {
      ...base,
      kind: "danger_report",
    };
    return event;
  }

  if (data === "cancel") {
    return {
      ...base,
      kind: "cancel_request",
    };
  }

  if (data === "mark_finished") {
    const event: TelegramNormalizedChatEvent = {
      ...base,
      kind: "mark_finished_request",
    };
    return event;
  }

  return null;
}

async function normalizeVoiceMessage(
  base: Pick<UserTextEvent, "chatId" | "messageId" | "timestamp"> & TelegramEventMetadata,
  voice: { file_id: string; mime_type?: string },
  deps?: VoiceNormalizationDeps,
): Promise<TelegramNormalizedChatEvent | null> {
  if (!deps) {
    return { ...base, kind: "unsupported_input", inputType: "voice" };
  }

  if (!deps.transcriptionProvider) {
    await deps.sendText(base.chatId, messages.voiceMessagesNotEnabled());
    return null;
  }

  try {
    const fileName = buildVoiceFileName(voice.mime_type);
    const audio = new Uint8Array(await deps.fileDownloader(voice.file_id));
    const transcript = await deps.transcriptionProvider.transcribe({
      audio,
      fileName,
      mimeType: voice.mime_type,
    });
    return normalizeTelegramTextInput(base, transcript);
  } catch (error) {
    logger.warn("telegram.voice_transcription_failed", {
      chatId: base.chatId,
      messageId: base.messageId,
      message: error instanceof Error ? error.message : "Unknown transcription failure.",
    });
    await deps.sendText(base.chatId, messages.voiceTranscriptionFailed());
    return null;
  }
}

function sanitizeTelegramFileName(fileName: string | undefined): string {
  const fallback = "attachment";
  const trimmed = (fileName ?? fallback).trim();
  const normalized = trimmed.replaceAll(/[^A-Za-z0-9._-]+/g, "_").replaceAll(/^_+|_+$/g, "");
  return normalized || fallback;
}

function buildVoiceFileName(mimeType: string | undefined): string {
  switch (mimeType) {
    case "audio/mpeg":
      return "voice.mp3";
    case "audio/mp4":
      return "voice.m4a";
    case "audio/wav":
    case "audio/x-wav":
      return "voice.wav";
    default:
      return "voice.ogg";
  }
}
