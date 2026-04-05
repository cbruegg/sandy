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
  assert.equal(config.sttApiKey, null);
  assert.equal(config.sttBaseUrl, "https://api.openai.com/v1");
  assert.equal(config.sttModel, "gpt-4o-mini-transcribe");
});

test("loadConfig enables STT from dedicated environment variables", () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "telegram-token",
    SANDY_STT_API_KEY: "sk-stt",
    SANDY_STT_BASE_URL: "https://transcribe.example/v1/",
    SANDY_STT_MODEL: "custom-transcribe-model",
  });

  assert.equal(config.sttApiKey, "sk-stt");
  assert.equal(config.sttBaseUrl, "https://transcribe.example/v1/");
  assert.equal(config.sttModel, "custom-transcribe-model");
});
