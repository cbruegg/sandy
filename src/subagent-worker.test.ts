import test from "node:test";
import assert from "node:assert/strict";
import { buildInitialTaskInput } from "./subagent/worker.js";
import type { ChannelFormatting } from "./types.js";

test("buildInitialTaskInput tells the sub-agent where the shared workspace is", () => {
  const formatting: ChannelFormatting = {
    channel: "telegram",
    markup: "telegram_html",
    allowedTags: ["b", "i", "code", "pre"],
    instructions: "Use simple Telegram HTML.",
  };
  const input = buildInitialTaskInput("Inspect the repository and leave a summary file.", formatting);

  assert.match(input, /\/workspace\/share/);
  assert.match(input, /shared workspace is mounted/);
  assert.match(input, /Telegram HTML/);
  assert.match(input, /<code>/);
  assert.match(input, /leave a summary file\./);
});
