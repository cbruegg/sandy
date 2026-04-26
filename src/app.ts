import { CodexMainAgentController } from "./agent/main-agent-controller.js";
import { createChannelAdapter } from "./channel/create-channel.js";
import { loadConfig } from "./config.js";
import { createCodexClient, ensureManagedCodexPath } from "./codex-client.js";
import { resolveSandyCacheRoot } from "./cache-paths.js";
import { configureLogger, logger } from "./logger.js";
import { SandyMcpProxyAccess } from "./mcp/proxy-access.js";
import { McpSidecarManager } from "./mcp/sidecar-manager.js";
import { validateOAuthStateFilesForStartup } from "./mcp/oauth-state-validator.js";
import { createCertificateAuthority } from "./http/ca.js";
import { ProxyAuthService } from "./http/proxy-auth-service.js";
import { McpWorkerLaunchConfigBuilder } from "./mcp/worker-launch-config-builder.js";
import { createMcpWorkerNetworkName } from "./mcp/worker-network-name.js";
import { SandyOrchestrator } from "./orchestrator.js";
import { TomlPersistentApprovalStore } from "./privilege/persistent-approval-store.js";
import { PrivilegeBrokerImpl } from "./privilege/privilege-broker.js";
import { DockerSandboxRunner } from "./sandbox/docker-sandbox-runner.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";
import { OpenAiTranscriptionProvider } from "./transcription/openai-transcription-provider.js";
import { resolvePublishedUpdateSource } from "./build-metadata.js";
import { createRetryingChannelAdapter } from "./channel/retrying-channel-adapter.js";
import { SelfUpdateCoordinator } from "./update/self-update.js";
import { WorkerImageManager } from "./worker-image-manager.js";
import { validateMatrixAuthStateForStartup, resolveMatrixAccessToken } from "./matrix/startup-validator.js";

export async function startApp(): Promise<void> {
  const config = loadConfig();
  configureLogger({
    minLevel: config.logLevel,
  });
  await validateOAuthStateFilesForStartup(config.configDirectory, config.mcpServers);
  await validateMatrixAuthStateForStartup(config.configDirectory, config.channel);

  logger.info("app.starting", {
    configFilePath: config.configFilePath,
    channelKind: config.channel.kind,
    workerImage: config.workerImage,
    mcpSidecarImage: config.mcpSidecarImage,
    httpProxyImage: config.httpProxyImage,
    networkGuardImage: config.networkGuardImage,
    shareRoot: config.shareRoot,
    agentModel: config.agentModel,
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

  const matrixAccessToken = config.channel.kind === "matrix"
    ? await resolveMatrixAccessToken(config.configDirectory, config.channel)
    : null;
  const rawChannel = createChannelAdapter(config, transcriptionProvider, matrixAccessToken);

  let rejectFatalError: ((error: Error) => void) | null = null;
  const fatalErrorPromise = new Promise<never>((_, reject) => {
    rejectFatalError = (error: Error) => reject(error);
  });

  let shutdownRequested = false;
  let shutdown: (() => Promise<void>) | null = null;
  const triggerFatalChannelError = (error: unknown, source: string): void => {
    if (shutdownRequested) {
      return;
    }
    shutdownRequested = true;
    const wrappedError = error instanceof Error ? error : new Error(`Fatal channel error from ${source}.`);
    logger.error("app.fatal_channel_error", {
      source,
      message: wrappedError.message,
    });
    void shutdown?.().finally(() => rejectFatalError?.(wrappedError));
  };

  const channel = createRetryingChannelAdapter(rawChannel, triggerFatalChannelError);

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

  const mainAgent = new CodexMainAgentController(
    codex,
    config.agentModel,
    config.skills,
    Object.keys(config.mcpServers),
  );

  const workerAccess = new SandyMcpProxyAccess();
  const mcpEnabled = Object.keys(config.mcpServers).length > 0;
  const httpTokensEnabled = Object.keys(config.httpTokens).length > 0;
  const workerNetworkName = mcpEnabled ? createMcpWorkerNetworkName() : null;

  const certificateAuthority = httpTokensEnabled ? await createCertificateAuthority() : null;

  // The mitmproxy-based HTTP proxy container asks the host orchestrator for per-request
  // token approvals and header resolution over this Unix socket.
  const httpProxyAuthSocketPath = httpTokensEnabled
    ? "/tmp/sandy-http-proxy-auth.sock"
    : null;
  const proxyAuthService = httpTokensEnabled && httpProxyAuthSocketPath
    ? new ProxyAuthService({
        socketPath: httpProxyAuthSocketPath,
        access: workerAccess,
        httpTokens: config.httpTokens,
        authorizeHttpTokenUse: async (input) => orchestrator.authorizeHttpTokenUse(input),
      })
    : null;

  const mcpWorkerLaunchConfigBuilder = new McpWorkerLaunchConfigBuilder(
    config.mcpServers,
    workerAccess,
    mcpEnabled,
  );

  const sandboxRunner = new DockerSandboxRunner(
    {
      workerImage: config.workerImage,
      resolveWorkerImage: () => workerImageManager.getLaunchImage(),
      shareRoot: config.shareRoot,
      codexModel: config.agentModel,
      openAiApiKey: config.authMode.mode === "api_key" ? config.authMode.openAiApiKey : null,
      codexAuthFile: config.authMode.mode === "codex_auth_file" ? config.authMode.codexAuthFile : null,
      skillsDirectory: config.skillsDirectory,
      workerCodexBinaryPath,
      workerCodexConfigBuilder: (taskId) => mcpWorkerLaunchConfigBuilder.build(taskId),
      httpProxyUrlFactory: httpTokensEnabled
        ? (taskId) => {
            const jwt = workerAccess.issueWorkerGrant(taskId).bearerToken;
            const encodedJwt = encodeURIComponent(jwt);
            return `http://Bearer:${encodedJwt}@sandy-http-proxy:8081`;
          }
        : undefined,
      networkGuardImage: config.networkGuardImage,
      workerNetwork: config.workerNetwork,
      workerNetworkName,
      httpProxyCaCertPath: certificateAuthority?.certPath ?? null,
      httpProxyConfDirPath: certificateAuthority?.confDirPath ?? null,
      httpProxyImage: httpTokensEnabled ? config.httpProxyImage : null,
      httpProxyAuthSocketPath,
    },
  );

  const sessionStore = new InMemorySessionStore();

  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner,
    sessionStore,
    privilegeBroker: new PrivilegeBrokerImpl(),
    persistentApprovalStore: new TomlPersistentApprovalStore(config.configFilePath, config.persistentMcpApprovals, config.persistentHttpApprovals),
  });

  await proxyAuthService?.start();

  const sidecarManager = !mcpEnabled || !workerNetworkName ? null : new McpSidecarManager({
    configDirectory: config.configDirectory,
    mcpServers: config.mcpServers,
    workerNetworkName,
    sidecarImage: config.mcpSidecarImage,
    authorizeToolCall: (input) => orchestrator.authorizeMcpToolCall(input),
  }, workerAccess);

  await sidecarManager?.start();

  const stopWithLogging = async (step: string, fn: (() => Promise<void>) | null | undefined): Promise<void> => {
    if (!fn) {
      return;
    }
    logger.info("app.shutdown_step_started", { step });
    await fn();
    logger.info("app.shutdown_step_completed", { step });
  };

  shutdown = async () => {
    logger.info("app.shutdown_started");
    updateCoordinator.stop();
    await stopWithLogging("channel.stop", () => channel.stop());
    await stopWithLogging("workerImageManager.stop", () => workerImageManager.stop());
    await stopWithLogging("sandboxRunner.shutdown", sandboxRunner.shutdown?.bind(sandboxRunner));
    await stopWithLogging("sidecarManager.stop", sidecarManager?.stop.bind(sidecarManager));
    await stopWithLogging("proxyAuthService.stop", proxyAuthService?.stop.bind(proxyAuthService));
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
    shutdownRequested = true;
    void shutdown().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    shutdownRequested = true;
    void shutdown().finally(() => process.exit(143));
  });

  await channel.start(async (event) => {
    await orchestrator.handleChatEvent(event);
  });
  logger.info("app.started");
  await fatalErrorPromise;
}
