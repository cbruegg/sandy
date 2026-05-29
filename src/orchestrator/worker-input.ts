import type { MessageAttachment, SharedAttachment, TaskInputPayload } from "../types.js";

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

function buildFileAttachmentDescription(attachments: SharedAttachment[]): string {
  const fileAttachments = attachments.filter(attachment => attachment.kind === "file");
  
  if (fileAttachments.length === 0) {
    return "";
  }
  
  return [
    "Files attached by the user are already available in the shared workspace:",
    ...fileAttachments.map((attachment) => `- ${attachment.fileName}: ${attachment.sharePath}`),
    "Using these files does not require privilege escalation.",
  ].join("\n");
}

function buildFollowUpFileAttachmentDescription(attachments: SharedAttachment[]): string {
  const fileAttachments = attachments.filter(attachment => attachment.kind === "file");
  
  if (fileAttachments.length === 0) {
    return "";
  }
  
  return [
    "The user attached additional files to the shared workspace:",
    ...fileAttachments.map((attachment) => `- ${attachment.fileName}: ${attachment.sharePath}`),
    "Using these files does not require privilege escalation.",
  ].join("\n");
}

export function buildTaskBriefWithAttachments(taskBrief: string, attachments: SharedAttachment[]): string {
  const sections = [taskBrief];
  const fileDescription = buildFileAttachmentDescription(attachments);
  
  if (fileDescription) {
    sections.push(fileDescription);
  }
  
  return sections.join("\n\n");
}

export function buildTaskInputPayload(attachments: SharedAttachment[]): TaskInputPayload {
  const imageAttachments = attachments.filter(attachment => attachment.kind === "image");
  const fileDescription = buildFileAttachmentDescription(attachments);

  return {
    text: fileDescription,
    images: imageAttachments.map(img => ({ 
      sharePath: img.sharePath, 
      fileName: img.fileName 
    })),
  };
}

export function buildWorkerFollowUpInput(text: string, attachments: SharedAttachment[]): TaskInputPayload {
  const imageAttachments = attachments.filter(attachment => attachment.kind === "image");
  const fileDescription = buildFollowUpFileAttachmentDescription(attachments);
  
  const textSections = [text.trim()].filter((section) => section.length > 0);
  if (fileDescription) {
    textSections.push(fileDescription);
  }
  
  return {
    text: textSections.join("\n\n"),
    images: imageAttachments.map(img => ({ 
      sharePath: img.sharePath, 
      fileName: img.fileName 
    })),
  };
}


