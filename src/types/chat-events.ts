import type { MessageAttachment } from "./attachments.js";

export type ChatId = string;

type ChatEventBase = {
  chatId: ChatId;
  messageId: string;
  timestamp: string;
};

export type UserMessageEvent = ChatEventBase & {
  kind: "user_message";
  text: string;
  rawText: string;
  attachments: MessageAttachment[];
};

type CancelRequestEvent = ChatEventBase & {
  kind: "cancel_request";
};

type MarkFinishedRequestEvent = ChatEventBase & {
  kind: "mark_finished_request";
};

type ApprovalResponseEvent = ChatEventBase & {
  kind: "approval_response";
  decision: "approve" | "approve_once" | "approve_worker_session" | "approve_always" | "deny";
  requestId?: string;
};

type DangerReportEvent = ChatEventBase & {
  kind: "danger_report";
};

type UnsupportedInputEvent = ChatEventBase & {
  kind: "unsupported_input";
  inputType: "image" | "file" | "voice";
};

export type NormalizedChatEvent =
  | UserMessageEvent
  | CancelRequestEvent
  | MarkFinishedRequestEvent
  | ApprovalResponseEvent
  | DangerReportEvent
  | UnsupportedInputEvent;
