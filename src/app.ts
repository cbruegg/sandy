import { Codex } from "@openai/codex-sdk";
import { CodexMainAgentController } from "./agent/main-agent-controller.js";
import { TelegramBotApiAdapter } from "./channel/telegram-adapter.js";
import { loadConfig } from "./config.js";
import { SandyOrchestrator } from "./orchestrator.js";
import { DockerSandboxRunner } from "./sandbox/docker-sandbox-runner.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";

export async function startApp(): Promise<void> {
  const config = loadConfig();

  const channel = new TelegramBotApiAdapter({
    token: config.telegramBotToken,
  });

  const mainAgent = new CodexMainAgentController(
    new Codex({
      apiKey: config.openAiApiKey,
    }),
  );

  const sandboxRunner = new DockerSandboxRunner(
    {
      workerImage: config.workerImage,
      shareRoot: config.shareRoot,
      openAiApiKey: config.openAiApiKey,
    },
  );

  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner,
    sessionStore: new InMemorySessionStore(),
  });

  await channel.start(async (event) => orchestrator.handleChatEvent(event));
}
