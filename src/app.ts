import { Codex } from "@openai/codex-sdk";
import { CodexMainAgentController } from "./agent/main-agent-controller.js";
import { TelegramBotApiAdapter } from "./channel/telegram-adapter.js";
import { loadConfig } from "./config.js";
import { configureLogger, logger } from "./logger.js";
import { SandyMcpProxyAccess } from "./mcp/proxy-access.js";
import { McpSidecarManager } from "./mcp/sidecar-manager.js";
import { McpWorkerLaunchConfigBuilder } from "./mcp/worker-launch-config-builder.js";
import { createMcpWorkerNetworkName } from "./mcp/worker-network-name.js";
import { SandyOrchestrator } from "./orchestrator.js";
import { TomlPersistentApprovalStore } from "./privilege/persistent-approval-store.js";
import { PrivilegeBrokerImpl } from "./privilege/privilege-broker.js";
import { DockerSandboxRunner } from "./sandbox/docker-sandbox-runner.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";
import { OpenAiTranscriptionProvider } from "./transcription/openai-transcription-provider.js";

export async function startApp(): Promise<void> {
  const config = loadConfig();
  configureLogger({
    minLevel: config.logLevel,
  });

  logger.info("app.starting", {
    configFilePath: config.configFilePath,
    workerImage: config.workerImage,
    mcpSidecarImage: config.mcpSidecarImage,
    shareRoot: config.shareRoot,
    authMode: config.authMode.mode,
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

  const codex = config.authMode.mode === "api_key"
    ? new Codex({
        apiKey: config.authMode.openAiApiKey,
      })
    : new Codex();

  const mainAgent = new CodexMainAgentController(codex);

  const mcpProxyAccess = new SandyMcpProxyAccess();
  const mcpEnabled = Object.keys(config.mcpServers).length > 0;
  const workerNetworkName = mcpEnabled ? createMcpWorkerNetworkName() : null;

  const mcpWorkerLaunchConfigBuilder = new McpWorkerLaunchConfigBuilder(
    config.mcpServers,
    mcpProxyAccess,
    mcpEnabled,
  );

  const sandboxRunner = new DockerSandboxRunner(
    {
      workerImage: config.workerImage,
      shareRoot: config.shareRoot,
      openAiApiKey: config.authMode.mode === "api_key" ? config.authMode.openAiApiKey : null,
      codexAuthFile: config.authMode.mode === "codex_auth_file" ? config.authMode.codexAuthFile : null,
      workerCodexConfigBuilder: (taskId) => mcpWorkerLaunchConfigBuilder.build(taskId),
      workerNetworkName,
    },
  );

  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner,
    sessionStore: new InMemorySessionStore(),
    privilegeBroker: new PrivilegeBrokerImpl(),
    persistentApprovalStore: new TomlPersistentApprovalStore(config.configFilePath, config.persistentMcpApprovals),
  });

  const sidecarManager = !mcpEnabled || !workerNetworkName ? null : new McpSidecarManager({
    configDirectory: config.configDirectory,
    mcpServers: config.mcpServers,
    workerNetworkName,
    sidecarImage: config.mcpSidecarImage,
    authorizeToolCall: (input) => orchestrator.authorizeMcpToolCall(input),
  }, mcpProxyAccess);

  await sidecarManager?.start();

  const shutdown = async () => {
    await sandboxRunner.shutdown?.();
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
