import { basename } from "node:path";
import { Bot, InputFile, type Context, type PollingOptions } from "grammy";
import type { ChannelAdapter, MessageHandler } from "./channel-adapter.js";
import { logger } from "../logger.js";
import { buttonLabels, messages } from "../messages.js";
import { sanitizeTelegramHtml, telegramHtmlAllowedTags } from "./telegram-html.js";
import {
  extractTelegramUpdateMetadata,
  normalizeTelegramUpdate,
  type TelegramNormalizedChatEvent,
  type TelegramUpdateMetadata,
} from "./telegram-normalization.js";
import { downloadTelegramFile, saveTelegramAttachments } from "./telegram-files.js";
import { normalizeTelegramUsername } from "./telegram-user.js";
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
  markup: "telegram_html",
  allowedTags: telegramHtmlAllowedTags,
  instructions: "Format user-visible output as simple Telegram HTML using only <b>, <i>, <code>, and <pre>. Do not emit Markdown. Escape raw <, >, and & unless they are part of those exact tags. For line-breaks, use standard linebreaks (`\n`) instead of <br/> br tags.",
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
        inline_keyboard: [
          [
            { text: buttonLabels.abortTask, callback_data: "cancel" },
            { text: buttonLabels.markAsFinished, callback_data: "mark_finished" },
          ],
        ],
      },
    });
  }

  async sendReportableText(chatId: string, text: string): Promise<void> {
    logger.debug("telegram.send_reportable_text", {
      chatId,
      textPreview: previewText(text),
    });
    await this.sendFormattedMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: buttonLabels.reportDangerousOutput, callback_data: "report" },
        ]],
      },
    });
  }

  async sendPrivilegeRequest(chatId: string, request: PrivilegeRequest): Promise<void> {
    let requestType: string;
    switch (request.kind) {
      case "host_operation":
        requestType = request.payload.type;
        break;
      case "mcp_tool_call":
        requestType = `${request.serverId}.${request.toolName}`;
        break;
      case "mcp_resource_read":
        requestType = `resource:${request.serverId}:${request.uri}`;
        break;
      case "http_token_use":
        requestType = `http:${request.tokenId}@${request.host}`;
        break;
    }
    logger.info("telegram.send_privilege_request", {
      chatId,
      requestId: request.requestId,
      requestType,
    });
    await this.sendFormattedMessage(chatId, messages.privilegeRequestPrompt(request), {
      reply_markup: {
        inline_keyboard: buildPrivilegeKeyboard(request),
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

function buildPrivilegeKeyboard(request: PrivilegeRequest): Array<Array<{ text: string; callback_data: string }>> {
  if ((request.kind === "mcp_tool_call" || request.kind === "mcp_resource_read" || request.kind === "http_token_use")
    && request.confirmsAutoApprovalForTask) {
    return [
      [
        { text: buttonLabels.approve, callback_data: `approve:${request.requestId}` },
        { text: buttonLabels.deny, callback_data: `deny:${request.requestId}` },
      ],
      [
        { text: buttonLabels.reportDangerousOutput, callback_data: "report" },
        { text: buttonLabels.abortTask, callback_data: "cancel" },
      ],
    ];
  }

  if (request.kind === "mcp_tool_call" || request.kind === "mcp_resource_read" || request.kind === "http_token_use") {
    return [
      [
        { text: buttonLabels.approve, callback_data: `approve:${request.requestId}` },
        { text: buttonLabels.approveWorkerSession, callback_data: `approve_session:${request.requestId}` },
      ],
      [
        { text: buttonLabels.approveAlways, callback_data: `approve_always:${request.requestId}` },
        { text: buttonLabels.deny, callback_data: `deny:${request.requestId}` },
      ],
      [
        { text: buttonLabels.reportDangerousOutput, callback_data: "report" },
        { text: buttonLabels.abortTask, callback_data: "cancel" },
      ],
    ];
  }

  return [
    [
      { text: buttonLabels.approve, callback_data: `approve:${request.requestId}` },
      { text: buttonLabels.deny, callback_data: `deny:${request.requestId}` },
    ],
    [
      { text: buttonLabels.reportDangerousOutput, callback_data: "report" },
      { text: buttonLabels.abortTask, callback_data: "cancel" },
    ],
  ];
}

function previewText(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

export { normalizeTelegramUpdate } from "./telegram-normalization.js";
