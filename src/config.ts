export type SandyConfig = {
  telegramBotToken: string;
  openAiApiKey: string;
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

export function loadConfig(): SandyConfig {
  return {
    telegramBotToken: getRequiredEnv("TELEGRAM_BOT_TOKEN"),
    openAiApiKey: getRequiredEnv("OPENAI_API_KEY"),
    workerImage: process.env.SANDY_WORKER_IMAGE ?? "sandy-subagent:latest",
    shareRoot: process.env.SANDY_SHARE_ROOT ?? "/tmp/sandy-shares",
  };
}
