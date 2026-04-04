import { join } from "node:path";
import type { ChannelAdapter } from "./channel/channel-adapter.js";
import type { SandboxRunner } from "./sandbox/sandbox-runner.js";
import type { MessageAttachment, SavedAttachment, SharedAttachment } from "./types.js";
import { toSharedWorkspacePath } from "./shared-workspace.js";

export async function stageSharedAttachments(input: {
  channel: ChannelAdapter;
  sandboxRunner: SandboxRunner;
  chatId: string;
  messageId: string;
  attachments: MessageAttachment[];
  taskId: string;
}): Promise<SharedAttachment[]> {
  if (input.attachments.length === 0) {
    return [];
  }

  const taskSharePath = input.sandboxRunner.getTaskSharePath(input.taskId);
  const targetDirectory = join(
    taskSharePath,
    "inbox",
    sanitizePathSegment(input.messageId),
  );
  const savedAttachments = await input.channel.saveAttachments(input.chatId, input.attachments, targetDirectory);
  return buildSharedAttachments(taskSharePath, savedAttachments);
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
