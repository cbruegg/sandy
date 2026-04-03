import type { Update } from "grammy/types";
import type {
  ApprovalResponseEvent,
  DangerReportEvent,
  NormalizedChatEvent,
} from "../types.js";

export function normalizeTelegramUpdate(update: Update): NormalizedChatEvent | null {
  if (update.callback_query?.data && update.callback_query.message && "date" in update.callback_query.message) {
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
    const rawText = update.message.text;
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

  if ("voice" in update.message && update.message.voice) {
    return { ...base, kind: "unsupported_input", inputType: "voice" };
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

function nowFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function sanitizeTelegramFileName(fileName: string | undefined): string {
  const fallback = "attachment";
  const trimmed = (fileName ?? fallback).trim();
  const normalized = trimmed.replaceAll(/[^A-Za-z0-9._-]+/g, "_").replaceAll(/^_+|_+$/g, "");
  return normalized || fallback;
}
