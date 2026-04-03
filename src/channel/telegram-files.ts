import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MessageAttachment, SavedAttachment } from "../types.js";

type TelegramFileApi = {
  getFile(fileId: string): Promise<{ file_path?: string }>;
};

export async function saveTelegramAttachments(input: {
  api: TelegramFileApi;
  token: string;
  chatId: string;
  attachments: MessageAttachment[];
  targetDirectory: string;
  logSavedAttachment: (entry: { chatId: string; attachmentId: string; hostPath: string }) => void;
}): Promise<SavedAttachment[]> {
  if (input.attachments.length === 0) {
    return [];
  }

  await mkdir(input.targetDirectory, { recursive: true });
  const saved: SavedAttachment[] = [];

  for (const [index, attachment] of input.attachments.entries()) {
    const file = await input.api.getFile(attachment.attachmentId);
    if (!file.file_path) {
      throw new Error(`Telegram did not return a download path for attachment ${attachment.attachmentId}.`);
    }

    const response = await fetch(buildTelegramFileUrl(input.token, file.file_path));
    if (!response.ok) {
      throw new Error(`Telegram file download failed with status ${response.status} for attachment ${attachment.attachmentId}.`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const fileName = withUniquePrefix(index, attachment.fileName);
    const hostPath = resolve(input.targetDirectory, fileName);
    await writeFile(hostPath, Buffer.from(arrayBuffer));

    input.logSavedAttachment({
      chatId: input.chatId,
      attachmentId: attachment.attachmentId,
      hostPath,
    });

    saved.push({
      attachmentId: attachment.attachmentId,
      kind: attachment.kind,
      fileName: attachment.fileName,
      hostPath,
      mimeType: attachment.mimeType,
    });
  }

  return saved;
}

function buildTelegramFileUrl(token: string, filePath: string): string {
  return `https://api.telegram.org/file/bot${token}/${filePath}`;
}

function withUniquePrefix(index: number, fileName: string): string {
  return `${index + 1}-${fileName}`;
}
