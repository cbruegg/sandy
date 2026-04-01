import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTelegramUpdate } from "./channel/telegram-adapter.js";

test("normalizeTelegramUpdate maps report callback to a danger report event", () => {
  const event = normalizeTelegramUpdate({
    update_id: 1,
    callback_query: {
      id: "cb-1",
      data: "report",
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: 42 },
      },
    },
  });

  assert.deepEqual(event, {
    kind: "danger_report",
    chatId: "42",
    messageId: "callback:cb-1",
    timestamp: "2023-11-14T22:13:20.000Z",
  });
});

test("normalizeTelegramUpdate maps text commands and unsupported media deterministically", () => {
  const cancelEvent = normalizeTelegramUpdate({
    update_id: 2,
    message: {
      message_id: 5,
      date: 1_700_000_010,
      chat: { id: 99 },
      text: "/cancel",
    },
  });

  assert.deepEqual(cancelEvent, {
    kind: "cancel_request",
    chatId: "99",
    messageId: "5",
    timestamp: "2023-11-14T22:13:30.000Z",
  });

  const voiceEvent = normalizeTelegramUpdate({
    update_id: 3,
    message: {
      message_id: 6,
      date: 1_700_000_020,
      chat: { id: 99 },
      voice: {},
    },
  });

  assert.deepEqual(voiceEvent, {
    kind: "unsupported_input",
    inputType: "voice",
    chatId: "99",
    messageId: "6",
    timestamp: "2023-11-14T22:13:40.000Z",
  });
});
