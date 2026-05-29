import { CodexMainAgentController } from "./agent/main-agent-controller.js";
import { createChannelAdapter } from "./channel/create-channel.js";
import type { WorkerAuthConfig } from "./types.js";
import { defaultCodexAuthFilePath, loadConfig } from "./config.js";
import { CODEX_API_KEY_ENV, ensureManagedCodexPath } from "./codex-client.js";
import { resolveSandyCacheRoot } from "./cache-paths.js";
import { configureLogger, logger } from "./logger.js";
import { ProxyAccess } from "./proxy-access.js";
import { McpSidecarManager } from "./mcp/sidecar-manager.js";
import { validateOAuthStateFilesForStartup } from "./mcp/oauth-state-validator.js";
import { createCertificateAuthority } from "./http/ca.js";
import { HttpTokenAuthorizer } from "./http/token-authorizer.js";
import { ProxyAuthService } from "./http/proxy-auth-service.js";
import { McpWorkerLaunchConfigBuilder } from "./mcp/worker-launch-config-builder.js";
import { createMcpWorkerNetworkName } from "./mcp/worker-network-name.js";
import { HostMcpServerRegistry } from "./mcp/host-server-registry.js";
import { SandyOrchestrator } from "./orchestrator/index.js";
import { TomlPersistentApprovalStore } from "./privilege/persistent-approval-store.js";
import { PrivilegeBrokerImpl } from "./privilege/privilege-broker.js";
import {DockerSandboxRunner, type DockerSandboxRunnerOptions} from "./sandbox/docker-sandbox-runner.js";
import {TaskBundleLauncherImpl, type TaskBundleLauncherOptions} from "./sandbox/task-bundle-launcher.js";
import { TaskBundlePoolImpl } from "./sandbox/task-bundle-pool.js";
import { TaskBundleAssignmentRegistry } from "./sandbox/task-bundle-assignment-registry.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";
import { OpenAiTranscriptionProvider } from "./transcription/openai-transcription-provider.js";
import { resolvePublishedUpdateSource } from "./build-metadata.js";
import { createRetryingChannelAdapter } from "./channel/retrying-channel-adapter.js";
import { SelfUpdateCoordinator } from "./update/self-update.js";
import { WorkerImageManager } from "./worker-image-manager.js";
import { validateMatrixAuthStateForStartup, resolveMatrixAccessToken } from "./matrix/startup-validator.js";
import {createNoopHostfsBroker} from "./hostfs/hostfs-broker.js";
import {initializeHostfs, type HostfsServices} from "./hostfs/index.js";
import { ChatGPTTokenBroker } from "./auth/chatgpt-token-broker.js";
import { SkillService } from "./skills.js";
import { randomUUID } from "node:crypto";
import { createControlDir, removeControlDir, startHeartbeat } from "./sandbox/heartbeat.js";
import { CodexAppServerClient } from "./codex-app-server-client/app-server-client.js";
import { buildMainAgentMcpConfig } from "./mempalace-availability.js";

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
    codexAuthStrategy: config.authMode.mode === "codex_auth_file" ? config.authMode.codexAuthStrategy : null,
    sttEnabled: config.sttApiKey !== null,
    workerPreinstallCommandCount: config.workerPreinstall.commands.length,
    workerPreinstallRefresh: config.workerPreinstall.refresh,
    workerNetworkMode: config.workerNetwork.mode,
    workerNetworkAllowLocalCidrs: config.workerNetwork.allowLocalCidrs,
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
    logger.error("app.fatal_channel_error", wrappedError, `Fatal channel error from ${source}.`, {
      source,
    });
    void shutdown?.().finally(() => rejectFatalError?.(wrappedError));
  };

  const channel = createRetryingChannelAdapter(rawChannel, triggerFatalChannelError);
  const sandyCacheRoot = resolveSandyCacheRoot();

  const workerImageManager = new WorkerImageManager({
    baseImage: config.workerImage,
    preinstall: config.workerPreinstall,
    cacheRoot: sandyCacheRoot,
  });

  // Pre-resolve the worker Codex binary so each container can reuse the cache
  // instead of re-downloading it.  Also resolve the host-platform Codex binary
  // for the main agent's app-server process.
  const [mainAgentCodexPath, workerCodexBinaryPath, initialWorkerImage] = await Promise.all([
    ensureManagedCodexPath(),
    ensureManagedCodexPath({
      platform: "linux",
      arch: process.arch,
    }),
    workerImageManager.start(),
  ]);
  const mainAgentAppServer = await CodexAppServerClient.createWithAmbientAuth({
    codexPath: mainAgentCodexPath,
    env: config.authMode.mode === "api_key"
      ? { [CODEX_API_KEY_ENV]: config.authMode.openAiApiKey }
      : undefined,
  });

  const tokenBroker: ChatGPTTokenBroker | null = config.authMode.mode === "codex_auth_file"
    && config.authMode.codexAuthStrategy === "external_tokens"
    ? new ChatGPTTokenBroker(defaultCodexAuthFilePath())
    : null;

  logger.info("worker_image.ready", {
    baseImage: config.workerImage,
    launchImage: initialWorkerImage,
  });

  const hostMcpRegistry = new HostMcpServerRegistry(config.mcpServers);
  await hostMcpRegistry.start();

  const controllerControlDir = await createControlDir(sandyCacheRoot, `controller-${randomUUID()}`);
  const controllerHeartbeat = startHeartbeat(controllerControlDir);
  const stopControllerHeartbeat = async (): Promise<void> => {
    controllerHeartbeat.stop();
    await removeControlDir(controllerControlDir);
  };

  const skillService = new SkillService(config.configDirectory);

  const mempalaceMcpConfig = buildMainAgentMcpConfig();
  if (mempalaceMcpConfig) {
    logger.info("mempalace.available", {
      backend: "mempalace",
    });
  } else {
    logger.info("mempalace.unavailable");
  }

  const mainAgent = new CodexMainAgentController(
    mainAgentAppServer,
    config.agentModel,
    () => skillService.getSkills(),
    Object.keys(config.mcpServers),
    config.httpTokens,
    mempalaceMcpConfig,
  );

  const workerAccess = new ProxyAccess();
  const httpTokensEnabled = Object.keys(config.httpTokens).length > 0;
  const workerNetworkName = createMcpWorkerNetworkName();

  const certificateAuthority = httpTokensEnabled ? await createCertificateAuthority() : null;
  const sessionStore = new InMemorySessionStore();
  const persistentApprovalStore = new TomlPersistentApprovalStore(
    config.configFilePath,
    config.persistentMcpApprovals,
    config.persistentHttpApprovals,
    config.persistentMcpResourceApprovals,
    config.persistentHostDirectoryApprovals,
  );

  // Docker Desktop (macOS, Windows) runs containers inside a VM. The VM cannot
  // reach the host via 127.0.0.1, so we must bind the WebDAV server to 0.0.0.0
  // and tell the rclone volume plugin to connect via host.docker.internal.
  // On Linux, Docker Engine runs natively and the managed plugin shares the
  // host network namespace, so 127.0.0.1 is sufficient and more restrictive.
  const isDockerDesktop = process.platform === "darwin" || process.platform === "win32";
  const webdavDockerHost = isDockerDesktop
    ? "host.docker.internal"
    : "127.0.0.1";
  let hostfsServices: HostfsServices | null = null;
  try {
    hostfsServices = await initializeHostfs({
      // Bind to all interfaces only on Docker Desktop (macOS/Windows), where the
      // Docker VM cannot reach the host via 127.0.0.1. On Linux the rclone plugin
      // runs in the host network namespace, so localhost is sufficient.
      webdavHost: isDockerDesktop ? "0.0.0.0" : "127.0.0.1",
      // The URL the rclone volume plugin uses; on macOS/Windows it must use
      // host.docker.internal because the plugin runs inside the Docker Desktop VM.
      webdavDockerHost,
    });
  } catch (error) {
    logger.warn("hostfs.startup_disabled", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const httpTokenAuthorizer = new HttpTokenAuthorizer(
    sessionStore,
    persistentApprovalStore,
  );

  // The mitmproxy-based HTTP proxy container asks the host orchestrator for per-request
  // token approvals and header resolution over the proxy container stdio bridge.
  const proxyAuthService = httpTokensEnabled
    ? new ProxyAuthService({
        access: workerAccess,
        httpTokens: config.httpTokens,
        authorizeHttpTokenUse: async (input) => await httpTokenAuthorizer.authorizeHttpTokenUse(input),
      })
    : null;

  const mcpWorkerLaunchConfigBuilder = new McpWorkerLaunchConfigBuilder(
    config.mcpServers,
    workerAccess,
  );

  const createHostfsVolume = hostfsServices ? async (bundleId: string): Promise<string | null> => {
    const services = hostfsServices;
    const credentials = services.bundleRegistry.createBundle(bundleId);
    services.broker.registerBundle(bundleId);
    try {
      return await services.volumeManager.createVolume(bundleId, credentials.secret);
    } catch (error) {
      if (!services.rclonePluginManager.isRecoveryEnabled() || !services.rclonePluginManager.isRecoverablePluginError(error)) {
        throw error;
      }

      logger.warn("hostfs.volume_creation_retrying_after_plugin_recovery", {
        bundleId,
        error: error instanceof Error ? error.message : String(error),
      });
      await services.rclonePluginManager.recover();
      return await services.volumeManager.createVolume(bundleId, credentials.secret);
    }
  } : undefined;

  const removeHostfsVolume = hostfsServices ? async (bundleId: string): Promise<void> => {
    const services = hostfsServices;
    services.broker.revokeBundle(bundleId);
    services.bundleRegistry.revokeBundle(bundleId);
    await services.volumeManager.removeVolume(bundleId);
  } : undefined;

  const taskBundleLauncherOptions: TaskBundleLauncherOptions = {
    workerImage: config.workerImage,
    resolveWorkerImage: () => workerImageManager.getLaunchImage(),
    shareRoot: config.shareRoot,
    controllerControlDir,
    codexAuthFile: config.authMode.mode === "codex_auth_file"
      && config.authMode.codexAuthStrategy === "copy_file"
      ? defaultCodexAuthFilePath()
      : null,
    getSkillsDirectory: () => skillService.getSkillsDirectory(),
    workerCodexBinaryPath,
    networkGuardImage: config.networkGuardImage,
    workerNetwork: config.workerNetwork,
    workerNetworkName,
    httpProxyCaCertPath: certificateAuthority?.certPath ?? null,
    httpProxyConfDirPath: certificateAuthority?.confDirPath ?? null,
    httpProxyImage: httpTokensEnabled ? config.httpProxyImage : null,
    resolveHttpProxyRequest: proxyAuthService
        ? async (request) => await proxyAuthService.resolveProxyRequest(request)
        : undefined,
    logLevel: config.logLevel,
    createHostfsVolume,
    removeHostfsVolume,
  };
  const sandboxRunnerOptions: DockerSandboxRunnerOptions = {
    workerImage: config.workerImage,
    resolveWorkerImage: () => workerImageManager.getLaunchImage(),
    workerNetwork: config.workerNetwork,
    workerCodexConfigBuilder: (taskId: string) => mcpWorkerLaunchConfigBuilder.build(taskId),
    httpProxyUrlFactory: httpTokensEnabled
        ? (taskId: string) => {
          const jwt = workerAccess.issueWorkerGrant(taskId).bearerToken;
          const encodedJwt = encodeURIComponent(jwt);
          // The worker container shares the network namespace with the proxy
          // sidecar, so the proxy is reachable on localhost from the worker.
          return `http://Bearer:${encodedJwt}@127.0.0.1:8081`;
        }
        : undefined,
  };

  const taskBundleLauncher = new TaskBundleLauncherImpl(taskBundleLauncherOptions);
  const taskBundleAssignmentRegistry = new TaskBundleAssignmentRegistry();
  const taskBundlePool = new TaskBundlePoolImpl(
    taskBundleLauncher,
    (bundle) => {
      taskBundleAssignmentRegistry.activate(
        bundle.taskId,
        bundle.bundleId,
        bundle.hostfsVolumeName !== null,
      );
    },
    (bundle) => {
      taskBundleAssignmentRegistry.release(bundle.taskId);
    },
  );
  const sandboxRunner = new DockerSandboxRunner(sandboxRunnerOptions, taskBundlePool);

  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner,
    buildWorkerStartConfig: async () => {
      let auth: WorkerAuthConfig;

      if (config.authMode.mode === "api_key") {
        auth = { mode: "ambient_api_key", openAiApiKey: config.authMode.openAiApiKey };
      } else if (tokenBroker) {
        try {
          auth = {
            mode: "external_tokens",
            tokens: await tokenBroker.getInitialTokens(),
          };
        } catch (error) {
          logger.error("token_broker.worker_launch_tokens_failed", error, "Unknown error");
          auth = { mode: "ambient_auth_file" };
        }
      } else {
        auth = { mode: "ambient_auth_file" };
      }

      return {
        auth,
        codexModel: config.agentModel,
        channelFormatting: channel.getFormatting(),
        httpTokens: Object.entries(config.httpTokens).map(([tokenId, token]) => ({
          tokenId,
          description: token.description,
        })),
        httpProxyWrapper: httpTokensEnabled ? "/usr/local/bin/sandy-http-proxy-exec" : null,
      };
    },
    refreshChatGPTTokens: async (_taskId: string, previousAccountId: string | null) => {
      if (!tokenBroker) return null;
      try {
        return await tokenBroker.refreshTokens(previousAccountId);
      } catch (error) {
        logger.error("token_broker.refresh_failed", error, "Unknown error");
        return null;
      }
    },
    sessionStore,
    privilegeBroker: new PrivilegeBrokerImpl(),
    persistentApprovalStore,
    hostfsBroker: hostfsServices?.broker ?? createNoopHostfsBroker(),
    taskBundleAssignmentRegistry,
    skillService,
  });

  const sidecarManager = new McpSidecarManager({
    configDirectory: config.configDirectory,
    mcpServers: config.mcpServers,
    workerNetworkName,
    sidecarImage: config.mcpSidecarImage,
    controllerControlDir,
    authorizeToolCall: orchestrator.authorizeMcpToolCall.bind(orchestrator),
    authorizeResourceRead: orchestrator.authorizeMcpResourceRead.bind(orchestrator),
    executeNativeToolCall: orchestrator.executeNativeWorkerToolCall.bind(orchestrator),
    executeUpstreamMcpRequest: async (input) => await hostMcpRegistry.execute(input.taskId, input.serverId, input.method, input.params),
  }, workerAccess);

  await sidecarManager.start();

  sandboxRunner.start();

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
    await stopWithLogging("sidecarManager.stop", sidecarManager?.stop.bind(sidecarManager));
    await stopWithLogging("hostMcpRegistry.close", () => hostMcpRegistry.close());
    await stopWithLogging("sandboxRunner.shutdown", sandboxRunner.shutdown?.bind(sandboxRunner));
    await stopWithLogging("mainAgentAppServer.close", () => Promise.resolve(mainAgentAppServer.close()));
    await stopWithLogging("controllerHeartbeat.stop", stopControllerHeartbeat);
    await stopWithLogging("workerImageManager.stop", () => workerImageManager.stop());
    if (hostfsServices) {
      await stopWithLogging("hostfs.webdav.stop", () => hostfsServices.webdavServer.stop());
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
