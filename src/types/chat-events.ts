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
  | UserTextEvent
  | CancelRequestEvent
  | MarkFinishedRequestEvent
  | ApprovalResponseEvent
  | DangerReportEvent
  | UnsupportedInputEvent;
