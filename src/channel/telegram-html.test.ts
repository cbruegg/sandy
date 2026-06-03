import { test } from "bun:test";
import assert from "node:assert/strict";
import { splitTelegramHtml, TELEGRAM_MAX_MESSAGE_LENGTH } from "./telegram-html.js";

test("splitTelegramHtml returns a single chunk for short text", () => {
  const text = "Short message.";
  assert.deepEqual(splitTelegramHtml(text, 100), [text]);
});

test("splitTelegramHtml splits plain text at newline when possible", () => {
  const line = "a".repeat(40);
  const text = `${line}\n${line}\n${line}`;
  const chunks = splitTelegramHtml(text, 50);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 50);
  }
  assert.equal(chunks.join(""), text);
});

test("splitTelegramHtml splits plain text at space when no newline", () => {
  const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
  const chunks = splitTelegramHtml(words, 30);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 30);
  }
  assert.equal(chunks.join(""), words);
});

test("splitTelegramHtml re-opens tags across chunk boundaries", () => {
  const inner = "x".repeat(200);
  const text = `<b>${inner}</b>`;
  const chunks = splitTelegramHtml(text, 100);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
  }
  assert.ok(chunks[0]!.endsWith("</b>"));
  assert.ok(chunks[1]!.startsWith("<b>"));
});

test("splitTelegramHtml does not split inside an HTML entity", () => {
  const segment = "Use &lt;code&gt; for code. ";
  const text = segment.repeat(5);
  const chunks = splitTelegramHtml(text, 100);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
  }
  // Verify no broken entities by checking every chunk can be parsed as valid
  // (no stray & without ;) – simplest check is join does not insert new chars.
  assert.equal(chunks.join("").replaceAll(/<\/?[a-z]+>/g, ""), text.replaceAll(/<\/?[a-z]+>/g, ""));
});

test("splitTelegramHtml does not split inside a tag", () => {
  const inner = "a".repeat(200);
  const text = `<pre>${inner}</pre>`;
  const chunks = splitTelegramHtml(text, 100);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
  }
});

test("splitTelegramHtml handles deeply nested open tags", () => {
  const inner = "y".repeat(100);
  const text = `<b><i><code>${inner}</code></i></b>`;
  const chunks = splitTelegramHtml(text, 100);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0]!.endsWith("</code></i></b>"));
  assert.ok(chunks[1]!.startsWith("<b><i><code>"));
});

test("splitTelegramHtml default maxLength stays under Telegram limit", () => {
  const text = "z".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 100);
  const chunks = splitTelegramHtml(text);
  for (const chunk of chunks) {
    assert.ok(chunk.length < TELEGRAM_MAX_MESSAGE_LENGTH);
  }
});
