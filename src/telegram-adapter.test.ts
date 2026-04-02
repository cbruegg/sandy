import test from "node:test";
import assert from "node:assert/strict";
import { TelegramBotApiAdapter, normalizeTelegramUpdate } from "./channel/telegram-adapter.js";

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

test("TelegramBotApiAdapter keeps polling after a handler error", async () => {
  let fetchCount = 0;
  let handlerCalls = 0;

  const fetchImpl: typeof fetch = async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    fetchCount += 1;
    const payload = fetchCount === 1
      ? {
          ok: true,
          result: [{
            update_id: 1,
            message: {
              message_id: 1,
              date: 1_700_000_000,
              chat: { id: 7 },
              text: "hello",
            },
          }],
        }
      : {
          ok: true,
          result: [],
        };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  };

  const adapter = new TelegramBotApiAdapter({
    token: "test-token",
    pollTimeoutSeconds: 0,
    pollErrorDelayMs: 0,
    fetchImpl,
  });

  await adapter.start(async () => {
    handlerCalls += 1;
    throw new Error("handler failure");
  });

  await waitFor(() => fetchCount >= 2);
  await adapter.stop();

  assert.equal(handlerCalls, 1);
  assert.ok(fetchCount >= 2);
});

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        reject(new Error("Timed out waiting for condition."));
        return;
      }
      setTimeout(poll, 10);
    };

    poll();
  });
}
