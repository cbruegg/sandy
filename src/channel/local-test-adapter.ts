import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ChannelAdapter, MessageHandler } from "./channel-adapter.js";
import { logger } from "../logger.js";
import type { ChannelFormatting, MessageAttachment, PrivilegeRequest, SavedAttachment } from "../types.js";
import type { ChatId } from "../types.js";
import {
  createIdentifier,
  parseLocalTestInboundEvent,
  serializeLocalTestOutboundEvent,
} from "./local-test-protocol.js";

const localTestFormatting: ChannelFormatting = {
  channelId: "local_test",
  markup: "plain_text",
  allowedTags: [],
  instructions: "Format user-visible output as plain text. Do not use Telegram HTML or Markdown-specific formatting.",
};

type LocalTestChannelAdapterOptions = {
  spoolRoot: string;
};

export class LocalTestChannelAdapter implements ChannelAdapter {
  private readonly spoolRoot: string;
  private readonly inboxRoot: string;
  private readonly inboxProcessedRoot: string;
  private readonly inboxFailedRoot: string;
  private readonly outboxRoot: string;
  private readonly attachmentHostPaths = new Map<string, string>();
  private readonly lastUserInteractionTimestamps = new Map<ChatId, string>();
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;

  constructor(options: LocalTestChannelAdapterOptions) {
    this.spoolRoot = options.spoolRoot;
    this.inboxRoot = join(this.spoolRoot, "inbox");
    this.inboxProcessedRoot = join(this.spoolRoot, "inbox-processed");
    this.inboxFailedRoot = join(this.spoolRoot, "inbox-failed");
    this.outboxRoot = join(this.spoolRoot, "outbox");
  }

  getFormatting(): ChannelFormatting {
    return localTestFormatting;
  }

  getLastUserInteractionTimestamp(chatId: ChatId): string | null {
    return this.lastUserInteractionTimestamps.get(chatId) ?? null;
  }

  async start(handler: MessageHandler): Promise<void> {
    if (this.loopPromise) {
      return;
    }

    await Promise.all([
      mkdir(this.inboxRoot, { recursive: true }),
      mkdir(this.inboxProcessedRoot, { recursive: true }),
      mkdir(this.inboxFailedRoot, { recursive: true }),
      mkdir(this.outboxRoot, { recursive: true }),
    ]);

    this.stopRequested = false;
    this.loopPromise = this.pollLoop(handler);
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  async saveAttachments(chatId: ChatId, attachments: MessageAttachment[], targetDirectory: string): Promise<SavedAttachment[]> {
    await mkdir(targetDirectory, { recursive: true });
    const saved: SavedAttachment[] = [];
    for (const attachment of attachments) {
      const sourcePath = this.attachmentHostPaths.get(attachment.attachmentId);
      if (!sourcePath) {
        throw new Error(`Unknown local-test attachment host path for ${attachment.attachmentId}.`);
      }
      const hostPath = join(targetDirectory, `${saved.length + 1}-${basename(attachment.fileName)}`);
      await copyFile(sourcePath, hostPath);
      saved.push({
        attachmentId: attachment.attachmentId,
        kind: attachment.kind,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        hostPath,
      });
    }
    logger.info("local_test.attachments_saved", {
      chatId,
      attachmentCount: saved.length,
      targetDirectory,
    });
    return saved;
  }

  async sendFile(chatId: ChatId, filePath: string, caption?: string): Promise<void> {
    await this.writeOutbound({
      type: "send_file",
      eventId: createIdentifier("outbound"),
      chatId,
      timestamp: new Date().toISOString(),
      filePath,
      caption,
    });
  }

  async sendText(chatId: ChatId, text: string): Promise<void> {
    await this.writeTextEvent("send_text", chatId, text);
  }

  async sendTaskUpdate(chatId: ChatId, text: string): Promise<void> {
    await this.writeTextEvent("send_task_update", chatId, text);
  }

  async sendReportableText(chatId: ChatId, text: string): Promise<void> {
    await this.writeTextEvent("send_reportable_text", chatId, text);
  }

  async sendPrivilegeRequest(chatId: ChatId, request: PrivilegeRequest): Promise<void> {
    await this.writeOutbound({
      type: "send_privilege_request",
      eventId: createIdentifier("outbound"),
      chatId,
      timestamp: new Date().toISOString(),
      request,
    });
  }

  async askForDenialReason(chatId: ChatId, request: PrivilegeRequest): Promise<void> {
    await this.writeOutbound({
      type: "send_denial_reason_prompt",
      eventId: createIdentifier("outbound"),
      chatId,
      timestamp: new Date().toISOString(),
      request,
    });
  }

  async sendShareDeletionRequest(chatId: ChatId, requestId: string, taskName: string, summary: string): Promise<void> {
    await this.writeOutbound({
      type: "send_share_deletion_request",
      eventId: createIdentifier("outbound"),
      chatId,
      timestamp: new Date().toISOString(),
      requestId,
      taskName,
      summary,
    });
  }

  private async writeTextEvent(type: "send_text" | "send_task_update" | "send_reportable_text", chatId: ChatId, text: string): Promise<void> {
    await this.writeOutbound({
      type,
      eventId: createIdentifier("outbound"),
      chatId,
      timestamp: new Date().toISOString(),
      text,
    });
  }

  private async writeOutbound(event: Parameters<typeof serializeLocalTestOutboundEvent>[0]): Promise<void> {
    await mkdir(this.outboxRoot, { recursive: true });
    const name = `${event.timestamp.replaceAll(/[:.]/g, "-")}-${event.eventId}.json`;
    const targetPath = join(this.outboxRoot, name);
    const tempPath = `${targetPath}.tmp`;
    await writeFile(tempPath, `${serializeLocalTestOutboundEvent(event)}\n`, "utf8");
    await rename(tempPath, targetPath);
  }

  private async pollLoop(handler: MessageHandler): Promise<void> {
    while (!this.stopRequested) {
      try {
        await this.processPending(handler);
      } catch (error) {
        logger.error("local_test.poll_failed", error, "Unknown local-test poll failure.");
      }
      if (!this.stopRequested) {
        await sleep(100);
      }
    }
  }

  private async processPending(handler: MessageHandler): Promise<void> {
    const entries = (await readdir(this.inboxRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (this.stopRequested) {
        return;
      }
      const sourcePath = join(this.inboxRoot, entry.name);
      const processingPath = join(this.inboxProcessedRoot, entry.name);
      try {
        const raw = await readFile(sourcePath, "utf8");
        const { event, attachmentsById } = parseLocalTestInboundEvent(raw);
        for (const [attachmentId, hostPath] of attachmentsById.entries()) {
          this.attachmentHostPaths.set(attachmentId, hostPath);
        }
        this.lastUserInteractionTimestamps.set(event.chatId, event.timestamp);
        await handler(event);
        await rename(sourcePath, processingPath);
      } catch (error) {
        const failedPath = join(
          this.inboxFailedRoot,
          `${Date.now()}-${createIdentifier("failed")}-${entry.name}`,
        );
        await rename(sourcePath, failedPath);
        logger.error("local_test.inbox_entry_failed", error, "Unknown local-test inbox failure.", {
          sourcePath,
          failedPath,
        });
      }
    }
  }
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
