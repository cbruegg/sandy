import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { OpenAiTranscriptionProvider } from "./transcription/openai-transcription-provider.js";
import { resolveMatrixAccessToken } from "./matrix/startup-validator.js";
import { isMemPalaceAvailable } from "./mempalace-availability.js";
import { buildMempalaceMcpServerConfig } from "./mempalace-availability.js";
import type { ThreadStartParams } from "./codex-app-server-client/generated/v2";

import { createFoundationLayer } from "./di/foundation.js";
import { createChannelLayer } from "./di/channel.js";
import { createCoreStoresLayer } from "./di/core-stores.js";
import { createMainAgentLayer } from "./di/main-agent.js";
import { createHttpProxyLayer } from "./di/http-proxy.js";
import { createHostfsLayer } from "./di/hostfs.js";
import { createMcpInfrastructureLayer } from "./di/mcp-infrastructure.js";
import { createSandboxLayer } from "./di/sandbox.js";
import { createOrchestratorLayer } from "./di/orchestrator.js";
import { createMcpSidecarLayer } from "./di/mcp-sidecar.js";
import { createSelfUpdateLayer } from "./di/self-update.js";

export async function startApp(): Promise<void> {
  // ── 1. Foundation ─────────────────────────────────────────────────────
  const config = loadConfig();
  const foundation = await createFoundationLayer({ config });

  // ── 2. Channel ────────────────────────────────────────────────────────
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

  const channelLayer = createChannelLayer({
    config,
    transcriptionProvider,
    matrixAccessToken,
  });

  // ── 3. Core stores ────────────────────────────────────────────────────
  const coreStores = createCoreStoresLayer({ config });

  // ── 4. Main agent ──────────────────────────────────────────────────────
  const mempalaceAvailable = config.memory.enabled && isMemPalaceAvailable();
  logger.info("memory.init", {
    backend: mempalaceAvailable ? "mempalace" : "none",
  });

  const mainAgentLayer = createMainAgentLayer({
    config,
    mainAgentAppServer: foundation.mainAgentAppServer,
    skillService: coreStores.skillService,
    hostMcpServerKeys: Object.keys(config.mcpServers),
    mempalaceAvailable,
  });

  // ── 5. HTTP proxy ──────────────────────────────────────────────────────
  const httpProxy = await createHttpProxyLayer({
    config,
    sessionStore: coreStores.sessionStore,
    persistentApprovalStore: coreStores.persistentApprovalStore,
  });

  // ── 6. Hostfs ─────────────────────────────────────────────────────────
  const hostfs = await createHostfsLayer();

  // ── 7. MCP infrastructure (before sandbox/orchestrator) ───────────────
  const mcpInfra = await createMcpInfrastructureLayer({
    config,
    proxyAccess: httpProxy.proxyAccess,
  });

  // ── 8. Sandbox ────────────────────────────────────────────────────────
  const sandbox = createSandboxLayer({
    config,
    workerImageManager: foundation.workerImageManager,
    controllerControlDir: foundation.controllerControlDir,
    workerCodexBinaryPath: foundation.workerCodexBinaryPath,
    skillService: coreStores.skillService,
    certificateAuthority: httpProxy.certificateAuthority,
    proxyAuthService: httpProxy.proxyAuthService,
    proxyAccess: httpProxy.proxyAccess,
    createHostfsVolume: hostfs.createHostfsVolume,
    removeHostfsVolume: hostfs.removeHostfsVolume,
    mcpWorkerLaunchConfigBuilder: mcpInfra.mcpWorkerLaunchConfigBuilder,
    workerNetworkName: mcpInfra.workerNetworkName,
  });

  // ── 9. Orchestrator (+ jobs, worker tools) ─────────────────────────────
  const orchestration = createOrchestratorLayer({
    config,
    channel: channelLayer.channel,
    destinationStore: channelLayer.destinationStore,
    channelFormatting: channelLayer.channelFormatting,
    sessionStore: coreStores.sessionStore,
    persistentApprovalStore: coreStores.persistentApprovalStore,
    jobApprovalStore: coreStores.jobApprovalStore,
    skillService: coreStores.skillService,
    jobStore: coreStores.jobStore,
    mainAgent: mainAgentLayer.mainAgent,
    tokenBroker: mainAgentLayer.tokenBroker,
    sandboxRunner: sandbox.sandboxRunner,
    hostfsBroker: hostfs.hostfsBroker,
  });

  // ── 10. MCP sidecar (after orchestrator) ───────────────────────────────
  const mcpSidecar = await createMcpSidecarLayer({
    config,
    controllerControlDir: foundation.controllerControlDir,
    workerNetworkName: mcpInfra.workerNetworkName,
    orchestrator: orchestration.orchestrator,
    hostMcpRegistry: mcpInfra.hostMcpRegistry,
    proxyAccess: httpProxy.proxyAccess,
  });

  // ── Start services ────────────────────────────────────────────────────
  sandbox.sandboxRunner.start();

  // ── Assemble composite shutdown (reverse order of startup) ─────────────
  // Note: selfUpdate is constructed after the shutdown function because it
  // needs the shutdown callback, but its stop() should still run during teardown.
  // We'll add it to the layers array after construction.
  const layers: Array<{ readonly name: string; stop: () => Promise<void> }> = [
    foundation,
    channelLayer,
    coreStores,
    mainAgentLayer,
    httpProxy,
    hostfs,
    mcpInfra,
    sandbox,
    orchestration,
    mcpSidecar,
  ];

  let shutdownRequested = false;

  const shutdown = async (): Promise<void> => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    logger.info("app.shutdown_started");
    for (const layer of [...layers].reverse()) {
      logger.info("app.shutdown_step_started", { step: layer.name });
      await layer.stop();
      logger.info("app.shutdown_step_completed", { step: layer.name });
    }
    logger.info("app.shutdown_completed");
  };

  // Wire the channel's fatal error handler so it can trigger shutdown.
  channelLayer.setShutdown(shutdown);

  // ── 11. Self-update (needs shutdown callback) ──────────────────────────
  const selfUpdate = createSelfUpdateLayer({
    config,
    sessionStore: coreStores.sessionStore,
    channel: channelLayer.channel,
    shutdown,
  });
  layers.push(selfUpdate);
  selfUpdate.updateCoordinator.start();

  // ── Start remaining services ───────────────────────────────────────────
  await orchestration.jobScheduler.start();
  orchestration.jobCleanupService.start();

  process.once("SIGINT", () => {
    shutdownRequested = true;
    void shutdown().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    shutdownRequested = true;
    void shutdown().finally(() => process.exit(143));
  });

  await channelLayer.channel.start(async (event) => {
    await orchestration.orchestrator.handleChatEvent(event);
  });
  logger.info("app.started");
  await channelLayer.fatalErrorPromise;
}

export function buildMainAgentConfig(configDirectory: string, isMempalaceEnabled: boolean): ThreadStartParams["config"] {
  const mempalaceConfig = buildMempalaceMcpServerConfig(configDirectory, isMempalaceEnabled);
  if (!mempalaceConfig) {
    if (isMempalaceEnabled) {
      logger.warn("memory.mempalace_disabled_for_session", {
        reason: "mcp_config_unavailable",
      });
    }
    return {};
  }

  return {
    mcp_servers: {
      mempalace: mempalaceConfig,
    },
  };
}