import {WebDAVServer} from "./webdav-server.js";
import {BundleRegistry} from "./bundle-registry.js";
import {HostfsBroker} from "./hostfs-broker.js";
import {HostfsVolumeManager} from "./hostfs-volume-manager.js";
import {RclonePluginManager} from "./rclone-plugin-manager.js";

type HostfsConfig = {
  enabled: boolean;
  webdavPort: number;
  webdavHost: string;
  webdavBaseUrl: string;
  volumePrefix?: string;
};

type HostfsServices = {
  webdavServer: WebDAVServer;
  bundleRegistry: BundleRegistry;
  broker: HostfsBroker;
  volumeManager: HostfsVolumeManager;
  rclonePluginManager: RclonePluginManager;
};

export async function initializeHostfs(config: HostfsConfig): Promise<HostfsServices | null> {
  if (!config.enabled) {
    return null;
  }

  const bundleRegistry = new BundleRegistry();

  const broker = new HostfsBroker({
    bundleRegistry,
    webdavServer: null as unknown as WebDAVServer,
    webdavBaseUrl: config.webdavBaseUrl,
  });

  const webdavServer = new WebDAVServer({
    port: config.webdavPort,
    host: config.webdavHost,
    authenticate: (_username, password) => {
      return bundleRegistry.getBundleIdBySecret(password);
    },
    getBundleNamespace: (bundleId) => {
      return broker.getBundleNamespace(bundleId);
    },
  });

  // Fix the circular reference by setting webdavServer on broker after creation
  (broker as unknown as Record<string, unknown>)["options"] = {
    bundleRegistry,
    webdavServer,
    webdavBaseUrl: config.webdavBaseUrl,
  };

  const volumeManager = new HostfsVolumeManager({
    webdavBaseUrl: config.webdavBaseUrl,
    volumePrefix: config.volumePrefix,
  });

  const rclonePluginManager = new RclonePluginManager();

  await webdavServer.start();
  await rclonePluginManager.ensureInstalled();

  return {
    webdavServer,
    bundleRegistry,
    broker,
    volumeManager,
    rclonePluginManager,
  };
}

export function buildWebDAVBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}
