import {WebDAVServer} from "./webdav-server.js";
import {BundleRegistry} from "./bundle-registry.js";
import {HostfsBroker} from "./hostfs-broker.js";
import {HostfsVolumeManager} from "./hostfs-volume-manager.js";
import {RclonePluginManager} from "./rclone-plugin-manager.js";
import {BundleNamespaceRegistry} from "./bundle-namespace-registry.js";

type HostfsConfig = {
  enabled: boolean;
  webdavHost: string;
  webdavDockerHost: string;
  volumePrefix?: string;
};

type HostfsServices = {
  webdavServer: WebDAVServer;
  webdavBaseUrl: string;
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
  const namespaceRegistry = new BundleNamespaceRegistry();

  const webdavServer = new WebDAVServer({
    port: 0,
    host: config.webdavHost,
    authenticate: (_username, password) => {
      return bundleRegistry.getBundleIdBySecret(password);
    },
    namespaceRegistry,
  });

  const webdavPort = await webdavServer.start();
  const webdavBaseUrl = buildWebDAVBaseUrl(config.webdavDockerHost, webdavPort);

  const broker = new HostfsBroker({
    bundleRegistry,
    namespaceRegistry,
    webdavBaseUrl,
  });

  const volumeManager = new HostfsVolumeManager({
    webdavBaseUrl,
    volumePrefix: config.volumePrefix,
  });

  const rclonePluginManager = new RclonePluginManager();

  await rclonePluginManager.ensureInstalled();

  return {
    webdavServer,
    webdavBaseUrl,
    bundleRegistry,
    broker,
    volumeManager,
    rclonePluginManager,
  };
}

function buildWebDAVBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}
