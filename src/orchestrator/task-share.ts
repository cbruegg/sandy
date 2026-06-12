import { join } from "node:path";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import type { MessageAttachment, SavedAttachment, SharedAttachment } from "../types.js";
import { toSharedWorkspacePath } from "../shared-workspace.js";

export async function stageSharedAttachments(input: {
  // Narrow to the single method we use so callers can pass the raw adapter
  // without granting wider channel access.
  channel: Pick<ChannelAdapter, "saveAttachments">;
  chatId: string;
  messageId: string;
  attachments: MessageAttachment[];
  taskSharePath: string;
}): Promise<SharedAttachment[]> {
  if (input.attachments.length === 0) {
    return [];
  }

  const targetDirectory = join(
    input.taskSharePath,
    "inbox",
    sanitizePathSegment(input.messageId),
  );
  const savedAttachments = await input.channel.saveAttachments(input.chatId, input.attachments, targetDirectory);
  return buildSharedAttachments(input.taskSharePath, savedAttachments);
}

function buildSharedAttachments(taskSharePath: string, attachments: SavedAttachment[]): SharedAttachment[] {
  return attachments.map((attachment) => ({
    ...attachment,
    sharePath: toSharedWorkspacePath(taskSharePath, attachment.hostPath),
  }));
}

function sanitizePathSegment(value: string): string {
  const normalized = value.replaceAll(/[^A-Za-z0-9._-]+/g, "_").replaceAll(/^_+|_+$/g, "");
  return normalized || "message";
}
