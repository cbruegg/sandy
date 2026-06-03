import { test } from "bun:test";
import assert from "node:assert/strict";
import { GrammyError } from "grammy";
import { runWithTelegramSendRetry } from "./telegram-send-retry.js";

function createTelegramRateLimitError(retryAfter: number | undefined): GrammyError {
  const parameters: Record<string, unknown> = retryAfter !== undefined ? { retry_after: retryAfter } : {};
  const err = new GrammyError(
    "Call to 'sendMessage' failed!",
    {
      ok: false,
      error_code: 429,
      description: "Too Many Requests",
      parameters,
    },
    "sendMessage",
    {},
  );
  return err;
}

function createTelegramBadRequestError(): GrammyError {
  return new GrammyError(
    "Call to 'sendMessage' failed!",
    {
      ok: false,
      error_code: 400,
      description: "Bad Request: message is too long",
      parameters: {},
    },
    "sendMessage",
    {},
  );
}

test("runWithTelegramSendRetry succeeds on first attempt", async () => {
  const result = await runWithTelegramSendRetry(
    "test",
    async () => "ok",
    async () => {},
  );
  assert.equal(result, "ok");
});

test("runWithTelegramSendRetry retries on 429 with retry_after", async () => {
  let attempts = 0;
  const sleepCalls: number[] = [];

  const result = await runWithTelegramSendRetry(
    "test",
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw createTelegramRateLimitError(2);
      }
      return "ok";
    },
    async (ms) => {
      sleepCalls.push(ms);
    },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(sleepCalls, [2_000, 4_000]);
});

test("runWithTelegramSendRetry falls back to exponential backoff when retry_after is missing", async () => {
  let attempts = 0;
  const sleepCalls: number[] = [];

  await runWithTelegramSendRetry(
    "test",
    async () => {
      attempts += 1;
      if (attempts < 2) {
        throw createTelegramRateLimitError(undefined);
      }
      return "ok";
    },
    async (ms) => {
      sleepCalls.push(ms);
    },
  );

  assert.equal(attempts, 2);
  assert.ok(sleepCalls[0]! >= 2_000);
});

test("runWithTelegramSendRetry does not retry non-429 errors", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      runWithTelegramSendRetry(
        "test",
        async () => {
          attempts += 1;
          throw createTelegramBadRequestError();
        },
        async () => {},
      ),
    /Bad Request: message is too long/,
  );

  assert.equal(attempts, 1);
});

test("runWithTelegramSendRetry throws after max attempts exhausted", async () => {
  let attempts = 0;
  const sleepCalls: number[] = [];

  await assert.rejects(
    () =>
      runWithTelegramSendRetry(
        "test",
        async () => {
          attempts += 1;
          throw createTelegramRateLimitError(1);
        },
        async (ms) => {
          sleepCalls.push(ms);
        },
      ),
    /Too Many Requests/,
  );

  assert.equal(attempts, 4);
  assert.equal(sleepCalls.length, 3);
});
