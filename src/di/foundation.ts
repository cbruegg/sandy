import { randomUUID } from "node:crypto";
import type { FoundationLayerResult } from "./types.js";
import { type SandyConfig } from "../config.js";
import { CODEX_API_KEY_ENV, ensureManagedCodexPath } from "../codex-client.js";
import { resolveSandyCacheRoot } from "../cache-paths.js";
import { configureLogger, logger } from "../logger.js";
import { validateOAuthStateFilesForStartup } from "../mcp/oauth-state-validator.js";
import { validateMatrixAuthStateForStartup } from "../matrix/startup-validator.js";
import { CodexAppServerClient } from "../codex-app-server-client/app-server-client.js";
import { WorkerImageManager } from "../worker-image-manager.js";
import { createControlDir, removeControlDir, startHeartbeat } from "../sandbox/heartbeat.js";

export type FoundationLayerInput = {
  readonly config: SandyConfig;
};

export async function createFoundationLayer(input: FoundationLayerInput): Promise<FoundationLayerResult> {
  const { config } = input;

  configureLogger({ minLevel: config.logLevel });

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

  const sandyCacheRoot = resolveSandyCacheRoot();

  const workerImageManager = new WorkerImageManager({
    baseImage: config.workerImage,
    preinstall: config.workerPreinstall,
    cacheRoot: sandyCacheRoot,
  });

  // Pre-resolve Codex binaries and the initial worker image concurrently.
  const [mainAgentCodexPath, workerCodexBinaryPath, initialWorkerImage] = await Promise.all([
    ensureManagedCodexPath(),
    ensureManagedCodexPath({ platform: "linux", arch: process.arch }),
    workerImageManager.start(),
  ]);

  const mainAgentAppServer = await CodexAppServerClient.createWithAmbientAuth({
    codexPath: mainAgentCodexPath,
    env: config.authMode.mode === "api_key"
      ? { [CODEX_API_KEY_ENV]: config.authMode.openAiApiKey }
      : undefined,
  });

  logger.info("worker_image.ready", {
    baseImage: config.workerImage,
    launchImage: initialWorkerImage,
  });

  const controllerControlDir = await createControlDir(sandyCacheRoot, `controller-${randomUUID()}`);
  const controllerHeartbeat = startHeartbeat(controllerControlDir);
  const stopControllerHeartbeat = async (): Promise<void> => {
    controllerHeartbeat.stop();
    await removeControlDir(controllerControlDir);
  };

  const stop = async (): Promise<void> => {
    await workerImageManager.stop();
  };

  return {
    name: "foundation",
    config,
    sandyCacheRoot,
    controllerControlDir,
    stopControllerHeartbeat,
    workerImageManager,
    mainAgentCodexPath,
    workerCodexBinaryPath,
    initialWorkerImage,
    mainAgentAppServer,
    stop,
  };
}