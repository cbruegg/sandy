import { Codex } from "@openai/codex-sdk";
import { CodexMainAgentController } from "./agent/main-agent-controller.js";
import { TelegramBotApiAdapter } from "./channel/telegram-adapter.js";
import { loadConfig } from "./config.js";
import { configureLogger, logger } from "./logger.js";
import { SandyMcpProxyAccess } from "./mcp/proxy-access.js";
import { McpSidecarManager } from "./mcp/sidecar-manager.js";
import { McpWorkerLaunchConfigBuilder } from "./mcp/worker-launch-config-builder.js";
import { SandyOrchestrator } from "./orchestrator.js";
import { TomlPersistentApprovalStore } from "./privilege/persistent-approval-store.js";
import { PrivilegeBrokerImpl } from "./privilege/privilege-broker.js";
import { DockerSandboxRunner } from "./sandbox/docker-sandbox-runner.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";
import { OpenAiTranscriptionProvider } from "./transcription/openai-transcription-provider.js";

const mcpSidecarImage = "sandy-mcp-proxy:latest";

export async function startApp(): Promise<void> {
  const config = loadConfig();
  configureLogger({
    minLevel: config.logLevel,
    debugContentEnabled: config.debugLoggingEnabled,
  });

  logger.info("app.starting", {
    configFilePath: config.configFilePath,
    workerImage: config.workerImage,
    shareRoot: config.shareRoot,
    authMode: config.authMode,
    sttEnabled: config.sttApiKey !== null,
  });

  const transcriptionProvider = config.sttApiKey
    ? new OpenAiTranscriptionProvider({
        apiKey: config.sttApiKey,
        baseUrl: config.sttBaseUrl,
        model: config.sttModel,
      })
    : null;

  const channel = new TelegramBotApiAdapter({
    token: config.telegramBotToken,
    transcriptionProvider: transcriptionProvider ?? undefined,
  });

  const codex = config.openAiApiKey
    ? new Codex({
        apiKey: config.openAiApiKey,
      })
    : new Codex();

  const mainAgent = new CodexMainAgentController(codex);

  const mcpProxyAccess = new SandyMcpProxyAccess();
  let orchestrator: SandyOrchestrator | null = null;
  let sidecarManager: McpSidecarManager | null = null;

  if (Object.keys(config.mcpServers).length > 0) {
    sidecarManager = new McpSidecarManager({
      configDirectory: config.configDirectory,
      mcpServers: config.mcpServers,
      sidecarImage: mcpSidecarImage,
      authorizeToolCall: async (input) => {
        if (!orchestrator) {
          throw new Error("MCP authorization requested before orchestrator startup completed.");
        }
        return await orchestrator.authorizeMcpToolCall(input);
      },
    }, mcpProxyAccess);
    await sidecarManager.start();
  }

  const mcpWorkerLaunchConfigBuilder = new McpWorkerLaunchConfigBuilder(
    config.mcpServers,
    mcpProxyAccess,
    sidecarManager !== null,
  );

  const sandboxRunner = new DockerSandboxRunner(
    {
      workerImage: config.workerImage,
      shareRoot: config.shareRoot,
      openAiApiKey: config.openAiApiKey,
      codexAuthFile: config.codexAuthFile,
      workerCodexConfigBuilder: (taskId) => mcpWorkerLaunchConfigBuilder.build(taskId),
      workerNetworkName: sidecarManager?.workerNetworkName ?? null,
    },
  );

  orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner,
    sessionStore: new InMemorySessionStore(),
    privilegeBroker: new PrivilegeBrokerImpl(),
    persistentApprovalStore: new TomlPersistentApprovalStore(config.configFilePath, config.persistentMcpApprovals),
  });

  const shutdown = async () => {
    await sidecarManager?.stop();
  };
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(143));
  });

  logger.info("app.started");
  await channel.start(async (event) => orchestrator.handleChatEvent(event));
}
