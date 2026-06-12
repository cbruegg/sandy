import type { SandboxLayerInput, SandboxLayerResult } from "./types.js";
import { defaultCodexAuthFilePath } from "../config.js";
import { TaskBundleLauncherImpl, type TaskBundleLauncherOptions } from "../sandbox/task-bundle-launcher.js";
import { TaskBundlePoolImpl } from "../sandbox/task-bundle-pool.js";
import { DockerSandboxRunner, type DockerSandboxRunnerOptions } from "../sandbox/docker-sandbox-runner.js";

export function createSandboxLayer(input: SandboxLayerInput): SandboxLayerResult {
  const {
    config,
    workerImageManager,
    controllerControlDir,
    workerCodexBinaryPath,
    skillService,
    certificateAuthority,
    proxyAuthService,
    proxyAccess,
    createHostfsVolume,
    removeHostfsVolume,
    mcpWorkerLaunchConfigBuilder,
    workerNetworkName,
  } = input;

  const codexAuthFile = config.authMode.mode === "codex_auth_file"
    && config.authMode.codexAuthStrategy === "copy_file"
    ? defaultCodexAuthFilePath()
    : null;

  const httpTokensEnabled = Object.keys(config.httpTokens).length > 0;

  const taskBundleLauncherOptions: TaskBundleLauncherOptions = {
    workerImage: config.workerImage,
    resolveWorkerImage: () => workerImageManager.getLaunchImage(),
    shareRoot: config.shareRoot,
    controllerControlDir,
    codexAuthFile,
    getSkillsDirectory: () => skillService.getSkillsDirectory(),
    workerCodexBinaryPath,
    networkGuardImage: config.networkGuardImage,
    workerNetwork: config.workerNetwork,
    workerNetworkName,
    httpProxyCaCertPath: certificateAuthority?.certPath ?? null,
    httpProxyConfDirPath: certificateAuthority?.confDirPath ?? null,
    httpProxyImage: httpTokensEnabled ? config.httpProxyImage : null,
    resolveHttpProxyRequest: proxyAuthService
      ? (request) => proxyAuthService.resolveProxyRequest(request)
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
        const jwt = proxyAccess.issueWorkerGrant(taskId).bearerToken;
        const encodedJwt = encodeURIComponent(jwt);
        // The worker container shares the network namespace with the proxy
        // sidecar, so the proxy is reachable on localhost from the worker.
        return `http://Bearer:${encodedJwt}@127.0.0.1:8081`;
      }
      : undefined,
  };

  const taskBundleLauncher = new TaskBundleLauncherImpl(taskBundleLauncherOptions);
  const taskBundlePool = new TaskBundlePoolImpl(taskBundleLauncher);
  const sandboxRunner = new DockerSandboxRunner(sandboxRunnerOptions, taskBundlePool);

  const stop = async (): Promise<void> => {
    await sandboxRunner.shutdown?.();
  };

  return {
    name: "sandbox",
    sandboxRunner,
    stop,
  };
}