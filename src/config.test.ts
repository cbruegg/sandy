import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

test("loadConfig prefers Codex auth file over OPENAI_API_KEY when both are configured", () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "telegram-token",
    OPENAI_API_KEY: "sk-test",
    SANDY_CODEX_AUTH_FILE: "/tmp/codex-auth.json",
  });

  assert.equal(config.telegramBotToken, "telegram-token");
  assert.equal(config.codexAuthFile, "/tmp/codex-auth.json");
  assert.equal(config.openAiApiKey, null);
  assert.equal(config.authMode, "codex_auth_file");
});
