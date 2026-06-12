import type { HostfsLayerResult } from "./types.js";
import { initializeHostfs, type HostfsServices } from "../hostfs/index.js";
import { createNoopHostfsBroker } from "../hostfs/hostfs-broker.js";
import { logger } from "../logger.js";

export async function createHostfsLayer(): Promise<HostfsLayerResult> {
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

  const hostfsBroker = hostfsServices?.broker ?? createNoopHostfsBroker();

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

  const stop = async (): Promise<void> => {
    if (hostfsServices) {
      await hostfsServices.webdavServer.stop();
    }
  };

  return {
    name: "hostfs",
    hostfsServices,
    hostfsBroker,
    createHostfsVolume,
    removeHostfsVolume,
    stop,
  };
}