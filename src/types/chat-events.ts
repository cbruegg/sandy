import type { MessageAttachment } from "./attachments.js";

type ChatEventBase = {
  chatId: string;
  messageId: string;
  timestamp: string;
};

export type UserTextEvent = ChatEventBase & {
  kind: "user_text";
  text: string;
  rawText: string;
  attachments: MessageAttachment[];
};

export type CancelRequestEvent = ChatEventBase & {
  kind: "cancel_request";
};

export type ApprovalResponseEvent = ChatEventBase & {
  kind: "approval_response";
  decision: "approve" | "deny";
  requestId?: string;
};

export type DangerReportEvent = ChatEventBase & {
  kind: "danger_report";
};

export type UnsupportedInputEvent = ChatEventBase & {
  kind: "unsupported_input";
  inputType: "image" | "file" | "voice";
};

export type NormalizedChatEvent =
  | UserTextEvent
  | CancelRequestEvent
  | ApprovalResponseEvent
  | DangerReportEvent
  | UnsupportedInputEvent;
