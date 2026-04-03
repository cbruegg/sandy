import { Codex } from "@openai/codex-sdk";
import { CodexMainAgentController } from "./agent/main-agent-controller.js";
import { TelegramBotApiAdapter } from "./channel/telegram-adapter.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { SandyOrchestrator } from "./orchestrator.js";
import { PrivilegeBrokerImpl } from "./privilege/privilege-broker.js";
import { DockerSandboxRunner } from "./sandbox/docker-sandbox-runner.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";

export async function startApp(): Promise<void> {
  const config = loadConfig();

  logger.info("app.starting", {
    workerImage: config.workerImage,
    shareRoot: config.shareRoot,
    authMode: config.authMode,
  });

  const channel = new TelegramBotApiAdapter({
    token: config.telegramBotToken,
  });

  const codex = config.openAiApiKey
    ? new Codex({
        apiKey: config.openAiApiKey,
      })
    : new Codex();

  const mainAgent = new CodexMainAgentController(codex);

  const sandboxRunner = new DockerSandboxRunner(
    {
      workerImage: config.workerImage,
      shareRoot: config.shareRoot,
      openAiApiKey: config.openAiApiKey,
      codexAuthFile: config.codexAuthFile,
    },
  );

  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner,
    sessionStore: new InMemorySessionStore(),
    privilegeBroker: new PrivilegeBrokerImpl(),
  });

  await channel.start(async (event) => orchestrator.handleChatEvent(event));
  logger.info("app.started");
}
