import { Codex } from "@openai/codex-sdk";
import { CodexMainAgentController } from "./agent/main-agent-controller.js";
import { TelegramBotApiAdapter } from "./channel/telegram-adapter.js";
import { loadConfig } from "./config.js";
import { configureLogger, logger } from "./logger.js";
import { SandyMcpProxyAccess } from "./mcp/proxy-access.js";
import { McpProxyEndpointState } from "./mcp/proxy-endpoint-state.js";
import { SandyMcpProxy } from "./mcp/proxy.js";
import { McpServerRegistryImpl } from "./mcp/server-registry.js";
import { McpWorkerLaunchConfigBuilder } from "./mcp/worker-launch-config-builder.js";
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

  const mcpServerRegistry = new McpServerRegistryImpl(config.configDirectory, config.mcpServers);
  const mcpProxyAccess = new SandyMcpProxyAccess();
  const mcpProxyEndpointState = new McpProxyEndpointState();
  const mcpWorkerLaunchConfigBuilder = new McpWorkerLaunchConfigBuilder(
    config.mcpServers,
    mcpProxyAccess,
    mcpProxyEndpointState,
  );

  const sandboxRunner = new DockerSandboxRunner(
    {
      workerImage: config.workerImage,
      shareRoot: config.shareRoot,
      openAiApiKey: config.openAiApiKey,
      codexAuthFile: config.codexAuthFile,
      workerCodexConfigBuilder: async (taskId) => mcpWorkerLaunchConfigBuilder.build(taskId),
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

  const mcpProxy = new SandyMcpProxy({
    access: mcpProxyAccess,
    endpointState: mcpProxyEndpointState,
    registry: mcpServerRegistry,
    authorizeToolCall: orchestrator.authorizeMcpToolCall.bind(orchestrator),
  });
  await mcpProxy.start();

  await channel.start(async (event) => orchestrator.handleChatEvent(event));
  logger.info("app.started");
}
