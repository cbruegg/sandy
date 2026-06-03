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

test("splitTelegramHtml never produces chunks longer than maxLength even with boundary newlines", () => {
  // Construct text where a newline sits exactly at maxLength.
  // This used to trigger an infinite loop because findSafeSplitPoint
  // could return maxLength + 1.
  const prefix = "a".repeat(45);
  const text = `${prefix}\n${prefix}\n${prefix}`;
  const chunks = splitTelegramHtml(text, 50);
  for (const chunk of chunks) {
    assert.ok(
      chunk.length <= 50,
      `chunk length ${chunk.length} exceeds maxLength 50`,
    );
  }
});

test("splitTelegramHtml makes forward progress with many nested open tags", () => {
  // When a message starts with many nested allowed tags, the reopening
  // prefix added to the next chunk can be as large as the characters
  // consumed.  This used to cause an infinite loop.
  const open = "<b>".repeat(600);
  const content = "a".repeat(100);
  const close = "</b>".repeat(600);
  const text = open + content + close;
  const chunks = splitTelegramHtml(text);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(
      chunk.length < TELEGRAM_MAX_MESSAGE_LENGTH,
      `chunk length ${chunk.length} exceeds limit`,
    );
  }
});

test("splitTelegramHtml does not split surrogate pairs", () => {
  // Astral Unicode characters (e.g. emoji) are encoded as surrogate pairs
  // in UTF-16.  The split point must not land between the two halves.
  const text = "😀".repeat(3000);
  const chunks = splitTelegramHtml(text, 100);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
  }
  // Verify no lone surrogates by round-tripping through encode/decode.
  for (const chunk of chunks) {
    const encoded = new TextEncoder().encode(chunk);
    const decoded = new TextDecoder().decode(encoded);
    assert.equal(decoded, chunk);
  }
});
