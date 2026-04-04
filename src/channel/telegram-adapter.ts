import { basename } from "node:path";
import { Bot, InputFile, type Context, type PollingOptions } from "grammy";
import type { ChannelAdapter, MessageHandler } from "./channel-adapter.js";
import { logger } from "../logger.js";
import { buttonLabels, messages } from "../messages.js";
import { sanitizeTelegramHtml, telegramHtmlAllowedTags } from "./telegram-html.js";
import { normalizeTelegramUpdate } from "./telegram-normalization.js";
import { saveTelegramAttachments } from "./telegram-files.js";
import type {
  ChannelFormatting,
  MessageAttachment,
  PrivilegeRequest,
  SavedAttachment,
} from "../types.js";

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

type TelegramContextLike = Pick<Context, "update" | "callbackQuery" | "answerCallbackQuery">;

type TelegramMiddleware = (ctx: TelegramContextLike) => Promise<void>;

type TelegramBotLike = {
  api: TelegramApiLike;
  on(filter: string | string[], middleware: TelegramMiddleware): unknown;
  catch(errorHandler: (error: unknown) => void): void;
  start(options?: PollingOptions): Promise<void>;
  stop(): Promise<void>;
};

export type TelegramBotFactory = (token: string) => TelegramBotLike;

export type TelegramAdapterOptions = {
  token: string;
  pollTimeoutSeconds?: number;
  botFactory?: TelegramBotFactory;
};

const telegramFormatting: ChannelFormatting = {
  channel: "telegram",
  markup: "telegram_html",
  allowedTags: telegramHtmlAllowedTags,
  instructions: "Format user-visible output as simple Telegram HTML using only <b>, <i>, <code>, and <pre>. Do not emit Markdown. Escape raw <, >, and & unless they are part of those exact tags.",
};

function defaultBotFactory(token: string): TelegramBotLike {
  return new Bot(token);
}

export class TelegramBotApiAdapter implements ChannelAdapter {
  private readonly bot: TelegramBotLike;
  private readonly pollTimeoutSeconds: number;
  private readonly token: string;
  private startPromise: Promise<void> | null = null;

  constructor(options: TelegramAdapterOptions) {
    this.token = options.token;
    this.bot = (options.botFactory ?? defaultBotFactory)(options.token);
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
  }

  getFormatting(): ChannelFormatting {
    return telegramFormatting;
  }

  start(handler: MessageHandler): Promise<void> {
    if (this.startPromise) {
      return Promise.resolve();
    }

    const middleware = async (ctx: TelegramContextLike): Promise<void> => {
      const event = normalizeTelegramUpdate(ctx.update);
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
        logger.error("telegram.handler_error", {
          kind: event.kind,
          chatId: event.chatId,
          message: error instanceof Error ? error.message : "Unknown handler error.",
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
      logger.error("telegram.polling_error", {
        message: error instanceof Error ? error.message : "Unknown Telegram polling error.",
      });
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
    await this.sendFormattedMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: buttonLabels.reportDangerousOutput, callback_data: "report" },
          { text: buttonLabels.cancelTask, callback_data: "cancel" },
        ]],
      },
    });
  }

  async sendPrivilegeRequest(chatId: string, request: PrivilegeRequest): Promise<void> {
    logger.info("telegram.send_privilege_request", {
      chatId,
      requestId: request.requestId,
      requestType: request.type,
    });
    await this.sendFormattedMessage(chatId, messages.privilegeRequestPrompt(request), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: buttonLabels.approve, callback_data: `approve:${request.requestId}` },
            { text: buttonLabels.deny, callback_data: `deny:${request.requestId}` },
          ],
          [
            { text: buttonLabels.reportDangerousOutput, callback_data: "report" },
            { text: buttonLabels.cancelTask, callback_data: "cancel" },
          ],
        ],
      },
    });
  }

  async sendShareDeletionRequest(chatId: string, requestId: string, taskName: string, summary: string): Promise<void> {
    logger.info("telegram.send_share_deletion_request", {
      chatId,
      requestId,
      taskName,
    });
    await this.sendFormattedMessage(chatId, messages.shareDeletionRequestPrompt(taskName, summary), {
      reply_markup: {
        inline_keyboard: [[
          { text: buttonLabels.approve, callback_data: `approve:${requestId}` },
          { text: buttonLabels.deny, callback_data: `deny:${requestId}` },
        ]],
      },
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
    await this.bot.api.sendMessage(chatId, sanitizeTelegramHtml(text), {
      parse_mode: "HTML",
      ...other,
    });
  }
}

function previewText(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

export { normalizeTelegramUpdate } from "./telegram-normalization.js";
