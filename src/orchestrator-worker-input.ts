import type { MessageAttachment, SharedAttachment } from "./types.js";

export function describeUserMessageForMainAgent(text: string, attachments: MessageAttachment[]): string {
  if (attachments.length === 0) {
    return text;
  }

  const attachmentSummary = [
    "Attached files:",
    ...attachments.map((attachment) => `- ${attachment.fileName}`),
  ].join("\n");
  return text.trim() ? `${text}\n\n${attachmentSummary}` : attachmentSummary;
}

export function buildTaskBriefWithAttachments(taskBrief: string, attachments: SharedAttachment[]): string {
  const sections = [taskBrief];
  if (attachments.length > 0) {
    sections.push([
      "Files attached by the user are already available in the shared workspace:",
      ...attachments.map((attachment) => `- ${attachment.fileName}: ${attachment.sharePath}`),
      "Using these files does not require privilege escalation.",
    ].join("\n"));
  }

  return sections.join("\n\n");
}

export function buildWorkerFollowUpInput(text: string, attachments: SharedAttachment[]): string {
  const sections = [text.trim()].filter((section) => section.length > 0);
  if (attachments.length > 0) {
    sections.push([
      "The user attached additional files to the shared workspace:",
      ...attachments.map((attachment) => `- ${attachment.fileName}: ${attachment.sharePath}`),
      "Using these files does not require privilege escalation.",
    ].join("\n"));
  }
  return sections.join("\n\n");
}
