import type { ChannelAdapter, MessageHandler } from "./channel-adapter.js";
import { logger } from "../logger.js";
import type { ApprovalResponseEvent, DangerReportEvent, NormalizedChatEvent, PrivilegeRequest } from "../types.js";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number | string };
    text?: string;
    voice?: unknown;
    photo?: unknown[];
    document?: unknown;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id: number;
      date: number;
      chat: { id: number | string };
    };
  };
};

type TelegramGetUpdatesResponse = {
  ok: boolean;
  result: TelegramUpdate[];
};

type TelegramSendResponse = {
  ok: boolean;
};

export type TelegramAdapterOptions = {
  token: string;
  apiBaseUrl?: string;
  pollTimeoutSeconds?: number;
  pollErrorDelayMs?: number;
  fetchImpl?: typeof fetch;
};

function nowFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function normalizeTelegramUpdate(update: TelegramUpdate): NormalizedChatEvent | null {
  if (update.callback_query?.data && update.callback_query.message) {
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

  if (typeof update.message.text === "string") {
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

  if (update.message.voice) {
    return { ...base, kind: "unsupported_input", inputType: "voice" };
  }

  if (update.message.photo) {
    return { ...base, kind: "unsupported_input", inputType: "image" };
  }

  if (update.message.document) {
    return { ...base, kind: "unsupported_input", inputType: "file" };
  }

  return null;
}

export class TelegramBotApiAdapter implements ChannelAdapter {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly pollTimeoutSeconds: number;
  private readonly pollErrorDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private running = false;
  private updateOffset = 0;
  private pollPromise: Promise<void> | null = null;

  constructor(options: TelegramAdapterOptions) {
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.telegram.org";
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 30;
    this.pollErrorDelayMs = options.pollErrorDelayMs ?? 1000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async start(handler: MessageHandler): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    logger.info("telegram.polling_started", {
      apiBaseUrl: this.apiBaseUrl,
      pollTimeoutSeconds: this.pollTimeoutSeconds,
    });
    this.pollPromise = this.pollLoop(handler);
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.pollPromise;
    logger.info("telegram.polling_stopped");
  }

  async sendText(chatId: string, text: string): Promise<void> {
    logger.debug("telegram.send_text", {
      chatId,
      textPreview: previewText(text),
    });
    await this.callTelegram("sendMessage", {
      chat_id: chatId,
      text,
    });
  }

  async sendTaskUpdate(chatId: string, text: string): Promise<void> {
    logger.debug("telegram.send_task_update", {
      chatId,
      textPreview: previewText(text),
    });
    await this.callTelegram("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [[
          { text: "Report dangerous output", callback_data: "report" },
          { text: "Cancel task", callback_data: "cancel" },
        ]],
      },
    });
  }

  async sendPrivilegeRequest(chatId: string, request: PrivilegeRequest): Promise<void> {
    const description = describePrivilegeRequest(request);
    logger.info("telegram.send_privilege_request", {
      chatId,
      requestId: request.requestId,
      requestType: request.type,
    });
    await this.callTelegram("sendMessage", {
      chat_id: chatId,
      text: `Privilege request:\n${description}\n\nApprove or deny this request.`,
      reply_markup: {
        inline_keyboard: [[
          { text: "Approve", callback_data: `approve:${request.requestId}` },
          { text: "Deny", callback_data: `deny:${request.requestId}` },
        ]],
      },
    });
  }

  private async pollLoop(handler: MessageHandler): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.updateOffset = update.update_id + 1;
          const event = normalizeTelegramUpdate(update);
          if (event) {
            logger.info("telegram.event_received", {
              chatId: event.chatId,
              kind: event.kind,
              messageId: event.messageId,
            });
            await handler(event);
          }
        }
      } catch (error) {
        logger.error("telegram.polling_error", {
          message: error instanceof Error ? error.message : "Unknown polling error.",
        });
        if (!this.running) {
          break;
        }
        await delay(this.pollErrorDelayMs);
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const response = await this.callTelegram<TelegramGetUpdatesResponse>("getUpdates", {
      offset: this.updateOffset,
      timeout: this.pollTimeoutSeconds,
      allowed_updates: ["message", "callback_query"],
    });
    return response.result;
  }

  private async callTelegram<T = TelegramSendResponse>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      logger.error("telegram.api_error", {
        method,
        status: response.status,
      });
      throw new Error(`Telegram API ${method} failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as T & { ok?: boolean };
    if ("ok" in payload && payload.ok === false) {
      throw new Error(`Telegram API ${method} returned an unsuccessful response.`);
    }
    return payload as T;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function previewText(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

function describePrivilegeRequest(request: PrivilegeRequest): string {
  switch (request.type) {
    case "copy_into_share":
    case "copy_out_of_share":
      return `${request.type}: ${request.sourcePath} -> ${request.targetPath}\nReason: ${request.reason}`;
    case "mount_ro":
    case "mount_rw":
      return `${request.type}: ${request.hostPath} -> ${request.targetPath}\nReason: ${request.reason}`;
    case "enable_mcp":
    case "enable_onecli":
      return `${request.type}: ${request.identifier}\nReason: ${request.reason}`;
  }
}
