export type SandyConfig = {
  telegramBotToken: string;
  openAiApiKey: string;
  workerImage: string;
  shareRoot: string;
  wsListenHost: string;
  wsListenPort: number;
  wsPublicHost: string;
  wsPublicPort: number;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }
  return parsed;
}

export function loadConfig(): SandyConfig {
  return {
    telegramBotToken: getRequiredEnv("TELEGRAM_BOT_TOKEN"),
    openAiApiKey: getRequiredEnv("OPENAI_API_KEY"),
    workerImage: process.env.SANDY_WORKER_IMAGE ?? "sandy-subagent:latest",
    shareRoot: process.env.SANDY_SHARE_ROOT ?? "/tmp/sandy-shares",
    wsListenHost: process.env.SANDY_WS_LISTEN_HOST ?? "0.0.0.0",
    wsListenPort: getOptionalNumber("SANDY_WS_LISTEN_PORT", 8787),
    wsPublicHost: process.env.SANDY_WS_PUBLIC_HOST ?? "127.0.0.1",
    wsPublicPort: getOptionalNumber("SANDY_WS_PUBLIC_PORT", 8787),
  };
}
