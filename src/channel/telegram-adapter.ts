import { Bot, type Context, type PollingOptions } from "grammy";
import type { Update } from "grammy/types";
import type { ChannelAdapter, MessageHandler } from "./channel-adapter.js";
import { logger } from "../logger.js";
import { buttonLabels, messages } from "../messages.js";
import { sanitizeTelegramHtml, telegramHtmlAllowedTags } from "./telegram-html.js";
import type { ApprovalResponseEvent, ChannelFormatting, DangerReportEvent, NormalizedChatEvent, PrivilegeRequest } from "../types.js";

type TelegramApiLike = {
  sendMessage(
    chatId: string | number,
    text: string,
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

function nowFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function normalizeTelegramUpdate(update: Update): NormalizedChatEvent | null {
  if (update.callback_query?.data && update.callback_query.message && "date" in update.callback_query.message) {
    const { data, message } = update.callback_query;
    const base = {
      chatId: String(message.chat.id),
      messageId: `callback:${update.callback_query.id}`,
      timestamp: nowFromUnix(message.date),
    };

    if (data.startsWith("approve:")) {
      const event: ApprovalResponseEvent = {
        ...base,
        kind: "approval_response",
        decision: "approve",
        requestId: data.slice("approve:".length) || undefined,
      };
      return event;
    }

    if (data.startsWith("deny:")) {
      const event: ApprovalResponseEvent = {
        ...base,
        kind: "approval_response",
        decision: "deny",
        requestId: data.slice("deny:".length) || undefined,
      };
      return event;
    }

    if (data === "report") {
      const event: DangerReportEvent = {
        ...base,
        kind: "danger_report",
      };
      return event;
    }

    if (data === "cancel") {
      return {
        ...base,
        kind: "cancel_request",
      };
    }
  }

  if (!update.message) {
    return null;
  }

  const base = {
    chatId: String(update.message.chat.id),
    messageId: String(update.message.message_id),
    timestamp: nowFromUnix(update.message.date),
  };

  if ("text" in update.message && typeof update.message.text === "string") {
    const rawText = update.message.text;
    const normalized = rawText.trim().toLowerCase();

    if (normalized === "/cancel" || normalized === "cancel") {
      return { ...base, kind: "cancel_request" };
    }
    if (normalized === "/report" || normalized === "report") {
      return { ...base, kind: "danger_report" };
    }
    if (normalized === "/approve" || normalized === "approve") {
      return { ...base, kind: "approval_response", decision: "approve" };
    }
    if (normalized === "/deny" || normalized === "deny") {
      return { ...base, kind: "approval_response", decision: "deny" };
    }

    return {
      ...base,
      kind: "user_text",
      text: rawText,
      rawText,
    };
  }

  if ("voice" in update.message && update.message.voice) {
    return { ...base, kind: "unsupported_input", inputType: "voice" };
  }

  if ("photo" in update.message && update.message.photo) {
    return { ...base, kind: "unsupported_input", inputType: "image" };
  }

  if ("document" in update.message && update.message.document) {
    return { ...base, kind: "unsupported_input", inputType: "file" };
  }

  return null;
}

export class TelegramBotApiAdapter implements ChannelAdapter {
  private readonly bot: TelegramBotLike;
  private readonly pollTimeoutSeconds: number;
  private startPromise: Promise<void> | null = null;

  constructor(options: TelegramAdapterOptions) {
    this.bot = (options.botFactory ?? defaultBotFactory)(options.token);
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
  }

  getFormatting(): ChannelFormatting {
    return telegramFormatting;
  }

  async start(handler: MessageHandler): Promise<void> {
    if (this.startPromise) {
      return;
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
