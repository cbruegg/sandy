import test from "node:test";
import assert from "node:assert/strict";
import type { Update } from "grammy/types";
import { sanitizeTelegramHtml } from "./channel/telegram-html.js";
import { TelegramBotApiAdapter, normalizeTelegramUpdate } from "./channel/telegram-adapter.js";
import type { TranscriptionProvider } from "./transcription/transcription-provider.js";

test("normalizeTelegramUpdate maps report callback to a danger report event", async () => {
  const event = await normalizeTelegramUpdate({
    update_id: 1,
    callback_query: {
      id: "cb-1",
      data: "report",
      from: {
        id: 5,
        is_bot: false,
        first_name: "User",
      },
      chat_instance: "instance-1",
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: 42, type: "private" },
      },
    },
  } as Update);

  assert.deepEqual(event, {
    kind: "danger_report",
    chatId: "42",
    messageId: "callback:cb-1",
    timestamp: "2023-11-14T22:13:20.000Z",
  });
});

test("normalizeTelegramUpdate maps mark-finished callback to a finish request event", async () => {
  const event = await normalizeTelegramUpdate({
    update_id: 11,
    callback_query: {
      id: "cb-finish-1",
      data: "mark_finished",
      from: {
        id: 5,
        is_bot: false,
        first_name: "User",
      },
      chat_instance: "instance-finish-1",
      message: {
        message_id: 22,
        date: 1_700_000_100,
        chat: { id: 42, type: "private" },
      },
    },
  } as Update);

  assert.deepEqual(event, {
    kind: "mark_finished_request",
    chatId: "42",
    messageId: "callback:cb-finish-1",
    timestamp: "2023-11-14T22:15:00.000Z",
  });
});

test("normalizeTelegramUpdate maps text input and unsupported media deterministically", async () => {
  const textEvent = await normalizeTelegramUpdate({
    update_id: 2,
    message: {
      message_id: 5,
      date: 1_700_000_010,
      chat: { id: 99, type: "private" },
      text: "/cancel",
    },
  } as Update);

  assert.deepEqual(textEvent, {
    kind: "user_text",
    chatId: "99",
    messageId: "5",
    timestamp: "2023-11-14T22:13:30.000Z",
    text: "/cancel",
    rawText: "/cancel",
    attachments: [],
  });

  const voiceEvent = await normalizeTelegramUpdate({
    update_id: 3,
    message: {
      message_id: 6,
      date: 1_700_000_020,
      chat: { id: 99, type: "private" },
      voice: {
        file_id: "voice-1",
        file_unique_id: "voice-u1",
        duration: 1,
      },
    },
  } as Update);

  assert.deepEqual(voiceEvent, {
    kind: "unsupported_input",
    inputType: "voice",
    chatId: "99",
    messageId: "6",
    timestamp: "2023-11-14T22:13:40.000Z",
  });

  const documentEvent = await normalizeTelegramUpdate({
    update_id: 4,
    message: {
      message_id: 7,
      date: 1_700_000_030,
      chat: { id: 99, type: "private" },
      caption: "Use this input file.",
      document: {
        file_id: "doc-1",
        file_unique_id: "doc-u1",
        file_name: "input data.csv",
        mime_type: "text/csv",
        file_size: 12,
      },
    },
  } as Update);

  assert.deepEqual(documentEvent, {
    kind: "user_text",
    chatId: "99",
    messageId: "7",
    timestamp: "2023-11-14T22:13:50.000Z",
    text: "Use this input file.",
    rawText: "Use this input file.",
    attachments: [{
      attachmentId: "doc-1",
      kind: "file",
      fileName: "input_data.csv",
      mimeType: "text/csv",
    }],
  });
});

test("TelegramBotApiAdapter keeps handling later updates after a handler error", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    token: "test-token",
    botFactory: () => fakeBot,
  });

  let handlerCalls = 0;

  await adapter.start(async () => {
    handlerCalls += 1;
    if (handlerCalls === 1) {
      throw new Error("handler failure");
    }
  });

  await fakeBot.dispatch({
    update_id: 1,
    message: {
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: 7, type: "private" },
      text: "hello",
    },
  } as Update);

  await fakeBot.dispatch({
    update_id: 2,
    message: {
      message_id: 2,
      date: 1_700_000_010,
      chat: { id: 7, type: "private" },
      text: "still there?",
    },
  } as Update);

  await adapter.stop();

  assert.equal(handlerCalls, 2);
});

test("TelegramBotApiAdapter acknowledges callback queries", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    token: "test-token",
    botFactory: () => fakeBot,
  });

  await adapter.start(async () => {});

  await fakeBot.dispatch({
    update_id: 3,
    callback_query: {
      id: "cb-2",
      data: "cancel",
      from: {
        id: 5,
        is_bot: false,
        first_name: "User",
      },
      chat_instance: "instance-2",
      message: {
        message_id: 13,
        date: 1_700_000_030,
        chat: { id: 42, type: "private" },
      },
    },
  } as Update);

  await adapter.stop();

  assert.equal(fakeBot.acknowledgedCallbackQueries, 1);
});

test("TelegramBotApiAdapter transcribes voice messages into normal text events", async () => {
  const fakeBot = new FakeTelegramBot();
  const handlerEvents: unknown[] = [];
  const adapter = new TelegramBotApiAdapter({
    token: "test-token",
    botFactory: () => fakeBot,
    fileDownloader: async () => new Uint8Array([1, 2, 3]).buffer,
    transcriptionProvider: {
      async transcribe() {
        return "inspect the system";
      },
    } satisfies TranscriptionProvider,
  });

  await adapter.start(async (event) => {
    handlerEvents.push(event);
  });

  await fakeBot.dispatch({
    update_id: 4,
    message: {
      message_id: 8,
      date: 1_700_000_040,
      chat: { id: 99, type: "private" },
      voice: {
        file_id: "voice-2",
        file_unique_id: "voice-u2",
        duration: 2,
        mime_type: "audio/ogg",
      },
    },
  } as Update);

  await adapter.stop();

  assert.deepEqual(handlerEvents, [{
    kind: "user_text",
    chatId: "99",
    messageId: "8",
    timestamp: "2023-11-14T22:14:00.000Z",
    text: "inspect the system",
    rawText: "inspect the system",
    attachments: [],
  }]);
});

test("TelegramBotApiAdapter keeps transcribed voice command text as plain user text", async () => {
  const fakeBot = new FakeTelegramBot();
  const handlerEvents: unknown[] = [];
  const adapter = new TelegramBotApiAdapter({
    token: "test-token",
    botFactory: () => fakeBot,
    fileDownloader: async () => new Uint8Array([1, 2, 3]).buffer,
    transcriptionProvider: {
      async transcribe() {
        return "/cancel";
      },
    } satisfies TranscriptionProvider,
  });

  await adapter.start(async (event) => {
    handlerEvents.push(event);
  });

  await fakeBot.dispatch({
    update_id: 5,
    message: {
      message_id: 9,
      date: 1_700_000_050,
      chat: { id: 99, type: "private" },
      voice: {
        file_id: "voice-3",
        file_unique_id: "voice-u3",
        duration: 2,
      },
    },
  } as Update);

  await adapter.stop();

  assert.deepEqual(handlerEvents, [{
    kind: "user_text",
    chatId: "99",
    messageId: "9",
    timestamp: "2023-11-14T22:14:10.000Z",
    text: "/cancel",
    rawText: "/cancel",
    attachments: [],
  }]);
});

test("TelegramBotApiAdapter reports voice messages as disabled without STT configuration", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    token: "test-token",
    botFactory: () => fakeBot,
  });

  let handlerCalls = 0;
  await adapter.start(async () => {
    handlerCalls += 1;
  });

  await fakeBot.dispatch({
    update_id: 6,
    message: {
      message_id: 10,
      date: 1_700_000_060,
      chat: { id: 99, type: "private" },
      voice: {
        file_id: "voice-4",
        file_unique_id: "voice-u4",
        duration: 2,
      },
    },
  } as Update);

  await adapter.stop();

  assert.equal(handlerCalls, 0);
  assert.equal(fakeBot.sentMessages[0]?.text, "Voice messages are disabled. Configure STT in Sandy's config file to enable transcription.");
});

test("sanitizeTelegramHtml preserves only the supported Telegram tags", () => {
  assert.equal(
    sanitizeTelegramHtml("Use <b>bold</b> and <script>alert(1)</script> plus <code>x < y</code>."),
    "Use <b>bold</b> and &lt;script&gt;alert(1)&lt;/script&gt; plus <code>x &lt; y</code>.",
  );
});

test("TelegramBotApiAdapter sends sanitized HTML with parse_mode", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    token: "test-token",
    botFactory: () => fakeBot,
  });

  await adapter.sendText("7", "Use <b>bold</b> and <u>underline</u>.");

  assert.deepEqual(fakeBot.sentMessages[0], {
    chatId: "7",
    text: "Use <b>bold</b> and &lt;u&gt;underline&lt;/u&gt;.",
    other: {
      parse_mode: "HTML",
    },
  });
});

test("TelegramBotApiAdapter sends task updates with abort and mark-finished controls", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    token: "test-token",
    botFactory: () => fakeBot,
  });

  await adapter.sendTaskUpdate("7", "Still working.");

  assert.deepEqual(fakeBot.sentMessages[0], {
    chatId: "7",
    text: "Still working.",
    other: {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Report dangerous output", callback_data: "report" },
            { text: "Abort task", callback_data: "cancel" },
          ],
          [
            { text: "Mark as finished", callback_data: "mark_finished" },
          ],
        ],
      },
    },
  });
});

test("TelegramBotApiAdapter sends local files as Telegram documents", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    token: "test-token",
    botFactory: () => fakeBot,
  });

  await adapter.sendFile("7", "/tmp/result.txt", "Generated result");

  assert.equal(fakeBot.sentDocuments.length, 1);
  assert.equal(fakeBot.sentDocuments[0]?.chatId, "7");
  assert.equal(fakeBot.sentDocuments[0]?.other?.caption, "Generated result");
});

class FakeTelegramBot {
  public readonly sentMessages: Array<{ chatId: string | number; text: string; other?: Record<string, unknown> }> = [];
  public readonly sentDocuments: Array<{ chatId: string | number; document: unknown; other?: Record<string, unknown> }> = [];
  public acknowledgedCallbackQueries = 0;
  private readonly handlers = new Map<string, Array<(ctx: FakeTelegramContext) => Promise<void>>>();
  private stopResolve: (() => void) | null = null;

  public readonly api = {
    getFile: async () => ({ file_path: "documents/test.txt" }),
    sendMessage: async (chatId: string | number, text: string, other?: Record<string, unknown>) => {
      this.sentMessages.push({ chatId, text, other });
      return true;
    },
    sendDocument: async (chatId: string | number, document: unknown, other?: Record<string, unknown>) => {
      this.sentDocuments.push({ chatId, document, other });
      return true;
    },
  };

  on(filter: string | string[], middleware: (ctx: FakeTelegramContext) => Promise<void>): void {
    const filters = Array.isArray(filter) ? filter : [filter];
    for (const entry of filters) {
      const existing = this.handlers.get(entry) ?? [];
      existing.push(middleware);
      this.handlers.set(entry, existing);
    }
  }

  catch(_errorHandler: (error: unknown) => void): void {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.stopResolve = resolve;
    });
  }

  async stop(): Promise<void> {
    this.stopResolve?.();
    this.stopResolve = null;
  }

  async dispatch(update: Update): Promise<void> {
    const filters = getMatchingFilters(update);
    const context = new FakeTelegramContext(update, () => {
      this.acknowledgedCallbackQueries += 1;
    });

    for (const filter of filters) {
      for (const handler of this.handlers.get(filter) ?? []) {
        await handler(context);
      }
    }
  }
}

class FakeTelegramContext {
  constructor(
    public readonly update: Update,
    private readonly onAck: () => void,
  ) {}

  get callbackQuery(): Update["callback_query"] | undefined {
    return this.update.callback_query;
  }

  async answerCallbackQuery(): Promise<true> {
    this.onAck();
    return true;
  }
}

function getMatchingFilters(update: Update): string[] {
  if (update.callback_query?.data) {
    return ["callback_query:data"];
  }
  if (update.message) {
    return ["message"];
  }
  return [];
}
