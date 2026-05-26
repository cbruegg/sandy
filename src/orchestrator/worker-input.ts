import type { MessageAttachment, SharedAttachment, TaskInputPayload } from "../types.js";
import type { RelevantMemory } from "../memory/types.js";

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

/**
 * Build a plain-text context block from host-retrieved relevant memories.
 * This block is injected into the sub-agent's initial task input so it has
 * background from past trusted work in the same chat.
 */
function buildMemoryContextText(memories: RelevantMemory[]): string {
  if (memories.length === 0) {
    return "";
  }

  const lines = [
    "Trusted memories from past work in this chat (provided by Sandy host, use when relevant):",
  ];

  for (const memory of memories) {
    const date = memory.createdAt ? ` [${memory.createdAt.substring(0, 10)}]` : "";
    const source = memory.room ? ` (${memory.room})` : "";
    // Truncate very long memory texts to keep the prompt compact. The
    // sub-agent can ask the host for more detail if needed.
    const truncated = memory.text.length > 500
      ? memory.text.substring(0, 500) + "..."
      : memory.text;
    lines.push(`-${date}${source}: ${truncated}`);
  }

  return lines.join("\n");
}

/**
 * Returns a new TaskInputPayload with memory context prepended to the text
 * section. The original payload is not mutated.
 */
export function injectMemoryIntoTaskInput(
  input: TaskInputPayload,
  memories: RelevantMemory[],
): TaskInputPayload {
  const memoryText = buildMemoryContextText(memories);
  if (!memoryText) {
    return input;
  }

  const sections = [input.text.trim()].filter((s) => s.length > 0);
  sections.unshift(memoryText);

  return {
    text: sections.join("\n\n"),
    images: input.images,
  };
}
