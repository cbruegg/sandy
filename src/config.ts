import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type SandyConfig = {
  telegramBotToken: string;
  openAiApiKey: string | null;
  codexAuthFile: string | null;
  workerImage: string;
  shareRoot: string;
  authMode: "api_key" | "codex_auth_file" | "ambient_codex_auth";
};

type EnvSource = NodeJS.ProcessEnv;

function getRequiredEnv(env: EnvSource, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalEnv(env: EnvSource, name: string): string | null {
  const value = env[name];
  if (!value) {
    return null;
  }
  return value;
}

function resolveCodexAuthFile(env: EnvSource): string | null {
  const configured = getOptionalEnv(env, "SANDY_CODEX_AUTH_FILE");
  if (configured) {
    return configured;
  }

  const defaultPath = join(homedir(), ".codex", "auth.json");
  return existsSync(defaultPath) ? defaultPath : null;
}

export function loadConfig(env: EnvSource = process.env): SandyConfig {
  const codexAuthFile = resolveCodexAuthFile(env);
  const rawApiKey = getOptionalEnv(env, "OPENAI_API_KEY");
  const openAiApiKey = codexAuthFile ? null : rawApiKey;
  const authMode = codexAuthFile ? "codex_auth_file" : rawApiKey ? "api_key" : "ambient_codex_auth";

  return {
    telegramBotToken: getRequiredEnv(env, "TELEGRAM_BOT_TOKEN"),
    openAiApiKey,
    codexAuthFile,
    workerImage: env.SANDY_WORKER_IMAGE ?? "sandy-subagent:latest",
    shareRoot: env.SANDY_SHARE_ROOT ?? "/tmp/sandy-shares",
    authMode,
  };
}
