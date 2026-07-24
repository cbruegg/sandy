import { basename } from "node:path";
import { z } from "zod";
import type { MessageAttachment, NormalizedChatEvent, PrivilegeRequest } from "../types.js";
import type { ChatId } from "../types.js";

const approvalDecisionSchema = z.enum(["approve", "approve_once", "approve_worker_session", "approve_for_job", "approve_always", "deny"]);
const approvalTargetSchema = z.enum(["privilege_request", "share_deletion", "task_summary_confirmation"]);

const localTestAttachmentSchema = z.object({
  attachmentId: z.string().min(1).optional(),
  fileName: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  hostPath: z.string().min(1),
}).strict();

const localTestUserTextInputSchema = z.object({
  kind: z.literal("user_message"),
  messageId: z.string().min(1).optional(),
  timestamp: z.string().min(1).optional(),
  text: z.string().default(""),
  rawText: z.string().optional(),
  attachments: z.array(localTestAttachmentSchema).default([]),
}).strict();

const localTestSimpleInputSchema = z.object({
  messageId: z.string().min(1).optional(),
  timestamp: z.string().min(1).optional(),
}).strict();

const localTestApprovalInputSchema = localTestSimpleInputSchema.extend({
  kind: z.literal("approval_response"),
  target: approvalTargetSchema,
  decision: approvalDecisionSchema,
  requestId: z.string().min(1).optional(),
  reason: z.string().optional(),
}).strict();

const localTestInboundEventSchema = z.discriminatedUnion("kind", [
  localTestUserTextInputSchema,
  localTestSimpleInputSchema.extend({
    kind: z.literal("cancel_request"),
  }).strict(),
  localTestSimpleInputSchema.extend({
    kind: z.literal("mark_finished_request"),
  }).strict(),
  localTestSimpleInputSchema.extend({
    kind: z.literal("danger_report"),
  }).strict(),
  localTestApprovalInputSchema,
]);

type OutboundBase = {
  eventId: string;
  chatId: ChatId;
  timestamp: string;
};

type LocalTestOutboundEvent =
  | (OutboundBase & {
      type: "send_text" | "send_task_update" | "send_reportable_text";
      text: string;
    })
  | (OutboundBase & {
      type: "send_privilege_request";
      request: PrivilegeRequest;
    })
  | (OutboundBase & {
      type: "send_denial_reason_prompt";
      request: PrivilegeRequest;
    })
  | (OutboundBase & {
      type: "send_share_deletion_request";
      requestId: string;
      taskName: string;
      summary: string;
    })
  | (OutboundBase & {
      type: "send_task_summary_confirmation_request";
      requestId: string;
      taskName: string;
    })
  | (OutboundBase & {
      type: "send_file";
      filePath: string;
      caption?: string;
    });

const localTestOutboundEventSchema = z.discriminatedUnion("type", [
  z.object({
    eventId: z.string().min(1),
    chatId: z.string().min(1),
    timestamp: z.string().min(1),
    type: z.literal("send_text"),
    text: z.string(),
  }).strict(),
  z.object({
    eventId: z.string().min(1),
    chatId: z.string().min(1),
    timestamp: z.string().min(1),
    type: z.literal("send_task_update"),
    text: z.string(),
  }).strict(),
  z.object({
    eventId: z.string().min(1),
    chatId: z.string().min(1),
    timestamp: z.string().min(1),
    type: z.literal("send_reportable_text"),
    text: z.string(),
  }).strict(),
  z.object({
    eventId: z.string().min(1),
    chatId: z.string().min(1),
    timestamp: z.string().min(1),
    type: z.literal("send_privilege_request"),
    request: z.unknown(),
  }).strict(),
  z.object({
    eventId: z.string().min(1),
    chatId: z.string().min(1),
    timestamp: z.string().min(1),
    type: z.literal("send_denial_reason_prompt"),
    request: z.unknown(),
  }).strict(),
  z.object({
    eventId: z.string().min(1),
    chatId: z.string().min(1),
    timestamp: z.string().min(1),
    type: z.literal("send_share_deletion_request"),
    requestId: z.string().min(1),
    taskName: z.string(),
    summary: z.string(),
  }).strict(),
  z.object({
    eventId: z.string().min(1),
    chatId: z.string().min(1),
    timestamp: z.string().min(1),
    type: z.literal("send_task_summary_confirmation_request"),
    requestId: z.string().min(1),
    taskName: z.string(),
  }).strict(),
  z.object({
    eventId: z.string().min(1),
    chatId: z.string().min(1),
    timestamp: z.string().min(1),
    type: z.literal("send_file"),
    filePath: z.string().min(1),
    caption: z.string().optional(),
  }).strict(),
]);

const localTestChatId = "local-test";

export function parseLocalTestInboundEvent(raw: string): {
  event: NormalizedChatEvent;
  attachmentsById: Map<string, string>;
} {
  const parsed = localTestInboundEventSchema.parse(JSON.parse(raw));
  const timestamp = parsed.timestamp ?? new Date().toISOString();
  const messageId = parsed.messageId ?? createIdentifier("message");
  const attachmentsById = new Map<string, string>();

  if (parsed.kind === "user_message") {
    const attachments: MessageAttachment[] = parsed.attachments.map((attachment, index) => {
      const attachmentId = attachment.attachmentId ?? `${messageId}-attachment-${index + 1}`;
      attachmentsById.set(attachmentId, attachment.hostPath);
      return {
        attachmentId,
        kind: "file",
        fileName: attachment.fileName ?? basename(attachment.hostPath),
        mimeType: attachment.mimeType,
      };
    });
    return {
      event: {
        kind: "user_message",
        chatId: localTestChatId,
        messageId,
        timestamp,
        text: parsed.text,
        rawText: parsed.rawText ?? parsed.text,
        attachments,
      },
      attachmentsById,
    };
  }

  if (parsed.kind === "approval_response") {
    return {
      event: {
        kind: "approval_response",
        chatId: localTestChatId,
        messageId,
        timestamp,
        target: parsed.target,
        decision: parsed.decision,
        requestId: parsed.requestId,
        reason: parsed.reason,
      },
      attachmentsById,
    };
  }

  return {
    event: {
      ...parsed,
      chatId: localTestChatId,
      messageId,
      timestamp,
    },
    attachmentsById,
  };
}

export function serializeLocalTestOutboundEvent(event: LocalTestOutboundEvent): string {
  return JSON.stringify(localTestOutboundEventSchema.parse(event));
}

export function parseLocalTestOutboundEvent(raw: string): LocalTestOutboundEvent {
  return localTestOutboundEventSchema.parse(JSON.parse(raw)) as LocalTestOutboundEvent;
}

export function createIdentifier(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
