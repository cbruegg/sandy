import { test } from "bun:test";
import assert from "node:assert/strict";
import { GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { sanitizeTelegramHtml } from "./telegram-html.js";
import { TelegramBotApiAdapter, normalizeTelegramUpdate } from "./telegram-adapter.js";
import { ImplicitChannelDestinationStore } from "./channel-destination-store.js";
import type { TranscriptionProvider } from "../transcription/transcription-provider.js";

const OWNER_ID = "5";
const OWNER_USERNAME = "cbruegg";

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
        username: "cbruegg",
      },
      chat_instance: "instance-1",
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: 42, type: "private", first_name: "Private" },
      },
    },
  });

  assert.deepEqual(event, {
    kind: "danger_report",
    chatId: "42",
    chatType: "private",
    messageId: "callback:cb-1",
    senderUserId: "5",
    senderUsername: "cbruegg",
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
        username: "cbruegg",
      },
      chat_instance: "instance-finish-1",
      message: {
        message_id: 22,
        date: 1_700_000_100,
        chat: { id: 42, type: "private", first_name: "Private" },
      },
    },
  } satisfies Update);

  assert.deepEqual(event, {
    kind: "mark_finished_request",
    chatId: "42",
    chatType: "private",
    messageId: "callback:cb-finish-1",
    senderUserId: "5",
    senderUsername: "cbruegg",
    timestamp: "2023-11-14T22:15:00.000Z",
  });
});

test("normalizeTelegramUpdate maps text input and unsupported media deterministically", async () => {
  const textEvent = await normalizeTelegramUpdate({
    update_id: 2,
    message: {
      message_id: 5,
      date: 1_700_000_010,
      chat: { id: 99, type: "private", first_name: "Private" },
      from: { id: 5, is_bot: false, first_name: "Owner", username: "cbruegg" },
      text: "/cancel",
    },
  } satisfies Update);

  assert.deepEqual(textEvent, {
    kind: "user_message",
    chatId: "99",
    chatType: "private",
    messageId: "5",
    senderUserId: "5",
    senderUsername: "cbruegg",
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
      chat: { id: 99, type: "private", first_name: "Private" },
      from: { id: 5, is_bot: false, first_name: "Owner", username: "cbruegg" },
      voice: {
        file_id: "voice-1",
        file_unique_id: "voice-u1",
        duration: 1,
      },
    },
  } satisfies Update);

  assert.deepEqual(voiceEvent, {
    kind: "unsupported_input",
    inputType: "voice",
    chatId: "99",
    chatType: "private",
    messageId: "6",
    senderUserId: "5",
    senderUsername: "cbruegg",
    timestamp: "2023-11-14T22:13:40.000Z",
  });

  const documentEvent = await normalizeTelegramUpdate({
    update_id: 4,
    message: {
      message_id: 7,
      date: 1_700_000_030,
      chat: { id: 99, type: "private", first_name: "Private" },
      from: { id: 5, is_bot: false, first_name: "Owner", username: "cbruegg" },
      caption: "Use this input file.",
      document: {
        file_id: "doc-1",
        file_unique_id: "doc-u1",
        file_name: "input data.csv",
        mime_type: "text/csv",
        file_size: 12,
      },
    },
  } satisfies Update);

  assert.deepEqual(documentEvent, {
    kind: "user_message",
    chatId: "99",
    chatType: "private",
    messageId: "7",
    senderUserId: "5",
    senderUsername: "cbruegg",
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

  const photoEvent = await normalizeTelegramUpdate({
    update_id: 5,
    message: {
      message_id: 8,
      date: 1_700_000_040,
      chat: { id: 99, type: "private", first_name: "Private" },
      from: { id: 5, is_bot: false, first_name: "Owner", username: "cbruegg" },
      caption: "what's in this image?",
      photo: [
        { file_id: "photo-small", file_unique_id: "photo-small-u", width: 320, height: 240, file_size: 12_000 },
        { file_id: "photo-large", file_unique_id: "photo-large-u", width: 1280, height: 960, file_size: 45_000 },
      ],
    },
  } satisfies Update);

  assert.deepEqual(photoEvent, {
    kind: "user_message",
    chatId: "99",
    chatType: "private",
    messageId: "8",
    senderUserId: "5",
    senderUsername: "cbruegg",
    timestamp: "2023-11-14T22:14:00.000Z",
    text: "what's in this image?",
    rawText: "what's in this image?",
    attachments: [{
      attachmentId: "photo-large",
      kind: "image",
      fileName: "photo_8.jpg",
      mimeType: "image/jpeg",
    }],
  });
});

test("TelegramBotApiAdapter keeps handling later updates after a handler error", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
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
      chat: { id: 7, type: "private", first_name: "Private" },
      from: { id: 5, is_bot: false, first_name: "Owner", username: "cbruegg" },
      text: "hello",
    },
  } satisfies Update);

  await fakeBot.dispatch({
    update_id: 2,
    message: {
      message_id: 2,
      date: 1_700_000_010,
      chat: { id: 7, type: "private", first_name: "Private" },
      from: { id: 5, is_bot: false, first_name: "Owner", username: "cbruegg" },
      text: "still there?",
    },
  } satisfies Update);

  await adapter.stop();

  assert.equal(handlerCalls, 2);
  assert.equal(fakeBot.sentMessages.length, 0);
});

test("TelegramBotApiAdapter acknowledges callback queries", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
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
        username: "cbruegg",
      },
      chat_instance: "instance-2",
      message: {
        message_id: 13,
        date: 1_700_000_030,
        chat: { id: 42, type: "private", first_name: "Private" },
      },
    },
  } satisfies Update);

  await adapter.stop();

  assert.equal(fakeBot.acknowledgedCallbackQueries, 1);
});

test("TelegramBotApiAdapter transcribes voice messages into normal text events", async () => {
  const fakeBot = new FakeTelegramBot();
  const handlerEvents: unknown[] = [];
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
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
      chat: { id: 99, type: "private", first_name: "Private" },
      from: { id: 5, is_bot: false, first_name: "Owner", username: "cbruegg" },
      voice: {
        file_id: "voice-2",
        file_unique_id: "voice-u2",
        duration: 2,
        mime_type: "audio/ogg",
      },
    },
  } satisfies Update);

  await adapter.stop();

  assert.deepEqual(handlerEvents, [{
    kind: "user_message",
    chatId: "99",
    chatType: "private",
    messageId: "8",
    senderUserId: "5",
    senderUsername: "cbruegg",
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
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
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
      chat: { id: 99, type: "private", first_name: "Private" },
      from: { id: 5, is_bot: false, first_name: "Owner", username: "cbruegg" },
      voice: {
        file_id: "voice-3",
        file_unique_id: "voice-u3",
        duration: 2,
      },
    },
  } satisfies Update);

  await adapter.stop();

  assert.deepEqual(handlerEvents, [{
    kind: "user_message",
    chatId: "99",
    chatType: "private",
    messageId: "9",
    senderUserId: "5",
    senderUsername: "cbruegg",
    timestamp: "2023-11-14T22:14:10.000Z",
    text: "/cancel",
    rawText: "/cancel",
    attachments: [],
  }]);
});

test("TelegramBotApiAdapter reports voice messages as disabled without STT configuration", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
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
      chat: { id: 99, type: "private", first_name: "Private" },
      from: { id: 5, is_bot: false, first_name: "Owner", username: "cbruegg" },
      voice: {
        file_id: "voice-4",
        file_unique_id: "voice-u4",
        duration: 2,
      },
    },
  } satisfies Update);

  await adapter.stop();

  assert.equal(handlerCalls, 0);
  assert.equal(fakeBot.sentMessages[0]?.text, "Voice messages are disabled. Configure STT in Sandy's config file to enable transcription.");
});

test("TelegramBotApiAdapter ignores unauthorized sender messages", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  let handlerCalls = 0;
  await adapter.start(async () => {
    handlerCalls += 1;
  });

  await fakeBot.dispatch({
    update_id: 7,
    message: {
      message_id: 11,
      date: 1_700_000_070,
      chat: { id: 99, type: "private", first_name: "Private" },
      from: { id: 77, is_bot: false, first_name: "Intruder", username: "intruder" },
      text: "hello",
    },
  } satisfies Update);

  await adapter.stop();

  assert.equal(handlerCalls, 0);
  assert.equal(fakeBot.sentMessages.length, 0);
});

test("TelegramBotApiAdapter ignores unauthorized voice messages before normalization side effects", async () => {
  const fakeBot = new FakeTelegramBot();
  let fileDownloads = 0;
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
    fileDownloader: async () => {
      fileDownloads += 1;
      return new Uint8Array([1, 2, 3]).buffer;
    },
  });

  let handlerCalls = 0;
  await adapter.start(async () => {
    handlerCalls += 1;
  });

  await fakeBot.dispatch({
    update_id: 7_1,
    message: {
      message_id: 11_1,
      date: 1_700_000_071,
      chat: { id: 99, type: "private", first_name: "Private" },
      from: { id: 77, is_bot: false, first_name: "Intruder", username: "intruder" },
      voice: {
        file_id: "voice-unauthorized",
        file_unique_id: "voice-unauthorized-u1",
        duration: 2,
      },
    },
  } satisfies Update);

  await adapter.stop();

  assert.equal(handlerCalls, 0);
  assert.equal(fileDownloads, 0);
  assert.equal(fakeBot.sentMessages.length, 0);
});

test("TelegramBotApiAdapter ignores owner messages outside private chats", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  let handlerCalls = 0;
  await adapter.start(async () => {
    handlerCalls += 1;
  });

  await fakeBot.dispatch({
    update_id: 8,
    message: {
      message_id: 12,
      date: 1_700_000_080,
      chat: { id: -100, type: "group", title: "Team" },
      from: { id: 5, is_bot: false, first_name: "Owner", username: "cbruegg" },
      text: "hello",
    },
  } satisfies Update);

  await adapter.stop();

  assert.equal(handlerCalls, 0);
  assert.equal(fakeBot.sentMessages.length, 0);
});

test("TelegramBotApiAdapter ignores unauthorized callback queries", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  let handlerCalls = 0;
  await adapter.start(async () => {
    handlerCalls += 1;
  });

  await fakeBot.dispatch({
    update_id: 9,
    callback_query: {
      id: "cb-unauthorized",
      data: "cancel",
      from: {
        id: 77,
        is_bot: false,
        first_name: "Intruder",
        username: "intruder",
      },
      chat_instance: "instance-unauthorized",
      message: {
        message_id: 13,
        date: 1_700_000_090,
        chat: { id: 42, type: "private", first_name: "Private" },
      },
    },
  } satisfies Update);

  await adapter.stop();

  assert.equal(handlerCalls, 0);
  assert.equal(fakeBot.acknowledgedCallbackQueries, 0);
});

test("TelegramBotApiAdapter authorizes by username when configured", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: "@cbruegg",
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  let handlerCalls = 0;
  await adapter.start(async () => {
    handlerCalls += 1;
  });

  await fakeBot.dispatch({
    update_id: 10,
    message: {
      message_id: 14,
      date: 1_700_000_100,
      chat: { id: 99, type: "private", first_name: "Private" },
      from: { id: 77, is_bot: false, first_name: "Owner", username: "cbruegg" },
      text: "hello",
    },
  } satisfies Update);

  await adapter.stop();

  assert.equal(handlerCalls, 1);
});

test("TelegramBotApiAdapter ignores messages when username does not match", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: `@${OWNER_USERNAME}`,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  let handlerCalls = 0;
  await adapter.start(async () => {
    handlerCalls += 1;
  });

  await fakeBot.dispatch({
    update_id: 11,
    message: {
      message_id: 15,
      date: 1_700_000_110,
      chat: { id: 99, type: "private", first_name: "Private" },
      from: { id: 5, is_bot: false, first_name: "Owner", username: "someoneelse" },
      text: "hello",
    },
  } satisfies Update);

  await adapter.stop();

  assert.equal(handlerCalls, 0);
});

test("sanitizeTelegramHtml preserves only the supported Telegram tags", () => {
  assert.equal(
    sanitizeTelegramHtml("Use <b>bold</b>, <blockquote>quote</blockquote>, and <script>alert(1)</script> plus <code>x < y</code>."),
    "Use <b>bold</b>, <blockquote>quote</blockquote>, and &lt;script&gt;alert(1)&lt;/script&gt; plus <code>x &lt; y</code>.",
  );
});

test("sanitizeTelegramHtml escapes unmatched allowed tags", () => {
  assert.equal(
    sanitizeTelegramHtml('Task failed: can\'t parse entities: Can\'t find end tag corresponding to start tag "pre" <pre>'),
    'Task failed: can\'t parse entities: Can\'t find end tag corresponding to start tag "pre" &lt;pre&gt;',
  );
});

test("TelegramBotApiAdapter sends sanitized HTML with parse_mode", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  await adapter.sendText("7", "Use **bold** and <u>underline</u>.");

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
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
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
            { text: "Abort task", callback_data: "cancel" },
            { text: "Mark as finished", callback_data: "mark_finished" },
          ],
        ],
      },
    },
  });
});

test("TelegramBotApiAdapter sends reportable text with a report control", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  await adapter.sendReportableText("7", "Task complete.");

  assert.deepEqual(fakeBot.sentMessages[0], {
    chatId: "7",
    text: "Task complete.",
    other: {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Report dangerous output", callback_data: "report" },
          ],
        ],
      },
    },
  });
});

test("TelegramBotApiAdapter sends privilege requests with appropriate controls", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  await adapter.sendPrivilegeRequest("7", {
    kind: "host_operation",
    requestId: "req-1",
    payload: { type: "copy_into_share", sourcePath: "/tmp", targetPath: "/share", reason: "test" },
  });

  assert.equal(fakeBot.sentMessages.length, 1);
  const markup = fakeBot.sentMessages[0]?.other?.["reply_markup"] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  assert.ok(markup);
  assert.equal(markup.inline_keyboard.length, 2);
  assert.equal(markup.inline_keyboard[0]?.[0]?.text, "Approve once");
  assert.equal(markup.inline_keyboard[0]?.[0]?.callback_data, "approve:req-1");
  assert.equal(markup.inline_keyboard[0]?.[1]?.text, "Deny");
  assert.equal(markup.inline_keyboard[0]?.[1]?.callback_data, "deny:req-1");
  assert.equal(markup.inline_keyboard[1]?.[0]?.text, "Report dangerous output");
  assert.equal(markup.inline_keyboard[1]?.[0]?.callback_data, "report");
  assert.equal(markup.inline_keyboard[1]?.[1]?.text, "Abort task");
  assert.equal(markup.inline_keyboard[1]?.[1]?.callback_data, "cancel");
});

test("TelegramBotApiAdapter sends share deletion requests with approve and deny controls", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  await adapter.sendShareDeletionRequest("7", "del-req-1", "inspect", "report.txt");

  assert.equal(fakeBot.sentMessages.length, 1);
  const markup = fakeBot.sentMessages[0]?.other?.["reply_markup"] as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  assert.ok(markup);
  assert.equal(markup.inline_keyboard.length, 1);
  assert.equal(markup.inline_keyboard[0]?.[0]?.text, "Approve once");
  assert.equal(markup.inline_keyboard[0]?.[0]?.callback_data, "share_approve:del-req-1");
  assert.equal(markup.inline_keyboard[0]?.[1]?.text, "Deny");
  assert.equal(markup.inline_keyboard[0]?.[1]?.callback_data, "share_deny:del-req-1");
});

test("TelegramBotApiAdapter sends local files as Telegram documents", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  await adapter.sendFile("7", "/tmp/result.txt", "Generated result");

  assert.equal(fakeBot.sentDocuments.length, 1);
  assert.equal(fakeBot.sentDocuments[0]?.chatId, "7");
  assert.equal(fakeBot.sentDocuments[0]?.other?.["caption"], "Generated result");
});

test("TelegramBotApiAdapter splits long messages into multiple sendMessage calls", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  const longText = "a".repeat(5000);
  await adapter.sendText("7", longText);

  assert.ok(fakeBot.sentMessages.length > 1);
  for (const msg of fakeBot.sentMessages) {
    assert.ok(msg.text.length < 4096);
  }
  assert.equal(fakeBot.sentMessages.map((m) => m.text).join(""), longText);
});

test("TelegramBotApiAdapter attaches reply_markup only to the final chunk", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  const longText = "b".repeat(5000);
  await adapter.sendTaskUpdate("7", longText);

  assert.ok(fakeBot.sentMessages.length > 1);
  for (let i = 0; i < fakeBot.sentMessages.length - 1; i += 1) {
    assert.equal(fakeBot.sentMessages[i]!.other?.["reply_markup"], undefined);
  }
  assert.ok(fakeBot.sentMessages.at(-1)!.other?.["reply_markup"]);
});

test("TelegramBotApiAdapter does not retry non-429 errors for single-chunk messages", async () => {
  const fakeBot = new FakeTelegramBot();
  fakeBot.sendMessageFailures = [
    createFakeGrammyError(400, {}),
  ];

  const adapter = new TelegramBotApiAdapter({
    allowedUser: OWNER_ID,
    token: "test-token",
    destinationStore: new ImplicitChannelDestinationStore("telegram_test"),
    botFactory: () => fakeBot,
  });

  await assert.rejects(() => adapter.sendText("7", "short"), /message is too long/);
  assert.equal(fakeBot.sentMessages.length, 0);
});

function createFakeGrammyError(errorCode: number, parameters: Record<string, unknown>): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    {
      ok: false,
      error_code: errorCode,
      description: errorCode === 429 ? "Too Many Requests" : "Bad Request: message is too long",
      parameters,
    },
    "sendMessage",
    {},
  );
}

class FakeTelegramBot {
  public readonly sentMessages: Array<{ chatId: string | number; text: string; other?: Record<string, unknown> }> = [];
  public readonly sentDocuments: Array<{ chatId: string | number; document: unknown; other?: Record<string, unknown> }> = [];
  public acknowledgedCallbackQueries = 0;
  public sendMessageFailures: Error[] = [];
  private sendMessageCallCount = 0;
  private readonly handlers = new Map<string, Array<(ctx: FakeTelegramContext) => Promise<void>>>();
  private stopResolve: (() => void) | null = null;

  public readonly api = {
    getFile: async () => ({ file_path: "documents/test.txt" }),
    sendMessage: async (chatId: string | number, text: string, other?: Record<string, unknown>) => {
      if (this.sendMessageCallCount < this.sendMessageFailures.length) {
        const error = this.sendMessageFailures[this.sendMessageCallCount];
        this.sendMessageCallCount += 1;
        if (error) {
          throw error;
        }
      }
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
