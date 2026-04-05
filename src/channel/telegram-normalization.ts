import type { Update } from "grammy/types";
import type {
  ApprovalResponseEvent,
  DangerReportEvent,
  NormalizedChatEvent,
  UserTextEvent,
} from "../types.js";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import type { TranscriptionProvider } from "../transcription/transcription-provider.js";

type VoiceNormalizationDeps = {
  transcriptionProvider: TranscriptionProvider | null;
  fileDownloader: (fileId: string) => Promise<ArrayBuffer>;
  sendText: (chatId: string, text: string) => Promise<void>;
};

export async function normalizeTelegramUpdate(
  update: Update,
  deps?: VoiceNormalizationDeps,
): Promise<NormalizedChatEvent | null> {
  const callbackEvent = normalizeCallbackQuery(update);
  if (callbackEvent) {
    return callbackEvent;
  }

  if (!update.message) {
    return null;
  }

  const base = {
    chatId: String(update.message.chat.id),
    messageId: String(update.message.message_id),
    timestamp: nowFromUnix(update.message.date),
  };

  if ("text" in update.message && typeof update.message.text === "string") {
    return normalizeTelegramTextInput(base, update.message.text);
  }

  if ("voice" in update.message && update.message.voice) {
    return normalizeVoiceMessage(base, update.message.voice, deps);
  }

  if ("photo" in update.message && update.message.photo) {
    return { ...base, kind: "unsupported_input", inputType: "image" };
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

function normalizeTelegramTextInput(
  base: Pick<UserTextEvent, "chatId" | "messageId" | "timestamp">,
  rawText: string,
): NormalizedChatEvent {
  const normalized = rawText.trim().toLowerCase();

  if (normalized === "/cancel" || normalized === "cancel") {
    return { ...base, kind: "cancel_request" };
  }
  if (normalized === "/report" || normalized === "report") {
    return { ...base, kind: "danger_report" };
  }
  if (normalized === "/approve" || normalized === "approve") {
    return { ...base, kind: "approval_response", decision: "approve" };
  }
  if (normalized === "/deny" || normalized === "deny") {
    return { ...base, kind: "approval_response", decision: "deny" };
  }

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

function normalizeCallbackQuery(update: Update): NormalizedChatEvent | null {
  if (!update.callback_query?.data || !update.callback_query.message || !("date" in update.callback_query.message)) {
    return null;
  }

  const { data, message } = update.callback_query;
  const base = {
    chatId: String(message.chat.id),
    messageId: `callback:${update.callback_query.id}`,
    timestamp: nowFromUnix(message.date),
  };

  if (data.startsWith("approve:")) {
    const event: ApprovalResponseEvent = {
      ...base,
      kind: "approval_response",
      decision: "approve",
      requestId: data.slice("approve:".length) || undefined,
    };
    return event;
  }

  if (data.startsWith("deny:")) {
    const event: ApprovalResponseEvent = {
      ...base,
      kind: "approval_response",
      decision: "deny",
      requestId: data.slice("deny:".length) || undefined,
    };
    return event;
  }

  if (data === "report") {
    const event: DangerReportEvent = {
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

  return null;
}

async function normalizeVoiceMessage(
  base: Pick<UserTextEvent, "chatId" | "messageId" | "timestamp">,
  voice: { file_id: string; mime_type?: string },
  deps?: VoiceNormalizationDeps,
): Promise<NormalizedChatEvent | null> {
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
