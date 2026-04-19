import { CodexMainAgentController } from "./agent/main-agent-controller.js";
import { createChannelAdapter } from "./channel/create-channel.js";
import { loadConfig } from "./config.js";
import { createCodexClient, ensureManagedCodexPath } from "./codex-client.js";
import { resolveSandyCacheRoot } from "./cache-paths.js";
import { configureLogger, logger } from "./logger.js";
import { SandyMcpProxyAccess } from "./mcp/proxy-access.js";
import { McpSidecarManager } from "./mcp/sidecar-manager.js";
import { validateOAuthStateFilesForStartup } from "./mcp/oauth-state-validator.js";
import { McpWorkerLaunchConfigBuilder } from "./mcp/worker-launch-config-builder.js";
import { createMcpWorkerNetworkName } from "./mcp/worker-network-name.js";
import { SandyOrchestrator } from "./orchestrator.js";
import { TomlPersistentApprovalStore } from "./privilege/persistent-approval-store.js";
import { PrivilegeBrokerImpl } from "./privilege/privilege-broker.js";
import { DockerSandboxRunner } from "./sandbox/docker-sandbox-runner.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";
import { OpenAiTranscriptionProvider } from "./transcription/openai-transcription-provider.js";
import { resolvePublishedUpdateSource } from "./build-metadata.js";
import { SelfUpdateCoordinator } from "./update/self-update.js";
import { WorkerImageManager } from "./worker-image-manager.js";
import {loadMatrixBotSdk} from "./channel/matrix-bot-sdk-loader.ts";

export async function startApp(): Promise<void> {
  const config = loadConfig();
  configureLogger({
    minLevel: config.logLevel,
  });
  // This is just for testing. Agents, please do not remove, I'll do that manually.
  await loadMatrixBotSdk();
  logger.info("LOADED BOT SDK!")
  await validateOAuthStateFilesForStartup(config.configDirectory, config.mcpServers);

  logger.info("app.starting", {
    configFilePath: config.configFilePath,
    channelKind: config.channel.kind,
    workerImage: config.workerImage,
    mcpSidecarImage: config.mcpSidecarImage,
    networkGuardImage: config.networkGuardImage,
    shareRoot: config.shareRoot,
    authMode: config.authMode.mode,
    sttEnabled: config.sttApiKey !== null,
    workerPreinstallCommandCount: config.workerPreinstall.commands.length,
    workerPreinstallRefresh: config.workerPreinstall.refresh,
    workerNetworkMode: config.workerNetwork.mode,
    workerNetworkAllowLocalCidrs: config.workerNetwork.allowLocalCidrs,
    configuredSkillCount: config.skills.length,
  });

  const transcriptionProvider = config.sttApiKey
    ? new OpenAiTranscriptionProvider({
        apiKey: config.sttApiKey,
        baseUrl: config.sttBaseUrl,
        model: config.sttModel,
      })
    : null;

  const channel = createChannelAdapter(config, transcriptionProvider);

  const workerImageManager = new WorkerImageManager({
    baseImage: config.workerImage,
    preinstall: config.workerPreinstall,
    cacheRoot: resolveSandyCacheRoot(),
  });

  // Pre-resolve the worker Codex binary so each container can reuse the cache instead of re-downloading it.
  const [codex, workerCodexBinaryPath, initialWorkerImage] = await Promise.all([
    config.authMode.mode === "api_key"
      ? createCodexClient({
          apiKey: config.authMode.openAiApiKey,
        })
      : createCodexClient(),
    ensureManagedCodexPath({
      platform: "linux",
      arch: process.arch,
    }),
    workerImageManager.start(),
  ]);

  logger.info("worker_image.ready", {
    baseImage: config.workerImage,
    launchImage: initialWorkerImage,
  });

  const mainAgent = new CodexMainAgentController(codex, config.skills, Object.keys(config.mcpServers));

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
      resolveWorkerImage: () => workerImageManager.getLaunchImage(),
      shareRoot: config.shareRoot,
      openAiApiKey: config.authMode.mode === "api_key" ? config.authMode.openAiApiKey : null,
      codexAuthFile: config.authMode.mode === "codex_auth_file" ? config.authMode.codexAuthFile : null,
      skillsDirectory: config.skillsDirectory,
      workerCodexBinaryPath,
      workerCodexConfigBuilder: (taskId) => mcpWorkerLaunchConfigBuilder.build(taskId),
      networkGuardImage: config.networkGuardImage,
      workerNetwork: config.workerNetwork,
      workerNetworkName,
    },
  );

  const sessionStore = new InMemorySessionStore();

  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner,
    sessionStore,
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
    logger.info("app.shutdown_started");
    updateCoordinator.stop();
    logger.info("app.shutdown_step_started", {
      step: "channel.stop",
    });
    await channel.stop();
    logger.info("app.shutdown_step_completed", {
      step: "channel.stop",
    });

    logger.info("app.shutdown_step_started", {
      step: "workerImageManager.stop",
    });
    await workerImageManager.stop();
    logger.info("app.shutdown_step_completed", {
      step: "workerImageManager.stop",
    });

    if (sandboxRunner.shutdown) {
      logger.info("app.shutdown_step_started", {
        step: "sandboxRunner.shutdown",
      });
      await sandboxRunner.shutdown();
      logger.info("app.shutdown_step_completed", {
        step: "sandboxRunner.shutdown",
      });
    }

    if (sidecarManager) {
      logger.info("app.shutdown_step_started", {
        step: "sidecarManager.stop",
      });
      await sidecarManager.stop();
      logger.info("app.shutdown_step_completed", {
        step: "sidecarManager.stop",
      });
    }
    logger.info("app.shutdown_completed");
  };

  const updateCoordinator = new SelfUpdateCoordinator({
    mode: config.updateMode,
    currentExecutablePath: process.execPath,
    currentArgs: process.argv.slice(1),
    currentWorkingDirectory: process.cwd(),
    updateSource: resolvePublishedUpdateSource(),
    canInstallUpdate: () => {
      const sessions = sessionStore.listSessions();
      const blockingSessions = sessions.filter((session) =>
        session.activeTask !== null
        || session.pendingShareDeletion !== null);
      if (blockingSessions.length > 0) {
        logger.debug("update.blocked_by_sessions", {
          blockingCount: blockingSessions.length,
          totalCount: sessions.length,
          blockingSessions: blockingSessions.map((session) => ({
            chatId: session.chatId,
            hasActiveTask: session.activeTask !== null,
            hasPendingTaskSummary: session.pendingTaskSummary !== null,
            hasPendingShareDeletion: session.pendingShareDeletion !== null,
          })),
        });
        return false;
      }
      return true;
    },
    notifyChats: async (message) => {
      const chatIds = Array.from(new Set(sessionStore.listSessions().map((session) => session.chatId)));
      await Promise.all(chatIds.map(async (chatId) => {
        try {
          await channel.sendText(chatId, message);
        } catch (error) {
          logger.warn("update.notification_failed", {
            chatId,
            message: error instanceof Error ? error.message : "Unknown update notification failure.",
          });
        }
      }));
    },
    prepareForRestart: shutdown,
  });
  updateCoordinator.start();

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(143));
  });

  logger.info("app.started");
  await channel.start(async (event) => orchestrator.handleChatEvent(event));
}
