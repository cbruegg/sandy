import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SandyConfig = {
  telegramBotToken: string;
  openAiApiKey: string | null;
  codexAuthFile: string | null;
  workerImage: string;
  shareRoot: string;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalEnv(name: string): string | null {
  const value = process.env[name];
  if (!value) {
    return null;
  }
  return value;
}

function resolveCodexAuthFile(): string | null {
  const configured = getOptionalEnv("SANDY_CODEX_AUTH_FILE");
  if (configured) {
    return configured;
  }

  const defaultPath = join(homedir(), ".codex", "auth.json");
  return existsSync(defaultPath) ? defaultPath : null;
}

export function loadConfig(): SandyConfig {
  return {
    telegramBotToken: getRequiredEnv("TELEGRAM_BOT_TOKEN"),
    openAiApiKey: getOptionalEnv("OPENAI_API_KEY"),
    codexAuthFile: resolveCodexAuthFile(),
    workerImage: process.env.SANDY_WORKER_IMAGE ?? "sandy-subagent:latest",
    shareRoot: process.env.SANDY_SHARE_ROOT ?? "/tmp/sandy-shares",
  };
}
