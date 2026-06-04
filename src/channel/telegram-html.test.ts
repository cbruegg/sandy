import { test } from "bun:test";
import assert from "node:assert/strict";
import { renderTelegramMarkdownChunks, TELEGRAM_MAX_MESSAGE_LENGTH } from "./telegram-html.js";

test("renderTelegramMarkdownChunks returns a single chunk for short text", () => {
  const text = "Short message.";
  assert.deepEqual(renderTelegramMarkdownChunks(text, 100), [text]);
});

test("renderTelegramMarkdownChunks renders supported inline markdown", () => {
  assert.deepEqual(renderTelegramMarkdownChunks("**bold** *italic* `code`", 100), ["<b>bold</b> <i>italic</i> <code>code</code>"]);
});

test("renderTelegramMarkdownChunks renders fenced code blocks", () => {
  assert.deepEqual(renderTelegramMarkdownChunks("```\nconst x = 1 < 2;\n```", 100), ["<pre>const x = 1 &lt; 2;</pre>"]);
});

test("renderTelegramMarkdownChunks splits plain text at newline when possible", () => {
  const line = "a".repeat(40);
  const text = `${line}\n${line}\n${line}`;
  const chunks = renderTelegramMarkdownChunks(text, 50);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 50);
  }
  assert.equal(chunks.join(""), text);
});

test("renderTelegramMarkdownChunks splits plain text at space when no newline", () => {
  const words = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
  const chunks = renderTelegramMarkdownChunks(words, 30);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 30);
  }
  assert.equal(chunks.join(""), words);
});

test("renderTelegramMarkdownChunks re-opens inline tags across chunk boundaries", () => {
  const inner = "x".repeat(200);
  const chunks = renderTelegramMarkdownChunks(`**${inner}**`, 100);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
  }
  assert.ok(chunks[0]!.endsWith("</b>"));
  assert.ok(chunks[1]!.startsWith("<b>"));
});

test("renderTelegramMarkdownChunks does not split inside an HTML entity", () => {
  const segment = "Use <code> for code. ";
  const text = segment.repeat(5);
  const chunks = renderTelegramMarkdownChunks(text, 100);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
  }
  assert.equal(chunks.join(""), text.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
});

test("renderTelegramMarkdownChunks splits fenced code blocks by lines", () => {
  const line = "a".repeat(60);
  const markdown = `\`\`\`\n${line}\n${line}\n${line}\n\`\`\``;
  const chunks = renderTelegramMarkdownChunks(markdown, 100);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
    assert.match(chunk, /^<pre>.*<\/pre>$/);
  }
});

test("renderTelegramMarkdownChunks handles nested emphasis and code", () => {
  const inner = "y".repeat(100);
  const chunks = renderTelegramMarkdownChunks(`***\`${inner}\`***`, 100);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0]!.endsWith("</code></b></i>"));
  assert.ok(chunks[1]!.startsWith("<i><b><code>"));
});

test("renderTelegramMarkdownChunks renders list items as plain bullets", () => {
  assert.deepEqual(renderTelegramMarkdownChunks("- first\n- **second**", 100), ["- first\n- <b>second</b>"]);
});

test("renderTelegramMarkdownChunks default maxLength stays under Telegram limit", () => {
  const text = "z".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 100);
  const chunks = renderTelegramMarkdownChunks(text);
  for (const chunk of chunks) {
    assert.ok(chunk.length < TELEGRAM_MAX_MESSAGE_LENGTH);
  }
});

test("renderTelegramMarkdownChunks never produces chunks longer than maxLength even with boundary newlines", () => {
  const prefix = "a".repeat(45);
  const text = `${prefix}\n${prefix}\n${prefix}`;
  const chunks = renderTelegramMarkdownChunks(text, 50);
  for (const chunk of chunks) {
    assert.ok(
      chunk.length <= 50,
      `chunk length ${chunk.length} exceeds maxLength 50`,
    );
  }
});

test("renderTelegramMarkdownChunks does not split surrogate pairs", () => {
  const text = "😀".repeat(3000);
  const chunks = renderTelegramMarkdownChunks(text, 100);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
  }
  for (const chunk of chunks) {
    const encoded = new TextEncoder().encode(chunk);
    const decoded = new TextDecoder().decode(encoded);
    assert.equal(decoded, chunk);
  }
});
