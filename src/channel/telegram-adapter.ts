import { basename } from "node:path";
import { Bot, InputFile, type Context, type PollingOptions } from "grammy";
import type { ChannelAdapter, MessageHandler } from "./channel-adapter.js";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import { renderTelegramMarkdownChunks } from "./telegram-html.js";
import {
  buildPrivilegeControls,
  buildReportControls,
  buildShareDeletionControls,
  buildTaskControls,
  formatPrivilegeRequestLogType,
  type ControlSurface,
} from "./control-surface.js";
import {
  extractTelegramUpdateMetadata,
  normalizeTelegramUpdate,
  type TelegramNormalizedChatEvent,
  type TelegramUpdateMetadata,
} from "./telegram-normalization.js";
import { downloadTelegramFile, saveTelegramAttachments } from "./telegram-files.js";
import { normalizeTelegramUsername } from "./telegram-user.js";
import { serializeTelegramCallbackData } from "./telegram-callback-data.js";
import type {
  ChannelFormatting,
  MessageAttachment,
  PrivilegeRequest,
  SavedAttachment,
} from "../types.js";
import type { TranscriptionProvider } from "../transcription/transcription-provider.js";

type TelegramApiLike = {
  getFile(fileId: string): Promise<{ file_path?: string }>;
  sendMessage(
    chatId: string | number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
  sendDocument(
    chatId: string | number,
    document: InputFile,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
};

type TelegramFileApiLike = Pick<TelegramApiLike, "getFile">;

type TelegramContextLike = Pick<Context, "update" | "callbackQuery" | "answerCallbackQuery">;

type TelegramMiddleware = (ctx: TelegramContextLike) => Promise<void>;

type TelegramBotLike = {
  api: TelegramApiLike;
  on(filter: string | string[], middleware: TelegramMiddleware): unknown;
  catch(errorHandler: (error: unknown) => void): void;
  start(options?: PollingOptions): Promise<void>;
  stop(): Promise<void>;
};

type TelegramBotFactory = (token: string) => TelegramBotLike;

type TelegramAdapterOptions = {
  token: string;
  allowedUser: string;
  pollTimeoutSeconds?: number;
  botFactory?: TelegramBotFactory;
  transcriptionProvider?: TranscriptionProvider;
  fileDownloader?: (api: TelegramFileApiLike, token: string, fileId: string) => Promise<ArrayBuffer>;
};

const telegramFormatting: ChannelFormatting = {
  channelId: "telegram",
  markup: "telegram_markdown",
  allowedTags: [],
  instructions: "Format user-visible output as simple Markdown. Supported formatting: **bold**, *italic* or _italic_, `inline code`, fenced code blocks using triple backticks, blockquotes using `> `, and normal paragraphs or line breaks. Use plain `- ` bullets when helpful. Do not emit raw HTML.",
};

function defaultBotFactory(token: string): TelegramBotLike {
  return new Bot(token);
}

export class TelegramBotApiAdapter implements ChannelAdapter {
  private readonly bot: TelegramBotLike;
  private readonly allowedUser: string;
  private readonly pollTimeoutSeconds: number;
  private readonly token: string;
  private readonly transcriptionProvider: TranscriptionProvider | null;
  private readonly fileDownloader: (api: TelegramFileApiLike, token: string, fileId: string) => Promise<ArrayBuffer>;
  private startPromise: Promise<void> | null = null;

  constructor(options: TelegramAdapterOptions) {
    this.token = options.token;
    this.allowedUser = options.allowedUser.trim();
    this.bot = (options.botFactory ?? defaultBotFactory)(options.token);
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
    this.transcriptionProvider = options.transcriptionProvider ?? null;
    this.fileDownloader = options.fileDownloader ?? downloadTelegramFile;
  }

  getFormatting(): ChannelFormatting {
    return telegramFormatting;
  }

  start(handler: MessageHandler): Promise<void> {
    if (this.startPromise) {
      return Promise.resolve();
    }

    const middleware = async (ctx: TelegramContextLike): Promise<void> => {
      const metadata = extractTelegramUpdateMetadata(ctx.update);
      if (metadata && !this.isAuthorizedEvent(metadata)) {
        logger.info("telegram.event_ignored_unauthorized", {
          chatId: metadata.chatId,
          chatType: metadata.chatType,
          kind: metadata.kind,
          messageId: metadata.messageId,
          senderUserId: metadata.senderUserId,
          senderUsername: metadata.senderUsername,
        });
        return;
      }

      const event = await normalizeTelegramUpdate(ctx.update, {
        transcriptionProvider: this.transcriptionProvider,
        fileDownloader: async (fileId) => this.fileDownloader(this.bot.api, this.token, fileId),
        sendText: async (chatId, text) => this.sendText(chatId, text),
      });
      if (!event) {
        return;
      }

      logger.info("telegram.event_received", {
        chatId: event.chatId,
        kind: event.kind,
        messageId: event.messageId,
      });

      try {
        await handler(event);
      } catch (error) {
        logger.error("telegram.handler_error", error, "Unknown handler error.", {
          kind: event.kind,
          chatId: event.chatId,
        });
      }

      if (ctx.callbackQuery) {
        try {
          await ctx.answerCallbackQuery();
        } catch (error) {
          logger.warn("telegram.callback_ack_failed", {
            message: error instanceof Error ? error.message : "Unknown callback acknowledgement failure.",
          });
        }
      }
    };

    this.bot.on("message", middleware);
    this.bot.on("callback_query:data", middleware);
    this.bot.catch((error) => {
      logger.error("telegram.polling_error", error, "Unknown Telegram polling error.");
    });

    logger.info("telegram.polling_started", {
      pollTimeoutSeconds: this.pollTimeoutSeconds,
    });

    this.startPromise = this.bot.start({
      timeout: this.pollTimeoutSeconds,
      allowed_updates: ["message", "callback_query"],
      onStart: () => {
        logger.info("telegram.bot_started");
      },
    });
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    if (!this.startPromise) {
      return;
    }

    await this.bot.stop();
    await this.startPromise;
    this.startPromise = null;
    logger.info("telegram.polling_stopped");
  }

  async sendText(chatId: string, text: string): Promise<void> {
    logger.debug("telegram.send_text", {
      chatId,
      textPreview: previewText(text),
    });
    await this.sendFormattedMessage(chatId, text);
  }

  async sendTaskUpdate(chatId: string, text: string): Promise<void> {
    logger.debug("telegram.send_task_update", {
      chatId,
      textPreview: previewText(text),
    });
    const controls = buildTaskControls();
    await this.sendFormattedMessage(chatId, text, {
      reply_markup: { inline_keyboard: controlSurfaceToTelegramKeyboard(controls) },
    });
  }

  async sendReportableText(chatId: string, text: string): Promise<void> {
    logger.debug("telegram.send_reportable_text", {
      chatId,
      textPreview: previewText(text),
    });
    const controls = buildReportControls();
    await this.sendFormattedMessage(chatId, text, {
      reply_markup: { inline_keyboard: controlSurfaceToTelegramKeyboard(controls) },
    });
  }

  async sendPrivilegeRequest(chatId: string, request: PrivilegeRequest): Promise<void> {
    const requestType = formatPrivilegeRequestLogType(request);
    logger.info("telegram.send_privilege_request", {
      chatId,
      requestId: request.requestId,
      requestType,
    });
    const controls = buildPrivilegeControls(request);
    await this.sendFormattedMessage(chatId, messages.privilegeRequestPrompt(request), {
      reply_markup: { inline_keyboard: controlSurfaceToTelegramKeyboard(controls) },
    });
  }

  async sendShareDeletionRequest(chatId: string, requestId: string, taskName: string, summary: string): Promise<void> {
    logger.info("telegram.send_share_deletion_request", {
      chatId,
      requestId,
      taskName,
    });
    const controls = buildShareDeletionControls(requestId);
    await this.sendFormattedMessage(chatId, messages.shareDeletionRequestPrompt(taskName, summary), {
      reply_markup: { inline_keyboard: controlSurfaceToTelegramKeyboard(controls) },
    });
  }

  async saveAttachments(chatId: string, attachments: MessageAttachment[], targetDirectory: string): Promise<SavedAttachment[]> {
    return saveTelegramAttachments({
      api: this.bot.api,
      token: this.token,
      chatId,
      attachments,
      targetDirectory,
      logSavedAttachment: (entry) => {
        logger.info("telegram.attachment_saved", entry);
      },
    });
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    logger.info("telegram.send_file", {
      chatId,
      filePath,
      captionPreview: caption ? previewText(caption) : undefined,
    });
    await this.bot.api.sendDocument(chatId, new InputFile(filePath, basename(filePath)), {
      caption,
    });
  }

  private async sendFormattedMessage(
    chatId: string,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<void> {
    const chunks = renderTelegramMarkdownChunks(text);

    for (let i = 0; i < chunks.length; i += 1) {
      const isLastChunk = i === chunks.length - 1;
      const payloadOther = isLastChunk ? other : undefined;
      await this.bot.api.sendMessage(chatId, chunks[i]!, {
        parse_mode: "HTML",
        ...payloadOther,
      });
    }
  }

  private isAuthorizedEvent(event: TelegramNormalizedChatEvent | TelegramUpdateMetadata): boolean {
    if (event.chatType !== "private") {
      return false;
    }

    if (this.allowedUser.startsWith("@")) {
      return normalizeTelegramUsername(event.senderUsername ?? undefined) === normalizeTelegramUsername(this.allowedUser);
    }

    return event.senderUserId === this.allowedUser;
  }
}

function controlSurfaceToTelegramKeyboard(controls: ControlSurface): Array<Array<{ text: string; callback_data: string }>> {
  return controls.rows.map((row) =>
    row.map((action) => ({
      text: action.label,
      callback_data: serializeTelegramCallbackData(action.actionId, action.event),
    }))
  );
}

function previewText(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

export { normalizeTelegramUpdate } from "./telegram-normalization.js";
